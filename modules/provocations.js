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

  let renderListRef = () => {};

  const provocationsApi = initProvocationsUI({
    getState: () => state,
    setProvocations: (provocations) => {
      state.provocations = provocations;
      renderDocument();              // so icons appear
      renderListRef(provocations);   // sidebar list
    },
    updateProvocation: (updated) => {
      const idx = state.provocations.findIndex(p => p.id === updated.id);
      if (idx !== -1) state.provocations[idx] = updated;
      renderListRef(state.provocations);
      renderDocument();              // for green highlight on incorrect
    }
  });

  renderListRef = provocationsApi.renderList;
}

  function initProvocationsUI({ getState, setProvocations, updateProvocation }) {
  const state = getState();

  const generateBtn = document.getElementById("prov-generate");
  const listEl = document.getElementById("prov-list");
  const detailEl = document.getElementById("prov-detail");

  generateBtn.addEventListener("click", async () => {
    const paragraphs = state.chunks.map(c => c.text);
    const purpose = state.purpose;

    generateBtn.disabled = true;
    const originalLabel = generateBtn.textContent;
    generateBtn.textContent = "Generating...";

    let data;
    try {
      const response = await fetch(`${WORKER_BASE_URL}/provocations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paragraphs, purpose, analysisType: state.analysisType })
      });

      data = await response.json();

      if (!response.ok || data.error) {
        console.error("PROVOCATIONS: worker error:", data.error || data);
        if (data.raw) {
          console.error("PROVOCATIONS: raw model output that failed to parse:", data.raw);
        }
        listEl.innerHTML = `<p style="color:#b00;">Couldn't generate provocations right now. Try again in a moment.</p>`;
        return;
      }
    } catch (err) {
      console.error("PROVOCATIONS: network error:", err);
      listEl.innerHTML = `<p style="color:#b00;">Couldn't reach the server. Check your connection and try again.</p>`;
      return;
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = originalLabel;
    }

    const provocations = data.provocations || [];

    setProvocations(provocations);   // setProvocations callback already re-renders the list
  });

  function renderList(provocations) {
    listEl.innerHTML = "";
    if (provocations.length > 0) {
      const status = document.createElement("p");
      status.className = "tool-hint";
      status.style.margin = "0";
      status.textContent = `${provocations.length} provocation${provocations.length === 1 ? "" : "s"} ready — click a 💡 icon in the document to begin.`;
      listEl.appendChild(status);
    }
  }

  function renderDetail(prov) {
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
        updateProvocation({ ...prov, includeInSummary: e.target.checked });
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
          feedbackEl.textContent = "Couldn't check that answer right now. Try again in a moment.";
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

      updateProvocation(updated);
      renderDetail(updated); // re-render: shows feedback, restores answer text, and adds the "include in summary" checkbox
    };
  }

  // Listen for icon clicks from app.js
  window.addEventListener("provocation:selected", (event) => {
    const provId = event.detail.provId;
    const prov = state.provocations.find(p => p.id === provId);
    if (prov) {
      renderDetail(prov);
    }
  });

  // Initial render if provocations already exist
  if (state.provocations.length > 0) {
    renderList(state.provocations);
  }

  return { renderList };
}

export { loadProvocationsUI };