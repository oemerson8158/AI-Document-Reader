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

const WORKER_LENS_URL = "https://plain-band-2d43.oemerson8158.workers.dev/lens";

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
// Talking to the worker
///////////////////////////////////////////////////////////////////////////

async function requestLens(query) {
  const sentenceSpans = state.chunks.map(c => splitSentences(c.text));
  const sentences = state.chunks.map((c, i) =>
    sentenceSpans[i].map(sp => c.text.slice(sp.start, sp.end))
  );

  let response;
  try {
    response = await fetch(WORKER_LENS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, sentences })
    });
  } catch (err) {
    console.error("LENS: network error:", err);
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error("LENS: worker returned non-JSON:", err);
    return { ok: false, error: "The server sent back something unexpected. Try again." };
  }

  if (!response.ok || data.error) {
    console.error("LENS: worker error:", data.error || data);
    return {
      ok: false,
      error: typeof data.error === "string"
        ? data.error
        : "Couldn't create that lens right now. Try again in a moment."
    };
  }

  if (!Array.isArray(data.hits)) {
    console.error("LENS: invalid worker response shape:", data);
    return { ok: false, error: "The server sent back something unexpected. Try again." };
  }

  // The worker answers in [paragraph index, sentence index] pairs. Map
  // those back to character offsets with the same split used above.
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
    hits,
    incomplete: !!data.incomplete
  };
}

///////////////////////////////////////////////////////////////////////////
// Sidebar UI
///////////////////////////////////////////////////////////////////////////

let lensRequestInFlight = false;

function setLensStatus(message, kind) {
  const el = document.getElementById("lens-status");
  if (!el) return; // Lenses tab isn't currently open
  el.textContent = message || "";
  el.className = "lens-status" + (kind ? ` lens-status-${kind}` : "");
}

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

  document.getElementById("lens-submit").addEventListener("click", handleCreateLens);
  document.getElementById("lens-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleCreateLens();
  });

  renderLensList();
}

async function handleCreateLens() {
  if (lensRequestInFlight) return;

  const input = document.getElementById("lens-input");
  const colorInput = document.getElementById("lens-color");
  const submitBtn = document.getElementById("lens-submit");
  if (!input || !colorInput || !submitBtn) return;

  const query = input.value.trim();
  if (!query || state.chunks.length === 0) return;

  lensRequestInFlight = true;
  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = "Reading...";
  setLensStatus("Finding the passages that bear on this lens...");

  const result = await requestLens(query);

  lensRequestInFlight = false;
  submitBtn.disabled = false;
  submitBtn.textContent = originalLabel;

  if (!result.ok) {
    setLensStatus(result.error, "error");
    return;
  }

  const lens = {
    id: crypto.randomUUID(),
    query: result.query,
    color: colorInput.value,
    hits: result.hits
  };

  state.lenses.push(lens);
  state.activeLensId = lens.id; // show the new lens straight away
  state.lensCurrentHitId = null;
  input.value = "";

  renderDocument();
  renderLensList();

  let message;
  if (lens.hits.length === 0) {
    message = "No passages stood out for this lens. You can still select text in the document and add it yourself.";
  } else {
    message = `Found ${lens.hits.length} passage${lens.hits.length === 1 ? "" : "s"}. Click a highlighted sentence to see why it matched.`;
  }
  if (result.incomplete) {
    message += " Part of the document couldn't be checked, so delete this lens and create it again to cover everything.";
  }
  setLensStatus(message, result.incomplete ? "warn" : "");
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
      if (lens.id === state.activeLensId) renderDocument();
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