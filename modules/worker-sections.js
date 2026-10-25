///////////////////////////////////////////////////////////////////////////
// worker-sections.js
//  Shared by the tools that send a whole reading to the AI (provocations
//  and lenses). The AI has a per-minute token limit, so a reading is cut
//  into sections and sent one request at a time, waiting out the limit
//  between them. This file provides the section splitter and a queued,
//  retrying request function.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

const WORKER_BASE_URL = "https://plain-band-2d43.oemerson8158.workers.dev";

const MAX_ATTEMPTS_PER_SECTION = 3;
const MAX_WAIT_SECONDS = 90;    // longest single wait for the rate limit that we'll sit through
const MAX_RATE_LIMIT_WAITS = 6; // rate-limit waits one section allows before giving up

///////////////////////////////////////////////////////////////////////////
//  Function: splitIntoSections
//  Inputs: items (the document's chunks, each with .text), maxChars (the
//    most text one request can carry)
//  Outputs: [{ startIndex, paragraphs: [text, ...], chars }]
//  Summary: Cuts the reading into as few, evenly-sized sections as the
//    limit allows, so a long reading doesn't end with a tiny last section
//    that still costs a full wait. Paragraphs are never split.
///////////////////////////////////////////////////////////////////////////
function splitIntoSections(items, maxChars) {
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

///////////////////////////////////////////////////////////////////////////
//  Function: waitWithCountdown
//  Inputs: seconds, buildText(remaining) -> status string, shouldStop(),
//    setStatus(text)
//  Outputs: Promise<boolean> — false if the student stopped the wait
//  Summary: Waits one second at a time, updating the status line each tick.
///////////////////////////////////////////////////////////////////////////
async function waitWithCountdown(seconds, buildText, shouldStop, setStatus) {
  for (let remaining = Math.ceil(seconds); remaining > 0; remaining--) {
    if (shouldStop()) return false;
    setStatus(buildText(remaining));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return !shouldStop();
}

///////////////////////////////////////////////////////////////////////////
//  Function: sendWithRetry
//  Inputs:
//    path — worker route, e.g. "/lens"
//    body — the request body
//    label — name for this section in status text ("Reading section 2 of 4...")
//    isStale() — true if a different document was opened meanwhile
//    shouldStop() — true if the student pressed Stop (or isStale())
//    setStatus(text) — shows a status line while waiting
//    fallbackMessage — shown if the worker gives no message of its own
//  Outputs, one of:
//    { ok: true, data }                            — the worker's JSON
//    { cancelled: true }                           — stopped, or the document changed
//    { ok: false, tooLong: true }                  — section too big to send at all
//    { ok: false, message, retryAfterSeconds? }    — failed; message is fit to show
//  Summary: Sends one section. If the AI reports its per-minute limit, waits
//    the time it asks for (with a countdown) and tries again.
///////////////////////////////////////////////////////////////////////////
async function sendWithRetry({
  path,
  body,
  label,
  isStale,
  shouldStop,
  setStatus,
  fallbackMessage = "Couldn't reach the AI right now. Try again in a moment."
}) {
  // Rate-limit waits are expected, so they're counted separately and don't
  // use up the section's attempts.
  let rateLimitWaits = 0;

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

    // A different document was opened while this was in flight.
    if (isStale()) return { cancelled: true };

    if (response.ok && !data.error) return { ok: true, data };

    const wait = Number(data.retryAfterSeconds) || 60;
    const willWait =
      data.error === "rate_limited" &&
      rateLimitWaits < MAX_RATE_LIMIT_WAITS &&
      wait <= MAX_WAIT_SECONDS;

    if (willWait) {
      console.info(`${path}: the AI is at its per-minute limit. Waiting ${wait}s, then retrying (wait ${rateLimitWaits + 1} of ${MAX_RATE_LIMIT_WAITS}).`);

      const finished = await waitWithCountdown(
        wait + 1,
        secs => `${label} Waiting ${secs}s for the AI's per-minute limit to reset...`,
        shouldStop,
        setStatus
      );
      if (!finished) return { cancelled: true };
      rateLimitWaits++;
      attempt--;
      continue;
    }

    // Unreadable answers are random rather than a sign the section is bad,
    // so just ask again.
    if (data.error === "unreadable_response" && attempt < MAX_ATTEMPTS_PER_SECTION) {
      console.warn(`${path}: the AI's answer couldn't be read; trying this section again (attempt ${attempt} of ${MAX_ATTEMPTS_PER_SECTION}).`);
      setStatus(`${label} Retrying...`);
      continue;
    }

    console.error(`${path}: worker error:`, data.error || data);
    if (data.details) console.error(`${path}: details from worker:`, data.details);
    if (data.raw) console.error(`${path}: raw model output that failed to parse:`, data.raw);

    // The caller skips a too-big section rather than failing the whole run.
    if (data.error === "too_long") return { ok: false, tooLong: true };

    return {
      ok: false,
      message: typeof data.message === "string" ? data.message : fallbackMessage,
      // Lets the caller hold off retrying for as long as the worker asked.
      retryAfterSeconds: data.error === "rate_limited" ? wait : undefined
    };
  }

  return { ok: false, message: "The AI stayed busy. Wait a minute and try again." };
}

///////////////////////////////////////////////////////////////////////////
// Request queue
//  Provocations and lenses share one per-minute AI budget, so running both
//  at once would make them rate-limit each other. Every request goes
//  through this queue and is sent only after the one before it finishes.
//  Stop (or opening another document) still works while a request waits.
///////////////////////////////////////////////////////////////////////////

let queueTail = Promise.resolve();
let activeRequests = 0; // running + waiting

///////////////////////////////////////////////////////////////////////////
//  Function: waitForTurn
//  Inputs: previous (promise for the request ahead), shouldStop()
//  Outputs: Promise<boolean> — true when it's this request's turn, false if
//    stopped while waiting
//  Summary: Resolves when the request ahead finishes, or earlier if stopped.
///////////////////////////////////////////////////////////////////////////
function waitForTurn(previous, shouldStop) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(value);
    };
    const poll = setInterval(() => { if (shouldStop()) finish(false); }, 500);
    previous.then(() => finish(true));
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: requestWithRetry
//  Inputs: options — same as sendWithRetry
//  Outputs: Same as sendWithRetry
//  Summary: Queues the request behind any others, then sends it. This is
//    the function the tools call.
///////////////////////////////////////////////////////////////////////////
async function requestWithRetry(options) {
  const previous = queueTail;
  let release;
  queueTail = new Promise(resolve => { release = resolve; });

  if (activeRequests > 0) {
    options.setStatus(`${options.label} Waiting for another AI task to finish...`);
  }
  activeRequests++;

  try {
    const myTurn = await waitForTurn(previous, options.shouldStop);
    if (!myTurn) return { cancelled: true };
    return await sendWithRetry(options);
  } finally {
    activeRequests--;
    // Release the next request only once the one ahead has finished, even
    // if this one gave up while still waiting.
    previous.then(release);
  }
}

export { splitIntoSections, requestWithRetry };