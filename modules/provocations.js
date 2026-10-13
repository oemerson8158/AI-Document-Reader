///////////////////////////////////////////////////////////////////////////
// provocations.js
//  This file implements the provocation engine for the AI Document Reader.
//  Its purpose is to generate thoughtful questions for students based on
//  the document they are reading, aligned with either Analysis or Memorize
//  mode. It also evaluates student responses and provides targeted feedback
//  to guide deeper understanding.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

import { state, renderDocument } from "../app.js";
import { splitIntoSections, requestWithRetry } from "./worker-sections.js";

const WORKER_BASE_URL = "https://plain-band-2d43.oemerson8158.workers.dev";

// Used when re-injecting the student's own previously-typed answer back into
// innerHTML (e.g. a stray "</textarea>" or "&" in their answer would
// otherwise break the markup).
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

///////////////////////////////////////////////////////////////////////////
// Module-level state + rendering
//
// Everything below is registered/defined ONCE, when this module first
// loads (ES modules only evaluate once, no matter how many times a
// function inside them is called) — not re-created every time the
// Provocations tab is opened. Every DOM element it touches is looked up
// fresh, at the moment it's needed, and every function no-ops gracefully
// if that element isn't currently in the document (e.g. the user is on a
// different sidebar tab). This avoids two related bugs the previous
// version had: (1) a new "provocation:selected" listener was registered
// on every tab visit and never removed, so old listeners piled up
// referencing DOM nodes from a previous tab visit that had since been
// wiped out; (2) clicking a 💡 icon while a different tab (e.g.
// Annotations) was open crashed, since #prov-detail didn't exist yet.
///////////////////////////////////////////////////////////////////////////

function updateProvocationState(updated) {
  const idx = state.provocations.findIndex(p => p.id === updated.id);
  if (idx !== -1) state.provocations[idx] = updated;
  renderProvocationList();
  renderDocument(); // for green highlight on incorrect / icon updates
}

function renderProvocationList() {
  const listEl = document.getElementById("prov-list");
  if (!listEl) return; // Provocations tab isn't currently open

  // A status message left over from a different document shouldn't show here.
  if (!genState.running && genState.forChunks !== state.chunks) {
    genState.text = "";
    genState.isError = false;
  }

  listEl.innerHTML = "";

  let message = genState.text;
  if (!message && state.provocations.length > 0) {
    const n = state.provocations.length;
    message = `${n} provocation${n === 1 ? "" : "s"} ready — click a 💡 icon in the document to begin.`;
  }

  if (message) {
    const status = document.createElement("p");
    status.className = "tool-hint";
    status.style.margin = "0";
    if (genState.isError) status.style.color = "#b00";
    status.textContent = message;
    listEl.appendChild(status);
  }
}

function renderDetail(prov) {
  const detailEl = document.getElementById("prov-detail");
  if (!detailEl) return; // Provocations tab isn't currently open

  const alreadyAnswered = prov.status === "correct" || prov.status === "incorrect";

  detailEl.innerHTML = `
    <div class="prov-card">
      <p class="prov-question"><strong>Question:</strong> ${prov.question}</p>
      <textarea id="prov-answer" rows="3">${prov.answer ? escapeHtml(prov.answer) : ""}</textarea>
      <div class="submit-row" style="justify-content: flex-start;">
        <button id="prov-submit" class="btn-primary">${alreadyAnswered ? "Submit new answer" : "Submit answer"}</button>
      </div>
      <div id="prov-feedback"></div>
      ${alreadyAnswered ? `
        <label class="prov-include-summary">
          <input type="checkbox" id="prov-include-summary" ${prov.includeInSummary !== false ? "checked" : ""}>
          Include this response in the annotations summary
        </label>
      ` : ""}
    </div>
  `;

  // If this provocation was already answered, show the prior result
  // instead of a blank feedback area.
  const feedbackEl = document.getElementById("prov-feedback");
  if (alreadyAnswered) {
    feedbackEl.className = prov.status;
    feedbackEl.textContent = prov.feedback || (prov.status === "correct" ? "✅ Nice—that matches the key idea." : "❌ Not quite. Re-read the highlighted section.");

    document.getElementById("prov-include-summary").addEventListener("change", (e) => {
      updateProvocationState({ ...prov, includeInSummary: e.target.checked });
    });
  }

  document.getElementById("prov-submit").onclick = async () => {
    const answer = document.getElementById("prov-answer").value.trim();
    if (!answer) return;

    const submitBtn = document.getElementById("prov-submit");
    const feedbackEl = document.getElementById("prov-feedback");

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = "Checking...";
    feedbackEl.className = "";
    feedbackEl.textContent = "";

    let data;
    try {
      const response = await fetch(`${WORKER_BASE_URL}/provocations/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paragraph: state.chunks.find(c => c.id === prov.paragraphId)?.text || "",
          purpose: state.purpose,
          question: prov.question,
          takeaway: prov.takeaway,
          answer
        })
      });

      data = await response.json();

      if (!response.ok || data.error) {
        console.error("PROVOCATIONS CHECK: worker error:", data.error || data);
        feedbackEl.textContent = typeof data.message === "string"
          ? data.message
          : "Couldn't check that answer right now. Try again in a moment.";
        feedbackEl.style.color = "#b00";
        return;
      }
    } catch (err) {
      console.error("PROVOCATIONS CHECK: network error:", err);
      feedbackEl.textContent = "Couldn't reach the server. Check your connection and try again.";
      feedbackEl.style.color = "#b00";
      return;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }

    const { correct, feedback } = data;

    const updated = {
      ...prov,
      status: correct ? "correct" : "incorrect",
      feedback,
      answer,
      includeInSummary: prov.includeInSummary !== undefined ? prov.includeInSummary : true
    };

    updateProvocationState(updated);
    renderDetail(updated); // re-render: shows feedback, restores answer text, and adds the "include in summary" checkbox
  };
}

// Registered exactly once, ever — this module is only evaluated once by
// the browser regardless of how many times loadProvocationsUI() below is
// called. If the Provocations tab isn't open when this fires, renderDetail
// simply no-ops instead of throwing.
window.addEventListener("provocation:selected", (event) => {
  const prov = state.provocations.find(p => p.id === event.detail.provId);
  if (prov) {
    renderDetail(prov);
  }
});

///////////////////////////////////////////////////////////////////////////
// Generating provocations
//
//  A long reading can't go to the AI in one request (see
//  worker-sections.js), so it's cut into sections, sent one at a time, and
//  the app waits out the AI's per-minute limit between them. Provocations
//  appear as each section finishes, and the student can press Stop at any
//  point and keep what's there. There's no limit on how many a reading
//  gets: a longer reading simply takes longer and yields more.
///////////////////////////////////////////////////////////////////////////

// Roughly how much text goes to the AI per request. Anything up to this is
// a single request; longer readings are split into evenly-sized sections.
const SECTION_MAX_CHARS = 14000;

// Lives at module level (not inside the tab's UI) so generation keeps going,
// and the tab shows the right state, if the student switches tabs and back.
const genState = {
  running: false,
  cancelRequested: false,
  text: "",        // status line shown under the button
  isError: false,
  forChunks: null  // which document that status belongs to
};

function setGenStatus(text, isError = false) {
  genState.text = text;
  genState.isError = isError;
  renderProvocationList();
}

function syncGenerateButton() {
  const btn = document.getElementById("prov-generate");
  if (!btn) return;

  if (genState.running) {
    btn.textContent = genState.cancelRequested ? "Stopping..." : "Stop";
    btn.className = "btn-secondary";
    btn.disabled = genState.cancelRequested;
  } else {
    btn.textContent = "Generate provocations";
    btn.className = "btn-primary";
    btn.disabled = false;
  }
}

// Ask the worker for one section's provocations (waiting and retrying if
// the AI is at its per-minute limit).
async function requestSection(section, label, ctx) {
  const result = await requestWithRetry({
    path: "/provocations",
    body: {
      paragraphs: section.paragraphs,
      startIndex: section.startIndex,
      purpose: state.purpose,
      analysisType: state.analysisType
    },
    label,
    ...ctx,
    setStatus: setGenStatus,
    fallbackMessage: "Couldn't generate provocations right now. Try again in a moment."
  });

  if (!result.ok) return result; // cancelled, too long, or failed

  const provocations = (result.data.provocations || []).map(p => ({
    ...p,
    // The worker answers with positions in the reading; store the
    // paragraph's own id.
    paragraphId: state.chunks[p.paragraphId]?.id ?? p.paragraphId
  }));
  return { ok: true, provocations };
}

async function generateProvocations() {
  const startedWith = state.chunks;
  const isStale = () => state.chunks !== startedWith;
  const shouldStop = () => genState.cancelRequested || isStale();

  const sections = splitIntoSections(startedWith, SECTION_MAX_CHARS);
  if (sections.length === 0) return;

  // Regenerating replaces the current provocations, answers included, so
  // check first — it can take a few minutes to get them back.
  const hasAnswers = state.provocations.some(p => p.status === "correct" || p.status === "incorrect");
  if (hasAnswers && !confirm("Generating new provocations replaces your current ones, including any answers you've written. Continue?")) {
    return;
  }

  genState.running = true;
  genState.cancelRequested = false;
  genState.forChunks = startedWith;
  syncGenerateButton();

  const collected = [];
  let skipped = 0;
  let failure = null;
  let stopped = false;

  try {
    for (let i = 0; i < sections.length; i++) {
      if (shouldStop()) { stopped = true; break; }

      const label = sections.length > 1 ? `Reading section ${i + 1} of ${sections.length}...` : "Reading...";
      setGenStatus(
        sections.length > 1 && i === 0
          ? `${label} A long reading takes a few minutes because of the AI's per-minute limit.`
          : label
      );

      const result = await requestSection(sections[i], label, { isStale, shouldStop });

      if (result.cancelled) { stopped = true; break; }
      if (result.tooLong) { skipped++; continue; }
      if (!result.ok) { failure = result.message; break; }

      collected.push(...result.provocations);
      state.provocations = [...collected];
      renderDocument(); // show this section's icons right away
    }

    // A run that finished cleanly replaces the old provocations even if it
    // found none; a stopped or failed run keeps whatever it had collected.
    if (!stopped && !failure) {
      state.provocations = [...collected];
      renderDocument();
    }
  } finally {
    genState.running = false;
    genState.cancelRequested = false;
  }

  syncGenerateButton();

  // If another document was opened meanwhile, don't report on it — just
  // clear the progress text rather than leave it behind.
  if (isStale()) {
    setGenStatus("");
    return;
  }

  const n = state.provocations.length;
  const plural = n === 1 ? "" : "s";
  const note = skipped > 0
    ? ` ${skipped} section${skipped === 1 ? " was" : "s were"} too large to read and skipped.`
    : "";

  if (failure) {
    const kept = collected.length > 0
      ? ` Kept the ${collected.length} provocation${collected.length === 1 ? "" : "s"} generated so far.`
      : "";
    setGenStatus(`${failure}${kept}${note}`, true);
  } else if (stopped) {
    setGenStatus(`Stopped. ${n} provocation${plural} ready so far — click a 💡 icon in the document to begin.`);
  } else if (n === 0) {
    setGenStatus(`Nothing in this reading stood out as worth a provocation.${note}`);
  } else if (note) {
    setGenStatus(`${n} provocation${plural} ready — click a 💡 icon in the document to begin.${note}`);
  } else {
    setGenStatus(""); // the default "N provocations ready" line is shown
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: loadProvocationsUI
//  Inputs: None
//  Outputs: Injects the Provocations tab UI into #tool-content
//  Summary: Called fresh each time the Provocations tab is selected. Only
//    sets up this-tab-visit-specific things (the Generate button); the
//    actual provocation state/rendering logic lives at module level above
//    so it isn't duplicated or re-registered on every visit.
///////////////////////////////////////////////////////////////////////////
function loadProvocationsUI() {
  const content = document.getElementById("tool-content");
  content.innerHTML = `
    <style>
      #tool-content, #tool-content * {
        box-sizing: border-box;
        max-width: 100%;
      }
      #tool-content p, #tool-content div {
        overflow-wrap: break-word;
        word-wrap: break-word;
      }
    </style>
    <div>
      <p class="tool-hint">Select a provocation icon in the text, or generate provocations for this document.</p>
      <button id="prov-generate" class="btn-primary">Generate provocations</button>
      <div id="prov-list"></div>
      <div id="prov-detail" style="margin-top: 16px;"></div>
    </div>
  `;

  // The button starts generation, and turns into "Stop" while it runs.
  document.getElementById("prov-generate").addEventListener("click", () => {
    if (genState.running) {
      genState.cancelRequested = true;
      syncGenerateButton();
      return;
    }
    generateProvocations();
  });

  // Reflect a generation that's already in progress (the student may have
  // switched tabs and come back), and any provocations that already exist.
  syncGenerateButton();
  renderProvocationList();
}

export { loadProvocationsUI };