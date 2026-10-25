///////////////////////////////////////////////////////////////////////////
// lens.js
//  Implements semantic, sentence-level lenses. A lens is a topic or question
//  the student wants to track through a document ("where does the author
//  rely on emotion?"). Creating one asks the worker which sentences engage
//  it, how strongly (strong or partial), and why. The student can then:
//    - see those sentences highlighted, with a light wash over each
//      matching paragraph,
//    - click a highlighted sentence to see why it matched, and dismiss it,
//    - select text and add it to the lens themselves,
//    - step through hits with Previous/Next and see where they sit on a thin
//      map beside the scrollbar.
//
//  A long reading is checked one section at a time (see worker-sections.js).
//  The lens appears after the first section and fills in as the rest
//  finish; Stop keeps what's been found, and "Check the rest" resumes.
//
//  Shape of a lens (saved with the document):
//    { id, query, color, incomplete?, resumeFrom?, hits: [ {
//        id, paragraphId, startOffset, endOffset,
//        strength: "strong" | "partial",
//        reason: string,
//        source: "ai" | "user"
//    } ] }
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

import { state, renderDocument, getCurrentSelections } from "../app.js";
import { splitIntoSections, requestWithRetry } from "./worker-sections.js";

// Roughly how much text goes to the AI per request. The worker rejects a
// section somewhat larger than this.
const LENS_SECTION_MAX_CHARS = 6500;

// Lens-building state lives at module level so a lens keeps being built, and
// the tab shows the right state, if the student switches tabs and back.
const lensRun = {
  running: false,
  cancelRequested: false,
  currentLensId: null, // the lens being filled in right now
  text: "",            // status line shown under the Create Lens row
  kind: "",            // "", "error", or "warn"
  forChunks: null      // which document that status belongs to
};

let resumeCooldownUntil = 0; // timestamp (ms) when "Check the rest" can be used again
let cooldownTimer = null;
let popupEl = null;          // the "why did this match?" popup, if open

///////////////////////////////////////////////////////////////////////////
// Shared helpers
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: getActiveLens
//  Inputs: None
//  Outputs: The lens currently applied to the reader, or null
///////////////////////////////////////////////////////////////////////////
function getActiveLens() {
  return state.lenses.find(l => l.id === state.activeLensId) || null;
}

///////////////////////////////////////////////////////////////////////////
//  Function: sortedHits
//  Inputs: lens
//  Outputs: A copy of the lens's hits in document order
///////////////////////////////////////////////////////////////////////////
function sortedHits(lens) {
  return [...lens.hits].sort(
    (a, b) => a.paragraphId - b.paragraphId || a.startOffset - b.startOffset
  );
}

///////////////////////////////////////////////////////////////////////////
//  Function: hexToRgba
//  Inputs: hex ("#rrggbb"), alpha (0-1)
//  Outputs: A CSS rgba() string; falls back to light blue for a bad hex
///////////////////////////////////////////////////////////////////////////
function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const n = m ? parseInt(m[1], 16) : 0xc0e7ff;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

///////////////////////////////////////////////////////////////////////////
//  Function: lensHitStyle
//  Inputs: color (hex), strength ("strong" | "partial")
//  Outputs: Inline CSS for a lens hit
//  Summary: Strong matches are solid; partial matches are a faded wash with
//    a dashed underline, so the two read differently even in a light color.
///////////////////////////////////////////////////////////////////////////
function lensHitStyle(color, strength) {
  if (strength === "strong") {
    return `background-color: ${hexToRgba(color, 1)};`;
  }
  return `background-color: ${hexToRgba(color, 0.4)}; border-bottom: 1px dashed rgba(0, 0, 0, 0.4);`;
}

///////////////////////////////////////////////////////////////////////////
//  Function: lensParagraphColor
//  Inputs: color (hex)
//  Outputs: The background color for a paragraph containing a hit
//  Summary: Deliberately lighter than the partial-match shade, so matching
//    sentences still stand out against it.
///////////////////////////////////////////////////////////////////////////
function lensParagraphColor(color) {
  return hexToRgba(color, 0.15);
}

///////////////////////////////////////////////////////////////////////////
// Sentence splitting
//  Done on the client, in one place, so the sentences sent to the worker and
//  the offsets used to highlight them always agree.
///////////////////////////////////////////////////////////////////////////

const sentenceSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("en", { granularity: "sentence" })
    : null;

// A span ending in a title/abbreviation or a lone initial ("Mr.", "J.")
// isn't really the end of a sentence.
const ABBREVIATION_END = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|Vol|No|Fig|Inc|Co|Ltd|cf|approx|ca|e\.g|i\.e)|\b[A-Z])\.$/;

///////////////////////////////////////////////////////////////////////////
//  Function: pushTrimmedSpan
//  Inputs: spans (array), text, start, end
//  Outputs: Pushes { start, end } onto spans with surrounding whitespace
//    trimmed; skips empty spans
///////////////////////////////////////////////////////////////////////////
function pushTrimmedSpan(spans, text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end > start) spans.push({ start, end });
}

///////////////////////////////////////////////////////////////////////////
//  Function: splitSentences
//  Inputs: text (a paragraph)
//  Outputs: [{ start, end }] — one span per sentence
//  Summary: Uses the browser's sentence segmenter when available, otherwise
//    a simple regex, then glues together breaks after abbreviations.
///////////////////////////////////////////////////////////////////////////
function splitSentences(text) {
  const spans = [];

  if (sentenceSegmenter) {
    for (const seg of sentenceSegmenter.segment(text)) {
      pushTrimmedSpan(spans, text, seg.index, seg.index + seg.segment.length);
    }
  } else {
    const re = /[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      pushTrimmedSpan(spans, text, m.index, m.index + m[0].length);
    }
  }

  return mergeAbbreviationBreaks(text, spans);
}

///////////////////////////////////////////////////////////////////////////
//  Function: mergeAbbreviationBreaks
//  Inputs: text, spans
//  Outputs: spans with any span ending in an abbreviation merged into the
//    one after it
///////////////////////////////////////////////////////////////////////////
function mergeAbbreviationBreaks(text, spans) {
  const merged = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && ABBREVIATION_END.test(text.slice(prev.start, prev.end))) {
      prev.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

///////////////////////////////////////////////////////////////////////////
//  Function: normalizeLens
//  Inputs: lens (as saved)
//  Outputs: A lens in the current shape
//  Summary: Lenses saved by an older, keyword-based version look like
//    { id, keywords, matches: [paragraphIds], color }. Each old match
//    becomes one whole-paragraph hit so older documents still open.
///////////////////////////////////////////////////////////////////////////
function normalizeLens(lens) {
  if (typeof lens.query === "string" && Array.isArray(lens.hits)) return lens;

  const query = Array.isArray(lens.keywords)
    ? lens.keywords.join(", ")
    : String(lens.keywords || "Lens");

  const hits = (lens.matches || [])
    .map(Number)
    .map(paragraphId => {
      const chunk = state.chunks.find(c => c.id === paragraphId);
      if (!chunk) return null;
      return {
        id: crypto.randomUUID(),
        paragraphId,
        startOffset: 0,
        endOffset: chunk.text.length,
        strength: "partial",
        reason: "Matched by keyword in an earlier version of this lens.",
        source: "ai"
      };
    })
    .filter(Boolean);

  return {
    id: lens.id || crypto.randomUUID(),
    query,
    color: lens.color || "#c0e7ff",
    hits
  };
}

///////////////////////////////////////////////////////////////////////////
// Status line and Create/Stop button
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: paintLensStatus
//  Inputs: None
//  Outputs: Draws lensRun.text in #lens-status (no-op if the tab is closed)
///////////////////////////////////////////////////////////////////////////
function paintLensStatus() {
  const el = document.getElementById("lens-status");
  if (!el) return;
  el.textContent = lensRun.text;
  el.className = "lens-status" + (lensRun.kind ? ` lens-status-${lensRun.kind}` : "");
}

///////////////////////////////////////////////////////////////////////////
//  Function: setLensStatus
//  Inputs: message (string), kind ("error" | "warn" | omitted)
//  Outputs: Stores the status line and redraws it
///////////////////////////////////////////////////////////////////////////
function setLensStatus(message, kind) {
  lensRun.text = message || "";
  lensRun.kind = kind || "";
  paintLensStatus();
}

///////////////////////////////////////////////////////////////////////////
//  Function: syncLensButton
//  Inputs: None
//  Outputs: Sets the button to "Create Lens", "Stop", or "Stopping..."
///////////////////////////////////////////////////////////////////////////
function syncLensButton() {
  const btn = document.getElementById("lens-submit");
  if (!btn) return;

  if (lensRun.running) {
    btn.textContent = lensRun.cancelRequested ? "Stopping..." : "Stop";
    btn.className = "btn-secondary";
    btn.disabled = lensRun.cancelRequested;
  } else {
    btn.textContent = "Create Lens";
    btn.className = "btn-primary";
    btn.disabled = false;
  }
}

///////////////////////////////////////////////////////////////////////////
// Creating and resuming a lens
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: requestLensSection
//  Inputs: { query, section, sentenceSpans, skipCorrection, label, ctx }
//  Outputs: { ok: true, query, hits } with hits as character offsets, or the
//    failure result from requestWithRetry
//  Summary: Asks the worker which sentences in one section engage the lens.
//    The worker answers in [paragraph, sentence] pairs, which are mapped
//    back to offsets using the same split that produced the sentences.
///////////////////////////////////////////////////////////////////////////
async function requestLensSection({ query, section, sentenceSpans, skipCorrection, label, ctx }) {
  const sentences = section.paragraphs.map((_, k) => {
    const idx = section.startIndex + k;
    const text = state.chunks[idx].text;
    return sentenceSpans[idx].map(sp => text.slice(sp.start, sp.end));
  });

  const result = await requestWithRetry({
    path: "/lens",
    body: { query, sentences, startIndex: section.startIndex, skipCorrection },
    label,
    ...ctx,
    setStatus: setLensStatus,
    fallbackMessage: "Couldn't check this part of the reading right now. Try again in a moment."
  });

  if (!result.ok) return result;

  const data = result.data;
  if (!Array.isArray(data.hits)) {
    console.error("LENS: invalid worker response shape:", data);
    return { ok: false, message: "The server sent back something unexpected. Try again." };
  }

  const hits = [];
  data.hits.forEach(h => {
    const chunk = state.chunks[h.p];
    const span = sentenceSpans[h.p]?.[h.s];
    if (!chunk || !span) return;

    hits.push({
      id: crypto.randomUUID(),
      paragraphId: chunk.id,
      startOffset: span.start,
      endOffset: span.end,
      strength: h.strength === "strong" ? "strong" : "partial",
      reason: typeof h.reason === "string" ? h.reason : "",
      source: "ai"
    });
  });

  return {
    ok: true,
    query: typeof data.query === "string" && data.query.trim() ? data.query.trim() : query,
    hits
  };
}

///////////////////////////////////////////////////////////////////////////
//  Function: initLensUI
//  Inputs: None
//  Outputs: Injects the Lenses tab UI into #tool-content
//  Summary: Called each time the tab is selected. The Create button turns
//    into "Stop" while a lens is being built.
///////////////////////////////////////////////////////////////////////////
function initLensUI() {
  const content = document.getElementById("tool-content");
  content.innerHTML = `
    <div class="lens-top-row">
      <input id="lens-input" class="lens-input" placeholder="Topic or question, e.g. emotion vs. evidence" />
      <input id="lens-color" type="color" value="#c0e7ff" class="lens-color-picker" />
      <button id="lens-submit" class="btn-primary">Create Lens</button>
    </div>
    <div id="lens-status" class="lens-status"></div>

    <h4 class="section-heading">Existing Lenses</h4>
    <div id="lens-list"></div>
  `;

  // A status message left over from a different document shouldn't show here.
  if (!lensRun.running && lensRun.forChunks !== state.chunks) {
    lensRun.text = "";
    lensRun.kind = "";
  }

  document.getElementById("lens-submit").addEventListener("click", () => {
    if (lensRun.running) {
      lensRun.cancelRequested = true;
      syncLensButton();
      return;
    }
    handleCreateLens();
  });

  document.getElementById("lens-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !lensRun.running) handleCreateLens();
  });

  syncLensButton();
  paintLensStatus();
  renderLensList();
}

///////////////////////////////////////////////////////////////////////////
// "Check the rest" cooldown
//  When a run gives up on the AI's per-minute limit, the worker says how
//  long until it frees up. The button stays disabled, with a countdown, for
//  that long, so pressing it can't just earn another rate-limit error.
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: cooldownSecondsLeft
//  Inputs: None
//  Outputs: Whole seconds until the button can be used again (0 if ready)
///////////////////////////////////////////////////////////////////////////
function cooldownSecondsLeft() {
  return Math.max(0, Math.ceil((resumeCooldownUntil - Date.now()) / 1000));
}

///////////////////////////////////////////////////////////////////////////
//  Function: applyResumeCooldown
//  Inputs: btn (a "Check the rest" button)
//  Outputs: Sets its disabled state and label from the cooldown
///////////////////////////////////////////////////////////////////////////
function applyResumeCooldown(btn) {
  const left = cooldownSecondsLeft();
  btn.disabled = left > 0;
  btn.textContent = left > 0 ? `Check the rest (wait ${left}s)` : "Check the rest";
}

///////////////////////////////////////////////////////////////////////////
//  Function: tickResumeCooldown
//  Inputs: None
//  Outputs: Updates every "Check the rest" button; stops the timer at zero
///////////////////////////////////////////////////////////////////////////
function tickResumeCooldown() {
  document.querySelectorAll(".lens-resume").forEach(applyResumeCooldown);
  if (cooldownSecondsLeft() === 0 && cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: startResumeCooldown
//  Inputs: seconds
//  Outputs: Starts (or extends) the cooldown and its ticking timer
///////////////////////////////////////////////////////////////////////////
function startResumeCooldown(seconds) {
  resumeCooldownUntil = Date.now() + Math.ceil(seconds) * 1000;
  if (!cooldownTimer) cooldownTimer = setInterval(tickResumeCooldown, 1000);
}

///////////////////////////////////////////////////////////////////////////
//  Function: handleCreateLens
//  Inputs: None
//  Outputs: Starts building a new lens from the sidebar inputs
///////////////////////////////////////////////////////////////////////////
async function handleCreateLens() {
  if (lensRun.running) return;

  const input = document.getElementById("lens-input");
  const colorInput = document.getElementById("lens-color");
  if (!input || !colorInput) return;

  const query = input.value.trim();
  if (!query || state.chunks.length === 0) return;

  await runLens({ lens: null, query, color: colorInput.value, from: 0 });
}

///////////////////////////////////////////////////////////////////////////
//  Function: resumeLens
//  Inputs: lens
//  Outputs: Continues a lens that stopped before every section was checked
//  Summary: Resumes from the paragraph saved in lens.resumeFrom. A lens
//    saved by an older version has none and is re-checked from the start
//    (hits already found are kept, not duplicated).
///////////////////////////////////////////////////////////////////////////
async function resumeLens(lens) {
  if (lensRun.running || state.chunks.length === 0) return;
  if (cooldownSecondsLeft() > 0) return;
  if (!state.lenses.includes(lens)) return;

  const from = Number.isInteger(lens.resumeFrom) ? lens.resumeFrom : 0;
  await runLens({ lens, query: lens.query, color: lens.color, from });
}

///////////////////////////////////////////////////////////////////////////
//  Function: runLens
//  Inputs: { lens, query, color, from } — lens is null to build a new lens
//    (created once the first section comes back) or an existing lens to add
//    to; from is the paragraph to start checking at
//  Outputs: Adds hits to the lens as each section finishes and reports the
//    outcome in the status line
//  Summary: Checks the reading one section at a time. Only a run that checks
//    every section marks the lens complete.
///////////////////////////////////////////////////////////////////////////
async function runLens({ lens: existingLens, query, color, from }) {
  const startedWith = state.chunks;
  const total = startedWith.length;
  const sentenceSpans = startedWith.map(c => splitSentences(c.text));
  const sections = splitIntoSections(startedWith.slice(from), LENS_SECTION_MAX_CHARS)
    .map(section => ({ ...section, startIndex: section.startIndex + from }));

  if (sections.length === 0) {
    setLensStatus("There's nothing left to check for this lens.");
    return;
  }

  let lens = existingLens;
  const isStale = () => state.chunks !== startedWith;
  const shouldStop = () =>
    lensRun.cancelRequested ||
    isStale() ||
    (lens !== null && !state.lenses.includes(lens)); // the student deleted it mid-run
  const ctx = { isStale, shouldStop };

  if (lens) {
    lens.incomplete = true;
    if (!Number.isInteger(lens.resumeFrom)) lens.resumeFrom = from;
  }

  lensRun.running = true;
  lensRun.cancelRequested = false;
  lensRun.currentLensId = lens ? lens.id : null;
  lensRun.forChunks = startedWith;
  syncLensButton();
  renderLensList();

  const noun = from > 0 ? "remaining section" : "section";
  // Where the next unchecked section begins (the end of the reading, if none).
  const nextStart = i => (sections[i + 1] ? sections[i + 1].startIndex : total);

  let lensQuery = query;
  let skipped = 0;
  let failure = null;
  let failureWait = null; // seconds the worker asked us to wait, if the failure was the rate limit
  let stopped = false;

  try {
    for (let i = 0; i < sections.length; i++) {
      if (shouldStop()) { stopped = true; break; }

      const label = sections.length > 1 ? `Reading ${noun} ${i + 1} of ${sections.length}...` : "Reading...";
      setLensStatus(
        sections.length > 1 && i === 0
          ? `${label} A long reading takes a few minutes because of the AI's per-minute limit.`
          : label
      );

      const result = await requestLensSection({
        query: lensQuery,
        section: sections[i],
        sentenceSpans,
        skipCorrection: lens !== null, // the lens name only needs its spelling fixed once
        label,
        ctx
      });

      if (result.cancelled) { stopped = true; break; }
      if (result.tooLong) {
        skipped++;
        if (lens) lens.resumeFrom = nextStart(i); // retrying would only fail again
        continue;
      }
      if (!result.ok) {
        failure = result.message;
        failureWait = result.retryAfterSeconds || null;
        break;
      }

      if (!lens) {
        lensQuery = result.query;
        lens = {
          id: crypto.randomUUID(),
          query: lensQuery,
          color,
          hits: [],
          incomplete: true
        };
        state.lenses.push(lens);
        state.activeLensId = lens.id; // show the new lens straight away
        state.lensCurrentHitId = null;
        lensRun.currentLensId = lens.id;
        const input = document.getElementById("lens-input");
        if (input) input.value = "";
      }

      // Skip sentences the lens already has (only possible when a lens saved
      // without resume information is re-checked from the start).
      const fresh = result.hits.filter(h => !lens.hits.some(e =>
        e.paragraphId === h.paragraphId &&
        e.startOffset === h.startOffset &&
        e.endOffset === h.endOffset
      ));
      lens.hits.push(...fresh);
      lens.resumeFrom = nextStart(i);
      renderDocument(); // show this section's hits right away
      renderLensList();
    }
  } finally {
    lensRun.running = false;
    lensRun.cancelRequested = false;
    lensRun.currentLensId = null;
  }

  if (lens && !stopped && !failure && skipped === 0) {
    lens.incomplete = false;
    delete lens.resumeFrom;
  }

  syncLensButton();

  // Keep "Check the rest" disabled for as long as the worker said the rate
  // limit would take to free up, plus a second of margin.
  if (failure && failureWait) startResumeCooldown(failureWait + 1);

  // Another document was opened, or the lens was deleted mid-run: nothing
  // to report.
  const lensDeleted = lens !== null && !state.lenses.includes(lens);
  if (isStale() || lensDeleted) {
    setLensStatus("");
    return;
  }

  renderLensList();

  const n = lens ? lens.hits.length : 0;
  const passages = `${n} passage${n === 1 ? "" : "s"}`;
  const through = lens ? Math.min(Number.isInteger(lens.resumeFrom) ? lens.resumeFrom : total, total) : 0;
  const covered = `The lens covers the first ${through} of ${total} paragraphs (${passages} found).`;
  const resumeHint = lens && lens.incomplete && through < total
    ? ' Use "Check the rest" on the lens to continue.'
    : "";
  const note = skipped > 0
    ? ` ${skipped} section${skipped === 1 ? " was" : "s were"} too large to read and skipped.`
    : "";

  if (failure && !lens) {
    setLensStatus(failure, "error");
  } else if (failure) {
    setLensStatus(`${failure} ${covered}${note}${resumeHint}`, "warn");
  } else if (stopped) {
    setLensStatus(lens ? `Stopped. ${covered}${note}${resumeHint}` : "Stopped.", "warn");
  } else if (!lens) {
    setLensStatus("None of the reading could be checked against this lens.", "error");
  } else if (n === 0) {
    setLensStatus(`No passages stood out for this lens. You can still select text in the document and add it yourself.${note}`, note ? "warn" : "");
  } else {
    setLensStatus(`Found ${passages}. Click a highlighted sentence to see why it matched.${note}`, note ? "warn" : "");
  }
}

///////////////////////////////////////////////////////////////////////////
// Lens list
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: renderLensList
//  Inputs: None
//  Outputs: Redraws #lens-list: each lens with its color picker, Apply and
//    Delete buttons, partial-coverage note, and, for the applied lens, the
//    navigation panel and legend (no-op if the tab is closed)
///////////////////////////////////////////////////////////////////////////
function renderLensList() {
  const list = document.getElementById("lens-list");
  if (!list) return;

  list.innerHTML = "";

  if (state.lenses.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tool-hint";
    empty.textContent = "No lenses yet. Create one above to start reading through it.";
    list.appendChild(empty);
    return;
  }

  state.lenses.forEach(lens => {
    const active = lens.id === state.activeLensId;

    const item = document.createElement("div");
    item.className = "lens-item" + (active ? " lens-item-active" : "");

    // ---- Main row: label, color, Apply, Delete ----
    const main = document.createElement("div");
    main.className = "lens-item-main";

    const label = document.createElement("span");
    label.className = "lens-label";
    label.textContent = lens.query;

    const count = document.createElement("span");
    count.className = "lens-count";
    count.textContent = lens.hits.length;
    count.title = `${lens.hits.length} passage${lens.hits.length === 1 ? "" : "s"}`;
    label.appendChild(count);

    const colorEl = document.createElement("input");
    colorEl.type = "color";
    colorEl.value = lens.color;
    colorEl.className = "lens-color-edit";
    colorEl.addEventListener("input", (e) => {
      lens.color = e.target.value;
      if (lens.id !== state.activeLensId) return;

      // Repaint in place: re-rendering the document (or this list, which
      // would replace the picker mid-drag) on every input event is slow and
      // resets the reader's scroll position.
      const byId = new Map(lens.hits.map(h => [h.id, h]));
      document.querySelectorAll("#document-pane .lens-hit").forEach(el => {
        const hit = byId.get(el.dataset.hitId);
        if (hit) el.style.cssText = lensHitStyle(lens.color, hit.strength);
      });

      // A paragraph showing the green "incorrect provocation" color keeps it.
      document.querySelectorAll("#document-pane p.lens-paragraph").forEach(pEl => {
        if (pEl.dataset.provIncorrect) return;
        pEl.style.backgroundColor = lensParagraphColor(lens.color);
      });

      const [strongSwatch, partialSwatch] = item.querySelectorAll(".lens-swatch");
      if (strongSwatch) strongSwatch.style.cssText = lensHitStyle(lens.color, "strong");
      if (partialSwatch) partialSwatch.style.cssText = lensHitStyle(lens.color, "partial");
      refreshLensMinimap();
    });

    const applyBtn = document.createElement("button");
    applyBtn.className = "lens-apply";
    applyBtn.textContent = active ? "Unapply" : "Apply";
    applyBtn.addEventListener("click", () => {
      state.activeLensId = active ? null : lens.id;
      state.lensCurrentHitId = null;
      closeLensPopup();
      renderDocument();
      renderLensList();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "lens-delete";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      state.lenses = state.lenses.filter(l => l.id !== lens.id);
      if (state.activeLensId === lens.id) {
        state.activeLensId = null;
        state.lensCurrentHitId = null;
      }
      closeLensPopup();
      renderDocument();
      renderLensList();
    });

    main.append(label, colorEl, applyBtn, deleteBtn);
    item.appendChild(main);

    // ---- Partial-coverage note and "Check the rest" ----
    if (lens.incomplete) {
      const note = document.createElement("div");
      note.className = "lens-note";
      note.textContent = lensRun.running && lensRun.currentLensId === lens.id
        ? "Still reading the rest of the document..."
        : "Only part of the reading was checked for this lens.";
      item.appendChild(note);

      // Not offered during a run, or when everything has been checked
      // (apart from sections too big to send).
      const canResume =
        !lensRun.running &&
        (!Number.isInteger(lens.resumeFrom) || lens.resumeFrom < state.chunks.length);
      if (canResume) {
        const resumeBtn = document.createElement("button");
        resumeBtn.className = "lens-resume";
        resumeBtn.textContent = "Check the rest";
        resumeBtn.title = "Continue checking the part of the reading this lens hasn't covered yet";
        resumeBtn.addEventListener("click", () => resumeLens(lens));
        applyResumeCooldown(resumeBtn);
        item.appendChild(resumeBtn);
      }
    }

    // ---- Navigation panel and legend, only for the applied lens ----
    if (active) {
      const hits = sortedHits(lens);
      const idx = hits.findIndex(h => h.id === state.lensCurrentHitId);

      const nav = document.createElement("div");
      nav.className = "lens-nav";

      const prevBtn = document.createElement("button");
      prevBtn.className = "lens-nav-btn";
      prevBtn.textContent = "◀";
      prevBtn.title = "Previous passage";
      prevBtn.disabled = hits.length === 0;
      prevBtn.addEventListener("click", () => stepHit(-1));

      const counter = document.createElement("span");
      counter.className = "lens-nav-count";
      counter.textContent = hits.length === 0
        ? "No passages"
        : `${idx >= 0 ? idx + 1 : "–"} of ${hits.length}`;

      const nextBtn = document.createElement("button");
      nextBtn.className = "lens-nav-btn";
      nextBtn.textContent = "▶";
      nextBtn.title = "Next passage";
      nextBtn.disabled = hits.length === 0;
      nextBtn.addEventListener("click", () => stepHit(1));

      const addBtn = document.createElement("button");
      addBtn.className = "lens-add-btn";
      addBtn.textContent = "+ Add selection";
      addBtn.title = "Select text in the document first, then click this to add it to the lens";
      addBtn.addEventListener("click", addSelectionToActiveLens);

      nav.append(prevBtn, counter, nextBtn, addBtn);
      item.appendChild(nav);

      const legend = document.createElement("div");
      legend.className = "lens-legend";

      const strongSwatch = document.createElement("span");
      strongSwatch.className = "lens-swatch";
      strongSwatch.style.cssText = lensHitStyle(lens.color, "strong");

      const partialSwatch = document.createElement("span");
      partialSwatch.className = "lens-swatch";
      partialSwatch.style.cssText = lensHitStyle(lens.color, "partial");

      legend.append(
        strongSwatch, " strong   ",
        partialSwatch, " partial   ·   Click a highlighted sentence to see why it matched."
      );
      item.appendChild(legend);
    }

    list.appendChild(item);
  });
}

///////////////////////////////////////////////////////////////////////////
// Navigation
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: goToHit
//  Inputs: hitId
//  Outputs: Makes that hit the current one: outlines it, scrolls it into
//    view, and updates the counter and minimap
///////////////////////////////////////////////////////////////////////////
function goToHit(hitId) {
  const pane = document.getElementById("document-pane");
  if (!pane) return;

  state.lensCurrentHitId = hitId;

  pane.querySelectorAll(".lens-hit-current").forEach(el => el.classList.remove("lens-hit-current"));
  const els = pane.querySelectorAll(`[data-hit-id="${hitId}"]`);
  els.forEach(el => el.classList.add("lens-hit-current"));
  if (els[0]) els[0].scrollIntoView({ behavior: "smooth", block: "center" });

  renderLensList();
  refreshLensMinimap();
}

///////////////////////////////////////////////////////////////////////////
//  Function: stepHit
//  Inputs: direction (1 for next, -1 for previous)
//  Outputs: Moves to the next or previous hit of the applied lens,
//    wrapping around at either end
///////////////////////////////////////////////////////////////////////////
function stepHit(direction) {
  const lens = getActiveLens();
  if (!lens) return;

  const hits = sortedHits(lens);
  if (hits.length === 0) return;

  const idx = hits.findIndex(h => h.id === state.lensCurrentHitId);
  let next;
  if (idx === -1) {
    next = direction > 0 ? 0 : hits.length - 1;
  } else {
    next = (idx + direction + hits.length) % hits.length;
  }

  goToHit(hits[next].id);
}

///////////////////////////////////////////////////////////////////////////
//  Function: addSelectionToActiveLens
//  Inputs: None (reads the student's current selection)
//  Outputs: Adds each selected passage to the applied lens as a "strong"
//    user hit
//  Summary: The reader paints one hit per piece of text, so a hit overlapping
//    another could end up hidden (counted, but unreachable by navigation,
//    popup, or minimap). The student's selection therefore replaces any hit
//    it overlaps.
///////////////////////////////////////////////////////////////////////////
function addSelectionToActiveLens() {
  const lens = getActiveLens();
  if (!lens) return;

  const selections = getCurrentSelections();
  if (!selections || selections.length === 0) {
    setLensStatus("Select some text in the document first, then click Add selection.", "warn");
    return;
  }

  let added = 0;
  selections.forEach(sel => {
    if (sel.endOffset <= sel.startOffset) return;

    const duplicate = lens.hits.some(h =>
      h.paragraphId === sel.paragraphId &&
      h.startOffset === sel.startOffset &&
      h.endOffset === sel.endOffset
    );
    if (duplicate) return;

    const overlaps = h =>
      h.paragraphId === sel.paragraphId &&
      h.startOffset < sel.endOffset &&
      h.endOffset > sel.startOffset;
    if (lens.hits.some(h => h.id === state.lensCurrentHitId && overlaps(h))) {
      state.lensCurrentHitId = null;
    }
    lens.hits = lens.hits.filter(h => !overlaps(h));

    lens.hits.push({
      id: crypto.randomUUID(),
      paragraphId: sel.paragraphId,
      startOffset: sel.startOffset,
      endOffset: sel.endOffset,
      strength: "strong",
      reason: "",
      source: "user"
    });
    added++;
  });

  if (added === 0) {
    setLensStatus("That passage is already part of this lens.", "warn");
    return;
  }

  setLensStatus(`Added ${added} passage${added === 1 ? "" : "s"} to this lens.`);
  renderDocument();
  renderLensList();
}

///////////////////////////////////////////////////////////////////////////
// "Why did this match?" popup
//  Clicking a highlighted sentence shows the model's stated reason and lets
//  the student dismiss the hit if they disagree. Judging the AI's judgment
//  is the point, so it's deliberately one click away.
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: closeLensPopup
//  Inputs: None
//  Outputs: Removes the popup if open
///////////////////////////////////////////////////////////////////////////
function closeLensPopup() {
  if (popupEl) {
    popupEl.remove();
    popupEl = null;
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: openLensPopup
//  Inputs: lens, hit, x, y (click position in viewport coordinates)
//  Outputs: Shows the popup just below the click, kept on-screen
///////////////////////////////////////////////////////////////////////////
function openLensPopup(lens, hit, x, y) {
  closeLensPopup();

  const el = document.createElement("div");
  el.id = "lens-hit-popup";

  const badge = document.createElement("div");
  badge.className = "lens-popup-badge";
  badge.textContent = hit.source === "user"
    ? "Added by you"
    : hit.strength === "strong" ? "Strong match" : "Partial match";

  const lensName = document.createElement("div");
  lensName.className = "lens-popup-lens";
  lensName.textContent = `Lens: ${lens.query}`;

  const reason = document.createElement("div");
  reason.className = "lens-popup-reason";
  reason.textContent = hit.reason ||
    (hit.source === "user" ? "You marked this passage as relevant to this lens." : "No reason was given for this match.");

  const actions = document.createElement("div");
  actions.className = "lens-popup-actions";

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "lens-popup-dismiss";
  dismissBtn.textContent = "Not relevant";
  dismissBtn.addEventListener("click", () => {
    lens.hits = lens.hits.filter(h => h.id !== hit.id);
    if (state.lensCurrentHitId === hit.id) state.lensCurrentHitId = null;
    closeLensPopup();
    renderDocument();
    renderLensList();
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "lens-popup-close";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeLensPopup);

  actions.append(dismissBtn, closeBtn);
  el.append(badge, lensName, reason, actions);
  document.body.appendChild(el);
  popupEl = el;

  const width = el.offsetWidth;
  const height = el.offsetHeight;
  let left = Math.min(Math.max(8, x - 20), window.innerWidth - width - 8);
  let top = y + 16;
  if (top + height > window.innerHeight - 8) top = y - height - 12;
  top = Math.max(8, top);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

///////////////////////////////////////////////////////////////////////////
//  Function: handleDocumentPaneClick
//  Inputs: e (click event)
//  Outputs: Opens the popup for the clicked lens hit
//  Summary: Registered once on #document-pane by app.js. Ignored while the
//    student is mid-selection (e.g. to highlight).
///////////////////////////////////////////////////////////////////////////
function handleDocumentPaneClick(e) {
  const hitEl = e.target instanceof Element ? e.target.closest(".lens-hit") : null;
  if (!hitEl) return;

  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;

  const lens = getActiveLens();
  if (!lens) return;

  const hit = lens.hits.find(h => h.id === hitEl.dataset.hitId);
  if (!hit) return;

  openLensPopup(lens, hit, e.clientX, e.clientY);
}

document.addEventListener("click", (e) => {
  if (!popupEl) return;
  const target = e.target instanceof Element ? e.target : null;
  if (target && (popupEl.contains(target) || target.closest(".lens-hit"))) return;
  closeLensPopup();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLensPopup();
});

///////////////////////////////////////////////////////////////////////////
// Minimap
//  A thin strip beside the document's scrollbar with a tick for every hit
//  of the applied lens, placed by where it sits in the whole document. It
//  shows how hits cluster (all in the intro? none in the conclusion?) and
//  lets the student jump to any of them.
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: ensureMinimap
//  Inputs: None
//  Outputs: The #lens-minimap element, created beside #document-pane if it
//    doesn't exist yet (null if the pane is missing)
///////////////////////////////////////////////////////////////////////////
function ensureMinimap() {
  let el = document.getElementById("lens-minimap");
  if (el) return el;

  const pane = document.getElementById("document-pane");
  if (!pane) return null;

  el = document.createElement("div");
  el.id = "lens-minimap";
  el.title = "Where the applied lens appears in the document";
  pane.insertAdjacentElement("afterend", el);
  return el;
}

///////////////////////////////////////////////////////////////////////////
//  Function: refreshLensMinimap
//  Inputs: None
//  Outputs: Redraws the minimap ticks for the applied lens
//  Summary: Draws nothing if there's no lens or the reader screen is hidden.
///////////////////////////////////////////////////////////////////////////
function refreshLensMinimap() {
  const minimap = ensureMinimap();
  if (!minimap) return;

  minimap.innerHTML = "";

  const lens = getActiveLens();
  const pane = document.getElementById("document-pane");
  if (!lens || !pane || pane.clientHeight === 0 || pane.scrollHeight === 0) return;

  const paneTop = pane.getBoundingClientRect().top;
  const total = pane.scrollHeight;

  sortedHits(lens).forEach(hit => {
    const el = pane.querySelector(`[data-hit-id="${hit.id}"]`);
    if (!el) return;

    const y = el.getBoundingClientRect().top - paneTop + pane.scrollTop;

    const tick = document.createElement("div");
    tick.className = "lens-tick" + (hit.id === state.lensCurrentHitId ? " lens-tick-current" : "");
    tick.style.top = `${(y / total) * 100}%`;
    tick.style.cssText += lensHitStyle(lens.color, hit.strength);
    tick.title = hit.reason || "Passage you added";
    tick.addEventListener("click", () => goToHit(hit.id));
    minimap.appendChild(tick);
  });
}

window.addEventListener("resize", refreshLensMinimap);

export {
  initLensUI,
  normalizeLens,
  refreshLensMinimap,
  handleDocumentPaneClick,
  lensHitStyle,
  lensParagraphColor
};