///////////////////////////////////////////////////////////////////////////
// rephrase.js
//  This file implements the rephrasing tool for the AI Document Reader.
//  Its purpose is to simplify selected text to a user-chosen Lexile level
//  and optionally provide examples that clarify meaning. This helps
//  students understand complex passages without losing the original intent.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

function initRephraseUI({ getState, setResult }) {
  const submitBtn = document.getElementById("rephrase-submit");

  submitBtn.addEventListener("click", async () => {
    const state = getState();

    const lexile = document.getElementById("rephrase-lexile").value;
    const includeExample =
      document.getElementById("rephrase-include-example")?.checked || false;

    // Ensure paragraphs is ALWAYS an array
    const paragraphs = Array.isArray(state.rephrase?.paragraphs)
      ? state.rephrase.paragraphs
      : [];

    const result = await runRephrase({ paragraphs, lexile, includeExample });
    setResult(result);
  });
}

async function runRephrase({ paragraphs, lexile, includeExample }) {
  console.log("REPHRASE: Sending to Worker:", {
    paragraphs,
    lexile,
    includeExample
  });

  let response;
  try {
    response = await fetch(
      "https://plain-band-2d43.oemerson8158.workers.dev/rephrase",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paragraphs,
          lexile,
          includeExample
        })
      }
    );
  } catch (err) {
    console.error("REPHRASE: NETWORK ERROR — Worker unreachable:", err);
    return "";
  }

  console.log("REPHRASE: Worker status:", response.status);

  let rawText;
  try {
    rawText = await response.text();
    console.log("REPHRASE: RAW WORKER RESPONSE:", rawText);
  } catch (err) {
    console.error("REPHRASE: FAILED TO READ WORKER RESPONSE:", err);
    return "";
  }

  let data;
  try {
    data = JSON.parse(rawText);
    console.log("REPHRASE: PARSED JSON:", data);
  } catch (err) {
    console.error("REPHRASE: JSON PARSE ERROR — Worker returned non‑JSON:", err);
    return "";
  }

  // The worker writes a plain-English `message` for problems the student can
  // act on (selection too long, AI busy). Show it in the output box rather
  // than leaving it blank.
  if (data && typeof data.message === "string") {
    return data.message;
  }

  if (!data || typeof data.result !== "string") {
    console.error("REPHRASE: INVALID WORKER RESULT FORMAT:", data);
    return "";
  }

  console.log("REPHRASE: FINAL RESULT STRING:", data.result);

  return data.result;
}


export { initRephraseUI };