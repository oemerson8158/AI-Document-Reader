///////////////////////////////////////////////////////////////////////////
// provocations.js
//  Implements the provocation engine: generates questions about the
//  document that match the reading purpose (Analysis or Memorize), then
//  checks the student's answers and gives targeted feedback.
//
//  A long reading can't go to the AI in one request, so it is cut into
//  sections and sent one at a time (see worker-sections.js). Provocations
//  appear as each section finishes, and Stop keeps whatever is there.
//
//  Module-level state and listeners are set up once, when the module first
//  loads. Every DOM lookup happens at the moment it's needed and no-ops if
//  the element isn't on screen, so nothing breaks when another sidebar tab
//  is open.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

import { state, renderDocument } from "../app.js";
import { splitIntoSections, requestWithRetry } from "./worker-sections.js";

const WORKER_BASE_URL = "https://plain-band-2d43.oemerson8158.workers.dev";

// Roughly how much text goes to the AI per request. Anything up to this is
// one request; longer readings are split into evenly-sized sections.
const SECTION_MAX_CHARS = 14000;

// Generation state lives at module level so generation keeps going, and the
// tab shows the right state, if the student switches tabs and back.
const genState = {
  running: false,
  cancelRequested: false,
  text: "",        // status line shown under the button
  isError: false,
  forChunks: null  // which document that status belongs to
};

///////////////////////////////////////////////////////////////////////////
//  Function: escapeHtml
//  Inputs: str (string)
//  Outputs: The string with &, <, >, and " escaped
//  Summary: Makes the student's own typed text safe to put in innerHTML.
///////////////////////////////////////////////////////////////////////////
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

///////////////////////////////////////////////////////////////////////////
// Rendering and answer checking
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: updateProvocationState
//  Inputs: updated (a provocation object)
//  Outputs: Replaces the matching provocation in state and re-renders
//  Summary: Re-renders the sidebar list and the document (green highlight
//    on incorrect answers, icon updates).
///////////////////////////////////////////////////////////////////////////
function updateProvocationState(updated) {
  const idx = state.provocations.findIndex(p => p.id === updated.id);
  if (idx !== -1) state.provocations[idx] = updated;
  renderProvocationList();
  renderDocument();
}

///////////////////////////////////////////////////////////////////////////
//  Function: renderProvocationList
//  Inputs: None
//  Outputs: Shows the status line (progress, errors, or "N provocations
//    ready") in #prov-list
//  Summary: No-ops if the Provocations tab isn't open.
///////////////////////////////////////////////////////////////////////////
function renderProvocationList() {
  const listEl = document.getElementById("prov-list");
  if (!listEl) return;

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

///////////////////////////////////////////////////////////////////////////
//  Function: renderDetail
//  Inputs: prov (a provocation object)
//  Outputs: Fills #prov-detail with the question, answer box, feedback, and
//    the "include in summary" checkbox, and wires up Submit
//  Summary: Submitting sends the answer to /provocations/check. A failed
//    check leaves the question unanswered and shows the error instead of
//    recording a wrong answer. No-ops if the Provocations tab isn't open.
///////////////////////////////////////////////////////////////////////////
function renderDetail(prov) {
  const detailEl = document.getElementById("prov-detail");
  if (!detailEl) return;

  const alreadyAnswered = prov.status === "correct" || prov.status === "incorrect";

  detailEl.innerHTML = `
    <div class="prov-card">
      <p class="prov-question"><strong>Question:</strong> ${escapeHtml(prov.question)}</p>
      <textarea id="prov-answer" rows="3">${prov.answer ? escapeHtml(prov.answer) : ""}</textarea>
      <div class="submit-row" style="justify-content: flex-start;">
        <button id="prov-submit" class="btn-primary">${alreadyAnswered ? "Submit new answer" : "Submit Answer"}</button>
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
    feedbackEl.style.color = "";
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
    renderDetail(updated); // shows the feedback, restores the answer text, adds the checkbox
  };
}

// Fired by app.js when a 💡 icon is clicked.
window.addEventListener("provocation:selected", (event) => {
  const prov = state.provocations.find(p => p.id === event.detail.provId);
  if (prov) renderDetail(prov);
});

///////////////////////////////////////////////////////////////////////////
// Generating provocations
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: setGenStatus
//  Inputs: text (string), isError (boolean)
//  Outputs: Stores the status line and redraws it
///////////////////////////////////////////////////////////////////////////
function setGenStatus(text, isError = false) {
  genState.text = text;
  genState.isError = isError;
  renderProvocationList();
}

///////////////////////////////////////////////////////////////////////////
//  Function: syncGenerateButton
//  Inputs: None
//  Outputs: Sets the button to "Generate Provocations", "Stop", or
//    "Stopping..." to match genState
///////////////////////////////////////////////////////////////////////////
function syncGenerateButton() {
  const btn = document.getElementById("prov-generate");
  if (!btn) return;

  if (genState.running) {
    btn.textContent = genState.cancelRequested ? "Stopping..." : "Stop";
    btn.className = "btn-secondary";
    btn.disabled = genState.cancelRequested;
  } else {
    btn.textContent = "Generate Provocations";
    btn.className = "btn-primary";
    btn.disabled = false;
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: requestSection
//  Inputs: section (from splitIntoSections), label (status text), ctx
//    ({ isStale, shouldStop })
//  Outputs: { ok: true, provocations } or the failure result from
//    requestWithRetry (cancelled, tooLong, or message)
//  Summary: Asks the worker for one section's provocations, waiting and
//    retrying if the AI is at its per-minute limit.
///////////////////////////////////////////////////////////////////////////
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

  if (!result.ok) return result;

  const provocations = (result.data.provocations || []).map(p => ({
    ...p,
    // The worker answers with positions in the reading; store the
    // paragraph's own id.
    paragraphId: state.chunks[p.paragraphId]?.id ?? p.paragraphId
  }));
  return { ok: true, provocations };
}

///////////////////////////////////////////////////////////////////////////
//  Function: generateProvocations
//  Inputs: None
//  Outputs: Replaces state.provocations with newly generated ones and
//    reports the outcome in the status line
//  Summary: Sends the reading one section at a time. A run that finishes
//    replaces the old provocations; a stopped or failed run keeps what it
//    had collected. Asks for confirmation first if the student has answers
//    that would be replaced.
///////////////////////////////////////////////////////////////////////////
async function generateProvocations() {
  const startedWith = state.chunks;
  const isStale = () => state.chunks !== startedWith;
  const shouldStop = () => genState.cancelRequested || isStale();

  const sections = splitIntoSections(startedWith, SECTION_MAX_CHARS);
  if (sections.length === 0) return;

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

    // A clean run replaces the old provocations even if it found none.
    if (!stopped && !failure) {
      state.provocations = [...collected];
      renderDocument();
    }
  } finally {
    genState.running = false;
    genState.cancelRequested = false;
  }

  syncGenerateButton();

  // Another document was opened meanwhile: don't report on it.
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
//  Summary: Called each time the tab is selected. Only sets up the Generate
//    button; the state and rendering logic above is module-level, so a
//    generation already in progress is reflected when the tab reopens.
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
      <button id="prov-generate" class="btn-primary">Generate Provocations</button>
      <div id="prov-list"></div>
      <div id="prov-detail" style="margin-top: 16px;"></div>
    </div>
  `;

  document.getElementById("prov-generate").addEventListener("click", () => {
    if (genState.running) {
      genState.cancelRequested = true;
      syncGenerateButton();
      return;
    }
    generateProvocations();
  });

  syncGenerateButton();
  renderProvocationList();
}

export { loadProvocationsUI };