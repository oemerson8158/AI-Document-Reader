///////////////////////////////////////////////////////////////////////////
// worker-sections.js
//  Shared by the tools that read a whole document with the AI (provocations
//  and lenses).
//
//  The AI has a per-minute token limit, and the reading itself is most of
//  what each request carries, so a long reading can't go in one request.
//  Instead it's cut into sections, sent one at a time, and the app waits
//  out the limit between them. This file holds the parts that are the same
//  for every tool: cutting a reading into sections, and sending one section
//  (waiting and retrying if the AI says it's at its limit).
//
//  Oliver Emerson — 2025–2026
///////////////////////////////////////////////////////////////////////////

const WORKER_BASE_URL = "https://plain-band-2d43.oemerson8158.workers.dev";

const MAX_ATTEMPTS_PER_SECTION = 3;
const MAX_WAIT_SECONDS = 90; // longest single wait we'll sit through for the AI's limit

///////////////////////////////////////////////////////////////////////////
//  Function: splitIntoSections
//  Inputs: items — the document's chunks (each with a .text), maxChars —
//    roughly how much text one request can carry
//  Outputs: [{ startIndex, paragraphs: [text, ...], chars }]
//  Summary: Cuts the reading into as few, evenly-sized sections as the
//    per-request limit allows. Evenly sized, so a long reading doesn't end
//    with a tiny last section that still costs a full wait to process.
//    Paragraphs are never split across sections.
///////////////////////////////////////////////////////////////////////////
export function splitIntoSections(items, maxChars) {
  const total = items.reduce((n, item) => n + item.text.length, 0);
  const sectionCount = Math.max(1, Math.ceil(total / maxChars));
  const target = total / sectionCount;

  const sections = [];
  let current = null;

  items.forEach((item, index) => {
    const len = item.text.length;
    const startNew =
      !current ||
      (current.paragraphs.length > 0 &&
        (current.chars + len > maxChars ||
          (current.chars >= target && sections.length < sectionCount)));

    if (startNew) {
      current = { startIndex: index, paragraphs: [], chars: 0 };
      sections.push(current);
    }
    current.paragraphs.push(item.text);
    current.chars += len;
  });

  return sections;
}

// Counts down in the caller's status line. Returns false if the student
// stopped it.
async function waitWithCountdown(seconds, buildText, shouldStop, setStatus) {
  for (let remaining = Math.ceil(seconds); remaining > 0; remaining--) {
    if (shouldStop()) return false;
    setStatus(buildText(remaining));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return !shouldStop();
}

///////////////////////////////////////////////////////////////////////////
//  Function: requestWithRetry
//  Inputs:
//    path — worker route, e.g. "/lens"
//    body — the request body
//    label — what to call this section in status text ("Reading section 2 of 4...")
//    isStale() — true if a different document has been opened meanwhile
//    shouldStop() — true if the student pressed Stop (or isStale())
//    setStatus(text) — shows a status line while waiting
//    fallbackMessage — shown if the worker gives no message of its own
//  Outputs, one of:
//    { ok: true, data }        — the worker's JSON
//    { cancelled: true }       — stopped, or the document changed
//    { ok: false, tooLong }    — this section is too big to send at all
//    { ok: false, message }    — failed; message is fit to show the student
//  Summary: Sends one section. If the AI reports it's at its per-minute
//    limit, waits the time it asks for (with a countdown) and tries again.
///////////////////////////////////////////////////////////////////////////
export async function requestWithRetry({
  path,
  body,
  label,
  isStale,
  shouldStop,
  setStatus,
  fallbackMessage = "Couldn't reach the AI right now. Try again in a moment."
}) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_SECTION; attempt++) {
    if (shouldStop()) return { cancelled: true };

    let response;
    let data;
    try {
      response = await fetch(`${WORKER_BASE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      data = await response.json();
    } catch (err) {
      console.error(`${path}: network error:`, err);
      return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
    }

    // A different document was opened while this was in flight — throw the
    // result away rather than put it on the wrong document.
    if (isStale()) return { cancelled: true };

    if (response.ok && !data.error) return { ok: true, data };

    // Hitting the AI's per-minute limit is expected, and handled by waiting,
    // so it's logged quietly. Anything else is a real problem and gets the
    // full error treatment. (The browser still prints its own red line for
    // any non-200 response; that can't be turned off.)
    const wait = Number(data.retryAfterSeconds) || 60;
    const willWait =
      data.error === "rate_limited" &&
      attempt < MAX_ATTEMPTS_PER_SECTION &&
      wait <= MAX_WAIT_SECONDS;

    if (willWait) {
      console.info(`${path}: the AI is at its per-minute limit. Waiting ${wait}s, then retrying (attempt ${attempt} of ${MAX_ATTEMPTS_PER_SECTION}).`);

      const finished = await waitWithCountdown(
        wait + 1,
        secs => `${label} Waiting ${secs}s for the AI's per-minute limit to reset...`,
        shouldStop,
        setStatus
      );
      if (!finished) return { cancelled: true };
      continue;
    }

    // The AI occasionally gives an answer that can't be read (cut off, or
    // not in the expected format). That's random rather than a sign the
    // section is bad, so just ask again.
    if (data.error === "unreadable_response" && attempt < MAX_ATTEMPTS_PER_SECTION) {
      console.warn(`${path}: the AI's answer couldn't be read; trying this section again (attempt ${attempt} of ${MAX_ATTEMPTS_PER_SECTION}).`);
      setStatus(`${label} Retrying...`);
      continue;
    }

    console.error(`${path}: worker error:`, data.error || data);
    if (data.details) console.error(`${path}: details from worker:`, data.details);
    if (data.raw) console.error(`${path}: raw model output that failed to parse:`, data.raw);

    // One section that's too big for a single request (e.g. one enormous
    // paragraph) is skipped by the caller rather than failing the whole run.
    if (data.error === "too_long") return { ok: false, tooLong: true };

    return {
      ok: false,
      message: typeof data.message === "string" ? data.message : fallbackMessage
    };
  }

  return { ok: false, message: "The AI stayed busy. Wait a minute and try again." };
}