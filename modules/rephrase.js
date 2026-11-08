///////////////////////////////////////////////////////////////////////////
// rephrase.js
//  Implements the rephrasing tool: rewrites the student's selected text at
//  a chosen Lexile level, optionally with an example, so complex passages
//  are easier to understand without losing their meaning.
//
//  Requests go through the shared queue in worker-sections.js, so they take
//  turns with lens and provocation requests instead of competing with them
//  for the AI's per-minute budget.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

import { requestWithRetry } from "./worker-sections.js";

///////////////////////////////////////////////////////////////////////////
//  Function: initRephraseUI
//  Inputs: { getState, setResult } — getState() returns the app state;
//    setResult(text) displays text in the output box
//  Outputs: Wires up the Rephrase button
//  Summary: On click, sends the selected paragraphs to the worker and shows
//    the result. The button is disabled while a request is running. Queue
//    and rate-limit waits are shown in the output box as they happen.
///////////////////////////////////////////////////////////////////////////
function initRephraseUI({ getState, setResult }) {
  const submitBtn = document.getElementById("rephrase-submit");

  submitBtn.addEventListener("click", async () => {
    const state = getState();

    const lexile = document.getElementById("rephrase-lexile").value;
    const includeExample =
      document.getElementById("rephrase-include-example")?.checked || false;

    const paragraphs = Array.isArray(state.rephrase?.paragraphs)
      ? state.rephrase.paragraphs
      : [];

    if (paragraphs.length === 0) {
      setResult("Select some text in the document first, then click Rephrase.");
      return;
    }

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = "Rephrasing...";

    // A different document was opened (or the reader closed) meanwhile.
    const startedWith = state.chunks;
    const isStale = () => getState().chunks !== startedWith;

    try {
      const result = await runRephrase({ paragraphs, lexile, includeExample, isStale, setStatus: setResult });
      if (result !== null) {
        setResult(result || "Couldn't rephrase that right now. Check your connection and try again.");
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: runRephrase
//  Inputs: { paragraphs, lexile, includeExample, isStale, setStatus }
//  Outputs: Promise<string | null> — the rephrased text, or a message for
//    the student; "" if the request failed without a message; null if the
//    document changed and there's nothing to show
//  Summary: Calls the worker's /rephrase route through the request queue.
//    The worker supplies a plain-English `message` for problems the student
//    can act on (selection too long, AI busy), which is returned in place of
//    a result.
///////////////////////////////////////////////////////////////////////////
async function runRephrase({ paragraphs, lexile, includeExample, isStale, setStatus }) {
  const result = await requestWithRetry({
    path: "/rephrase",
    body: { paragraphs, lexile, includeExample },
    label: "Rephrasing...",
    isStale,
    shouldStop: isStale,
    setStatus,
    fallbackMessage: "Couldn't rephrase that right now. Check your connection and try again."
  });

  if (result.cancelled) return null;
  if (!result.ok) return result.message || "";

  if (typeof result.data?.result !== "string") {
    console.error("REPHRASE: invalid worker result format:", result.data);
    return "";
  }

  return result.data.result;
}

export { initRephraseUI };