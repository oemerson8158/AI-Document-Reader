///////////////////////////////////////////////////////////////////////////
// lens.js — Semantic, sentence-level lenses
//
//  A lens is a topic or question the student wants to track through a
//  document ("where does the author rely on emotion?"). Creating one asks
//  the worker which sentences genuinely engage it, how strongly (strong or
//  partial), and why. The student then:
//    • sees those sentences highlighted in the reader (stronger matches
//      are shaded more solidly),
//    • clicks any highlighted sentence to see WHY it matched, and can
//      dismiss it if they disagree,
//    • selects text themselves and adds it, if the lens missed something,
//    • steps through the hits with Previous/Next, and sees where they sit
//      in the document on a thin map beside the scrollbar.
//
//  Shape of a lens (saved with the document):
//    { id, query, color, hits: [ {
//        id, paragraphId, startOffset, endOffset,   // one sentence (or a
//        strength: "strong" | "partial",            // student selection)
//        reason: string,
//        source: "ai" | "user"
//    } ] }
//
//  Oliver Emerson — 2025–2026
///////////////////////////////////////////////////////////////////////////

import { state, renderDocument, getCurrentSelections } from "../app.js";
import { splitIntoSections, requestWithRetry } from "./worker-sections.js";

///////////////////////////////////////////////////////////////////////////
// Shared helpers
///////////////////////////////////////////////////////////////////////////

function getActiveLens() {
  return state.lenses.find(l => l.id === state.activeLensId) || null;
}

function sortedHits(lens) {
  return [...lens.hits].sort(
    (a, b) => a.paragraphId - b.paragraphId || a.startOffset - b.startOffset
  );
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const n = m ? parseInt(m[1], 16) : 0xc0e7ff;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// How a lens hit is painted. Strong matches are solid; partial matches are
// a faded wash with a dashed underline, so the two read differently even
// when the student picks a very light color.
function lensHitStyle(color, strength) {
  if (strength === "strong") {
    return `background-color: ${hexToRgba(color, 1)};`;
  }
  return `background-color: ${hexToRgba(color, 0.4)}; border-bottom: 1px dashed rgba(0, 0, 0, 0.4);`;
}

///////////////////////////////////////////////////////////////////////////
// Sentence splitting
//  Done on the client, in this one place, so the sentences sent to the
//  worker and the offsets used to highlight them always agree. Uses the
//  browser's built-in sentence segmenter when available (it copes with
//  most abbreviations and quotes); falls back to a simple regex.
///////////////////////////////////////////////////////////////////////////

const sentenceSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("en", { granularity: "sentence" })
    : null;

function pushTrimmedSpan(spans, text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end > start) spans.push({ start, end });
}

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

// Sentence splitters treat the period in "Mr. Smith" or "J. K. Rowling" as
// the end of a sentence. If a span ends in a common title/abbreviation or a
// lone initial, glue it to the span after it.
const ABBREVIATION_END = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|Vol|No|Fig|Inc|Co|Ltd|cf|approx|ca|e\.g|i\.e)|\b[A-Z])\.$/;

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
// Upgrading older saved lenses
//  Lenses saved before this version were keyword-based:
//  { id, keywords, matches: [paragraphIds], color }. Convert those into
//  the new shape (one whole-paragraph hit per old match) so documents
//  saved earlier still open and display.
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
// Creating a lens
//
//  A long reading can't go to the AI in one request (see
//  worker-sections.js), so it's checked one section at a time, with the
//  app waiting out the AI's per-minute limit between sections. The lens
//  appears as soon as the first section is done, and its hits fill in as
//  the rest finish, so the student can start reading with it right away.
//  Stop keeps whatever has been found so far (the lens is then marked as
//  covering only part of the reading).
///////////////////////////////////////////////////////////////////////////

// Roughly how much text goes to the AI per request. (The worker turns away
// a section a good deal bigger than this.)
const LENS_SECTION_MAX_CHARS = 6500;

// Lives at module level (not inside the tab's UI) so a lens keeps being
// built, and the tab shows the right state, if the student switches tabs
// and back.
const lensRun = {
  running: false,
  cancelRequested: false,
  currentLensId: null, // the lens being filled in right now
  text: "",            // status line shown under the Create Lens row
  kind: "",            // "", "error", or "warn"
  forChunks: null      // which document that status belongs to
};

function paintLensStatus() {
  const el = document.getElementById("lens-status");
  if (!el) return; // Lenses tab isn't currently open
  el.textContent = lensRun.text;
  el.className = "lens-status" + (lensRun.kind ? ` lens-status-${lensRun.kind}` : "");
}

function setLensStatus(message, kind) {
  lensRun.text = message || "";
  lensRun.kind = kind || "";
  paintLensStatus();
}

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

// Ask the worker which sentences in one section engage the lens, and turn
// its answer into hits with character offsets.
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

  if (!result.ok) return result; // cancelled, too long, or failed

  const data = result.data;
  if (!Array.isArray(data.hits)) {
    console.error("LENS: invalid worker response shape:", data);
    return { ok: false, message: "The server sent back something unexpected. Try again." };
  }

  // The worker answers in [paragraph index, sentence index] pairs. Map
  // those back to character offsets with the same split used to send them.
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
// Sidebar UI
///////////////////////////////////////////////////////////////////////////

function initLensUI() {
  const content = document.getElementById("tool-content");
  content.innerHTML = `
    <p class="tool-hint">Describe a topic or ask a question. The lens finds the sentences that bear on it &mdash; you decide which ones really do.</p>
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

  // The button starts a lens, and turns into "Stop" while one is being built.
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
//  When a run gives up because the AI is at its per-minute limit, the worker
//  says how long until it frees up. The button stays disabled, with a
//  countdown, for exactly that long (it varies), so pressing it again can't
//  just earn another rate-limit error.
///////////////////////////////////////////////////////////////////////////

let resumeCooldownUntil = 0; // timestamp (ms) when the button can be used again
let cooldownTimer = null;

function cooldownSecondsLeft() {
  return Math.max(0, Math.ceil((resumeCooldownUntil - Date.now()) / 1000));
}

function applyResumeCooldown(btn) {
  const left = cooldownSecondsLeft();
  btn.disabled = left > 0;
  btn.textContent = left > 0 ? `Check the rest (wait ${left}s)` : "Check the rest";
}

function tickResumeCooldown() {
  document.querySelectorAll(".lens-resume").forEach(applyResumeCooldown);
  if (cooldownSecondsLeft() === 0 && cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}

function startResumeCooldown(seconds) {
  resumeCooldownUntil = Date.now() + Math.ceil(seconds) * 1000;
  if (!cooldownTimer) cooldownTimer = setInterval(tickResumeCooldown, 1000);
}

async function handleCreateLens() {
  if (lensRun.running) return;

  const input = document.getElementById("lens-input");
  const colorInput = document.getElementById("lens-color");
  if (!input || !colorInput) return;

  const query = input.value.trim();
  if (!query || state.chunks.length === 0) return;

  await runLens({ lens: null, query, color: colorInput.value, from: 0 });
}

// Continues a lens that stopped before every section was checked (Stop, an
// error, or the AI staying busy) from the paragraph where it left off.
// `resumeFrom` is saved with the lens; a lens saved by an older version has
// none, so it is re-checked from the start (hits already found are kept, not
// duplicated).
async function resumeLens(lens) {
  if (lensRun.running || state.chunks.length === 0) return;
  if (cooldownSecondsLeft() > 0) return; // still waiting out the AI's limit
  if (!state.lenses.includes(lens)) return;

  const from = Number.isInteger(lens.resumeFrom) ? lens.resumeFrom : 0;
  await runLens({ lens, query: lens.query, color: lens.color, from });
}

// Checks the reading, from paragraph `from` onward, one section at a time.
// With lens: null it builds a brand-new lens (created once the first section
// comes back); with an existing lens it adds to that one.
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
        skipCorrection: lens !== null, // the lens's name only needs its spelling fixed once
        label,
        ctx
      });

      if (result.cancelled) { stopped = true; break; }
      if (result.tooLong) {
        skipped++;
        if (lens) lens.resumeFrom = nextStart(i); // retrying it would only fail again
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
          incomplete: true // until every section has been checked
        };
        state.lenses.push(lens);
        state.activeLensId = lens.id; // show the new lens straight away
        state.lensCurrentHitId = null;
        lensRun.currentLensId = lens.id;
        const input = document.getElementById("lens-input");
        if (input) input.value = "";
      }

      // Skip any sentence the lens already has (only matters when a lens
      // saved without resume information is re-checked from the start).
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

  // Only a run that checked every section gets to call itself complete.
  if (lens && !stopped && !failure && skipped === 0) {
    lens.incomplete = false;
    delete lens.resumeFrom;
  }

  syncLensButton();

  // Gave up on the AI's rate limit: keep "Check the rest" disabled for as long
  // as the worker said it would take to free up (plus a second of margin).
  if (failure && failureWait) startResumeCooldown(failureWait + 1);

  // If another document was opened meanwhile, or the student deleted the
  // lens while it was being built, there's nothing to report — just clear
  // the progress text rather than leave it behind.
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

function renderLensList() {
  const list = document.getElementById("lens-list");
  if (!list) return; // Lenses tab isn't currently open

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

      // Repaint in place. Re-rendering the whole document (or this list,
      // which would replace the colour picker mid-drag) on every input
      // event is slow and resets the reader's scroll position.
      const byId = new Map(lens.hits.map(h => [h.id, h]));
      document.querySelectorAll("#document-pane .lens-hit").forEach(el => {
        const hit = byId.get(el.dataset.hitId);
        if (hit) el.style.cssText = lensHitStyle(lens.color, hit.strength);
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

    if (lens.incomplete) {
      const note = document.createElement("div");
      note.className = "lens-note";
      note.textContent = lensRun.running && lensRun.currentLensId === lens.id
        ? "Still reading the rest of the document..."
        : "Only part of the reading was checked for this lens.";
      item.appendChild(note);

      // Offer to continue unless a run is in progress, or there's nothing
      // left (everything was checked, apart from sections too big to send).
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

    // ---- Navigation panel, only for the applied lens ----
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
// Adding passages the lens missed
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

    // The reader paints one hit per piece of text, so a hit that overlapped
    // another could end up completely hidden (counted, but unreachable by
    // navigation, popup or minimap). The student's own selection replaces
    // whatever it overlaps.
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
//  Clicking a highlighted sentence in the reader shows the model's stated
//  reason and lets the student dismiss the hit if they disagree. Judging
//  the AI's judgment is the point, so this is deliberately one click away
//  rather than hidden.
///////////////////////////////////////////////////////////////////////////

let popupEl = null;

function closeLensPopup() {
  if (popupEl) {
    popupEl.remove();
    popupEl = null;
  }
}

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

  // Place it just below the click, kept on-screen.
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  let left = Math.min(Math.max(8, x - 20), window.innerWidth - width - 8);
  let top = y + 16;
  if (top + height > window.innerHeight - 8) top = y - height - 12;
  top = Math.max(8, top);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

// Registered once on #document-pane by app.js.
function handleDocumentPaneClick(e) {
  const hitEl = e.target instanceof Element ? e.target.closest(".lens-hit") : null;
  if (!hitEl) return;

  // Don't pop up while the student is mid-selection (e.g. to highlight).
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;

  const lens = getActiveLens();
  if (!lens) return;

  const hit = lens.hits.find(h => h.id === hitEl.dataset.hitId);
  if (!hit) return;

  openLensPopup(lens, hit, e.clientX, e.clientY);
}

// Close on outside click or Escape. Registered once, at module load.
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
//  of the applied lens, positioned by where it sits in the whole document.
//  Shows at a glance how hits cluster (all in the intro? absent from the
//  conclusion?) and lets the student jump to any of them.
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

function refreshLensMinimap() {
  const minimap = ensureMinimap();
  if (!minimap) return;

  minimap.innerHTML = "";

  const lens = getActiveLens();
  const pane = document.getElementById("document-pane");
  // Nothing to measure if there's no lens, or the reader screen is hidden.
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
  lensHitStyle
};