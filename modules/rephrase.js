///////////////////////////////////////////////////////////////////////////
// rephrase.js
//  Implements the rephrasing tool: rewrites the student's selected text at
//  a chosen Lexile level, optionally with an example, so complex passages
//  are easier to understand without losing their meaning.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

const WORKER_BASE_URL = "https://plain-band-2d43.oemerson8158.workers.dev";

///////////////////////////////////////////////////////////////////////////
//  Function: initRephraseUI
//  Inputs: { getState, setResult } — getState() returns the app state;
//    setResult(text) displays text in the output box
//  Outputs: Wires up the Rephrase button
//  Summary: On click, sends the selected paragraphs to the worker and shows
//    the result. The button is disabled while a request is running, since
//    rapid clicks would each spend part of the AI's shared per-minute budget.
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

    try {
      const result = await runRephrase({ paragraphs, lexile, includeExample });
      setResult(result || "Couldn't rephrase that right now. Check your connection and try again.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: runRephrase
//  Inputs: { paragraphs, lexile, includeExample }
//  Outputs: Promise<string> — the rephrased text, or a message for the
//    student; an empty string if the request failed
//  Summary: Calls the worker's /rephrase route. The worker supplies a plain-
//    English `message` for problems the student can act on (selection too
//    long, AI busy), which is returned in place of a result.
///////////////////////////////////////////////////////////////////////////
async function runRephrase({ paragraphs, lexile, includeExample }) {
  let data;
  try {
    const response = await fetch(`${WORKER_BASE_URL}/rephrase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paragraphs, lexile, includeExample })
    });
    data = await response.json();
  } catch (err) {
    console.error("REPHRASE: request failed or returned non-JSON:", err);
    return "";
  }

  if (data && typeof data.message === "string") return data.message;

  if (!data || typeof data.result !== "string") {
    console.error("REPHRASE: invalid worker result format:", data);
    return "";
  }

  return data.result;
}

export { initRephraseUI };