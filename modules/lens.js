console.log("LENS.JS LOADED");

///////////////////////////////////////////////////////////////////////////
// lens.js — Lens-based highlighting system (simplified literal matching)
// Oliver Emerson — 2025–2026
///////////////////////////////////////////////////////////////////////////

function initLensUI({ getState, addLens, updateLensColor, deleteLens, renderDocument }) {
  const content = document.getElementById("tool-content");

  content.innerHTML = `
    <div class="lens-top-row">
      <input id="lens-input" class="lens-input" placeholder="Enter keyword or phrase..." />
      <input id="lens-color" type="color" value="#c0e7ff" class="lens-color-picker" />
      <button id="lens-submit" class="btn-primary">Create Lens</button>
    </div>

    <h4 class="section-heading">Existing Lenses</h4>
    <div id="lens-list"></div>
  `;

  document.getElementById("lens-submit").addEventListener("click", async () => {
    const raw = document.getElementById("lens-input").value.trim();
    const color = document.getElementById("lens-color").value;

    if (!raw) return;

    const keywords = raw
      .split(",")
      .map(k => k.trim())
      .filter(k => k.length > 0);

    console.log("FRONTEND KEYWORDS:", keywords);

    const state = getState();
    const paragraphs = state.chunks.map(c => c.text);

    const { matches, corrections } = await runLens({ keywords, paragraphs });

    // Apply any spelling corrections to the label before saving the lens.
    // Worker lowercases keywords before correcting, so match on lowercase
    // but keep the corrected casing returned by the worker.
    const correctedKeywords = keywords.map(k => {
      const fix = corrections.find(c => c.original === k.toLowerCase());
      return fix ? fix.corrected : k;
    });

    addLens(correctedKeywords, matches, color);

    renderLensList(getState(), updateLensColor, deleteLens, renderDocument);
  });

  renderLensList(getState(), updateLensColor, deleteLens, renderDocument);
}

///////////////////////////////////////////////////////////////////////////
// Call the Worker (simplified — uses matches instead of scores)
///////////////////////////////////////////////////////////////////////////
async function runLens({ keywords, paragraphs }) {
  console.log("RUNLENS CALLED");
  console.log("RUNLENS KEYWORDS:", keywords);
  console.log("RUNLENS PARAGRAPH COUNT:", paragraphs.length);

  const url = "https://plain-band-2d43.oemerson8158.workers.dev/lens";

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords, paragraphs })
    });
  } catch (err) {
    console.error("NETWORK ERROR — FETCH NEVER REACHED WORKER:", err);
    return { matches: [], corrections: [] };
  }

  let rawText;
  try {
    rawText = await response.text();
  } catch (err) {
    console.error("FAILED TO READ WORKER RESPONSE:", err);
    return { matches: [], corrections: [] };
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    console.error("JSON PARSE ERROR — WORKER RETURNED NON‑JSON:", err);
    return { matches: [], corrections: [] };
  }

  if (!data || !Array.isArray(data.matches)) {
    console.error("INVALID WORKER RESPONSE FORMAT:", data);
    return { matches: [], corrections: [] };
  }

  const corrections = Array.isArray(data.corrections) ? data.corrections : [];

  corrections.forEach(c => {
    console.log(`LENS: corrected "${c.original}" → "${c.corrected}"`);
  });

  console.log("MATCHES:", data.matches);

  return { matches: data.matches, corrections };
}

///////////////////////////////////////////////////////////////////////////
// Render list of saved lenses
///////////////////////////////////////////////////////////////////////////
function renderLensList(state, updateLensColor, deleteLens, renderDocument) {
  const list = document.getElementById("lens-list");
  list.innerHTML = "";

  state.lenses.forEach(lens => {
    const div = document.createElement("div");
    div.className = "lens-item";

    const labelText = Array.isArray(lens.keywords)
      ? lens.keywords.join(", ")
      : lens.keywords;

    div.innerHTML = `
      <span class="lens-label">${labelText}</span>
      <input type="color" value="${lens.color}" class="lens-color-edit" />
      <button class="lens-apply">Apply</button>
      <button class="lens-delete">Delete</button>
    `;

    div.querySelector(".lens-color-edit").addEventListener("input", (e) => {
      updateLensColor(lens.id, e.target.value);
    });

    const applyBtn = div.querySelector(".lens-apply");

    function isActive() {
      if (lens.matches.length === 0) return false;
      return (
        state.lensMatches.length === lens.matches.length &&
        state.lensMatches.every(i => lens.matches.includes(i))
      );
    }

    applyBtn.textContent = isActive() ? "Unapply" : "Apply";

    applyBtn.addEventListener("click", () => {
      if (isActive()) {
        state.lensMatches = [];
      } else {
        state.lensMatches = lens.matches;
      }

      renderDocument();
      renderLensList(state, updateLensColor, deleteLens, renderDocument);

      applyBtn.textContent = isActive() ? "Unapply" : "Apply";
    });

    div.querySelector(".lens-delete").addEventListener("click", () => {
      deleteLens(lens.id);
    });

    list.appendChild(div);
  });
}

export { initLensUI, runLens };