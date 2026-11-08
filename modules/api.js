///////////////////////////////////////////////////////////////////////////
// api.js
//  The one place the app calls the AI worker from. Every request carries the
//  signed-in user's Firebase ID token, which the worker verifies. The SDK
//  refreshes an expired token automatically when getIdToken() is called.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

import { getIdToken } from "./firebase.js";

const WORKER_BASE_URL = "https://plain-band-2d43.oemerson8158.workers.dev";

///////////////////////////////////////////////////////////////////////////
//  Function: workerFetch
//  Inputs: path (worker route, e.g. "/lens"), body (JSON-serializable)
//  Outputs: Promise<Response> — the raw fetch response
//  Summary: POSTs the body as JSON with an Authorization header. If no
//    token can be had, the request is still sent; the worker answers 401
//    and the caller shows that message.
///////////////////////////////////////////////////////////////////////////
async function workerFetch(path, body) {
  let token = null;
  try {
    token = await getIdToken();
  } catch (err) {
    console.warn("API: couldn't get an ID token:", err);
  }

  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  return fetch(`${WORKER_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

export { workerFetch, WORKER_BASE_URL };