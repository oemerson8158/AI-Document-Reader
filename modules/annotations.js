///////////////////////////////////////////////////////////////////////////
// annotations.js
//  This file implements the annotation tools for the AI Document Reader.
//  Its purpose is to allow users to highlight text, create bookmarks,
//  and attach notes to specific passages. These tools support active
//  reading, organization, and long-term comprehension. It also lets the
//  user generate a summary of their own notes and provocation responses.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

import { state, renderDocument } from "../app.js";

const WORKER_BASE_URL = "https://plain-band-2d43.oemerson8158.workers.dev";

///////////////////////////////////////////////////////////////////////////
//  Function: addAnnotation
//  Inputs: type (string), extraData (object)
//  Outputs: Adds annotation to state.annotations
//  Summary: Stores highlight, bookmark, or note annotations.
///////////////////////////////////////////////////////////////////////////
function addAnnotation(type, sel, extra = {}) {
  state.annotations.push({
    id: crypto.randomUUID(),
    type,
    paragraphId: sel.paragraphId,
    startOffset: sel.startOffset,
    endOffset: sel.endOffset,
    ...extra
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: createBookmark
//  Inputs:
//    name (string) – The user‑provided label for the bookmark.
//    selection (object) – The current text selection containing:
//        • paragraphId (number) – Paragraph where the bookmark is anchored
//        • startOffset (number) – Start position of the selected text
//        • endOffset (number) – End position of the selected text
//  Outputs:
//    Creates a bookmark annotation object and stores it in state.annotations.
//    Returns the newly created bookmark object.
//  Error Checking:
//    Assumes `selection` is valid and contains paragraphId/startOffset/endOffset.
//    Assumes `state.annotations` is already initialized.
//  Summary:
//    Generates a bookmark annotation tied to a specific text range in the
//    document. Bookmarks allow the reader to quickly jump back to important
//    passages using the bookmark list in the sidebar.
///////////////////////////////////////////////////////////////////////////
function createBookmark(name, selection) {
  const bookmark = {
    id: crypto.randomUUID(),
    type: "bookmark",
    paragraphId: selection.paragraphId,
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
    name
  };

  state.annotations.push(bookmark);
  return bookmark;
}

///////////////////////////////////////////////////////////////////////////
//  Function: copyTextToClipboard
//  Inputs: text (string)
//  Outputs: Promise<boolean> — whether the copy worked
//  Summary: Uses the modern Clipboard API where the browser allows it (it
//    needs a secure page, i.e. https), and falls back to the older
//    select-and-copy approach otherwise (e.g. some iPad/Safari setups).
///////////////////////////////////////////////////////////////////////////
async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn("SUMMARIZE: Clipboard API failed, trying fallback:", err);
    }
  }

  const temp = document.createElement("textarea");
  temp.value = text;
  temp.setAttribute("readonly", "");
  temp.style.position = "fixed";
  temp.style.top = "0";
  temp.style.opacity = "0";
  document.body.appendChild(temp);
  temp.select();
  temp.setSelectionRange(0, text.length); // needed on iOS
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (err) {
    console.error("SUMMARIZE: fallback copy failed:", err);
  }
  temp.remove();
  return ok;
}

///////////////////////////////////////////////////////////////////////////
//  Function: renderSummary
//  Inputs: outputEl (the result container), text (the summary)
//  Outputs: Adds the summary card, with a Copy button, to outputEl
///////////////////////////////////////////////////////////////////////////
function renderSummary(outputEl, text) {
  const card = document.createElement("div");
  card.className = "summary-card";

  const actions = document.createElement("div");
  actions.className = "summary-actions";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "summary-copy";
  copyBtn.textContent = "Copy";
  copyBtn.title = "Copy the summary to your clipboard";

  let resetTimer = null;
  copyBtn.addEventListener("click", async () => {
    const ok = await copyTextToClipboard(text);
    copyBtn.textContent = ok ? "Copied!" : "Couldn't copy";
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  });

  actions.appendChild(copyBtn);

  const body = document.createElement("div");
  body.className = "summary-text";
  body.textContent = text;

  card.append(actions, body);
  outputEl.appendChild(card);
}

///////////////////////////////////////////////////////////////////////////
//  Function: loadAnnotationsUI
//  Inputs: None
//  Outputs: Injects the "Summarize Annotations" button and result panel
//    into #tool-content when the Annotations tab is active.
//  Summary: Gathers the user's notes and any provocation responses they've
//    marked for inclusion, sends them to the worker's /summarize endpoint,
//    and displays the resulting summary in the sidebar.
///////////////////////////////////////////////////////////////////////////
function loadAnnotationsUI() {
  const content = document.getElementById("tool-content");
  content.innerHTML = `
    <button id="summarize-btn" class="btn-primary">Summarize Annotations</button>
    <div id="summary-output" style="margin-top: 16px;"></div>
  `;

  const summarizeBtn = document.getElementById("summarize-btn");
  const outputEl = document.getElementById("summary-output");

  // Restore a previously-generated summary, if there is one, so switching
  // tabs and coming back doesn't lose it.
  if (state.annotationsSummary) {
    renderSummary(outputEl, state.annotationsSummary);
  }

  summarizeBtn.addEventListener("click", async () => {
    outputEl.innerHTML = "";

    const notes = state.annotations
      .filter(a => a.type === "note")
      .map(n => ({ paragraphId: n.paragraphId, noteText: n.noteText }));

    const provocationResponses = state.provocations
      .filter(p => (p.status === "correct" || p.status === "incorrect") && p.includeInSummary !== false)
      .map(p => ({
        paragraphId: p.paragraphId,
        question: p.question,
        answer: p.answer || "",
        correct: p.status === "correct"
      }));

    if (notes.length === 0 && provocationResponses.length === 0) {
      outputEl.innerHTML = `<p class="tool-hint" style="margin:0;">Add a note or answer a provocation question first, then come back to summarize them.</p>`;
      return;
    }

    const paragraphs = state.chunks.map(c => c.text);

    summarizeBtn.disabled = true;
    const originalLabel = summarizeBtn.textContent;
    summarizeBtn.textContent = "Summarizing...";

    let data;
    try {
      const response = await fetch(`${WORKER_BASE_URL}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paragraphs, notes, provocationResponses })
      });

      data = await response.json();

      if (!response.ok || data.error) {
        console.error("SUMMARIZE: worker error:", data.error || data);
        outputEl.innerHTML = "";
        const errorP = document.createElement("p");
        errorP.style.color = "#b00";
        errorP.textContent = typeof data.message === "string"
          ? data.message
          : "Couldn't generate a summary right now. Try again in a moment.";
        outputEl.appendChild(errorP);
        return;
      }
    } catch (err) {
      console.error("SUMMARIZE: network error:", err);
      outputEl.innerHTML = `<p style="color:#b00;">Couldn't reach the server. Check your connection and try again.</p>`;
      return;
    } finally {
      summarizeBtn.disabled = false;
      summarizeBtn.textContent = originalLabel;
    }

    state.annotationsSummary = data.summary;

    renderSummary(outputEl, data.summary);
  });
}

export { loadAnnotationsUI, addAnnotation, createBookmark };