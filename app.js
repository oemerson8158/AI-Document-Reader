///////////////////////////////////////////////////////////////////////////
// AI Document Reader
//  This project implements an interactive reading and analysis tool
//  designed to help students understand complex documents more deeply.
//  Its purpose is to support active reading through features such as
//  annotations, topic-based lenses, Lexile rephrasing, and AI-generated
//  provocations that guide comprehension and critical thinking. By
//  combining structured document parsing with targeted AI assistance,
//  the tool helps students engage with texts more effectively.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

//Imports functions from various files in modules
import { addAnnotation, createBookmark, loadAnnotationsUI } from "./modules/annotations.js";
import { initRephraseUI } from "./modules/rephrase.js";
import {
  initLensUI,
  normalizeLens,
  refreshLensMinimap,
  handleDocumentPaneClick,
  lensHitStyle
} from "./modules/lens.js";
import { loadProvocationsUI } from "./modules/provocations.js";
import { setHelpTab, hideHelp } from "./modules/help.js";
import {
  onAuthChange,
  signUpEmail,
  signInEmail,
  signInGoogle,
  signOutUser,
  createDocumentRecord,
  saveDocumentRecord,
  renameDocumentRecord,
  deleteDocumentRecord,
  getDocumentRecord,
  listUserDocuments
} from "./modules/firebase.js";

///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////

//Array to track the currently selected text for annotation tools
let currentSelections = [];

///////////////////////////////////////////////////////////////////////////
// Global State Object
//  This object stores all shared application data for the AI Document
//  Reader. It acts as the central memory of the tool, allowing every
//  module (provocations, rephrase, lenses, annotations) to access and
//  update the document, reading mode, paragraph chunks, and user actions.
///////////////////////////////////////////////////////////////////////////
const state = {
  currentUser: null,
  currentDocId: null,
  documentTitle: "",
  documentText: "",
  purpose: "",
  analysisType: "literary",
  highlightColor: "#ffff00",
  chunks: [],
  annotations: [],
  annotationsSummary: null,
  provocations: [],
  lenses: [],
  activeLensId: null,      // id of the lens currently applied to the reader, if any
  lensCurrentHitId: null,  // id of the hit last navigated to (for Previous/Next)
  rephrased: [],
  rephrase: {
    selectedParagraphIds: [],
    selectedText: "",
    paragraphs: [],
    lexile: null,
    includeExample: false,
    result: ""
  }
};



///////////////////////////////////////////////////////////////////////////
// FUNCTIONS
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: showScreen
//  Inputs: screenName — one of "login", "home", "upload", "reader"
//  Outputs: Shows the matching top-level screen div, hides the other three
//  Summary: Single place that controls which of the app's four screens is
//    visible, so screen transitions don't rely on scattered, easy-to-miss
//    style.display assignments at each call site.
///////////////////////////////////////////////////////////////////////////
function showScreen(screenName) {
  const screens = {
    login: document.getElementById("login-screen"),
    home: document.getElementById("home-screen"),
    upload: document.getElementById("upload-screen"),
    reader: document.getElementById("reader-screen")
  };

  Object.entries(screens).forEach(([name, el]) => {
    if (!el) return;
    if (name === screenName) {
      el.style.display = (name === "reader" || name === "login") ? "flex" : "block";
    } else {
      el.style.display = "none";
    }
  });
}

///////////////////////////////////////////////////////////////////////////
// LOGIN SCREEN
//  Supports both sign-in and account-creation through the same form,
//  toggled by authMode — avoids duplicating the email/password markup
//  for two separate forms.
///////////////////////////////////////////////////////////////////////////
let authMode = "signin"; // "signin" | "signup"

function showAuthError(message) {
  const errEl = document.getElementById("auth-error");
  errEl.textContent = message;
  errEl.style.display = "block";
}

function clearAuthError() {
  const errEl = document.getElementById("auth-error");
  errEl.style.display = "none";
  errEl.textContent = "";
}

function setAuthMode(mode) {
  authMode = mode;
  clearAuthError();
  const submitBtn = document.getElementById("auth-submit");
  const toggleText = document.getElementById("auth-toggle-text");
  const toggleLink = document.getElementById("auth-toggle-link");

  if (mode === "signup") {
    submitBtn.textContent = "Create Account";
    toggleText.textContent = "Already have an account?";
    toggleLink.textContent = "Sign in";
  } else {
    submitBtn.textContent = "Sign In";
    toggleText.textContent = "Don't have an account?";
    toggleLink.textContent = "Create one";
  }
}

// Friendlier text for the Firebase error codes a user is actually likely
// to hit, rather than surfacing raw "Firebase: Error (auth/...)" strings.
function friendlyAuthErrorMessage(err) {
  const code = err && err.code ? err.code : "";
  switch (code) {
    case "auth/invalid-email":
      return "That doesn't look like a valid email address.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect email or password.";
    case "auth/email-already-in-use":
      return "An account with that email already exists — try signing in instead.";
    case "auth/weak-password":
      return "Password should be at least 6 characters.";
    case "auth/popup-closed-by-user":
      return "Google sign-in was closed before finishing.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a moment and try again.";
    case "auth/network-request-failed":
      return "Couldn't reach the server. Check your connection and try again.";
    default:
      return "Something went wrong signing in. Please try again.";
  }
}

document.getElementById("auth-toggle-link").addEventListener("click", (e) => {
  e.preventDefault();
  setAuthMode(authMode === "signin" ? "signup" : "signin");
});

document.getElementById("auth-submit").addEventListener("click", async () => {
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  clearAuthError();

  if (!email || !password) {
    showAuthError("Please enter both an email and a password.");
    return;
  }

  const submitBtn = document.getElementById("auth-submit");
  submitBtn.disabled = true;

  try {
    if (authMode === "signup") {
      await signUpEmail(email, password);
    } else {
      await signInEmail(email, password);
    }
    // onAuthChange (registered below) handles navigating to the home screen.
  } catch (err) {
    console.error("AUTH: sign-in/sign-up failed:", err);
    showAuthError(friendlyAuthErrorMessage(err));
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("auth-google").addEventListener("click", async () => {
  clearAuthError();
  try {
    await signInGoogle();
  } catch (err) {
    console.error("AUTH: Google sign-in failed:", err);
    showAuthError(friendlyAuthErrorMessage(err));
  }
});

document.getElementById("home-sign-out").addEventListener("click", async () => {
  try {
    await signOutUser();
  } catch (err) {
    console.error("AUTH: sign-out failed:", err);
  }
});

///////////////////////////////////////////////////////////////////////////
// HOME SCREEN
///////////////////////////////////////////////////////////////////////////

function formatRelativeTime(timestamp) {
  if (!timestamp || typeof timestamp.toDate !== "function") return "";
  const date = timestamp.toDate();
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.round(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  const diffHours = Math.round(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString();
}

///////////////////////////////////////////////////////////////////////////
// Per-document menu (the three dots on each home-screen row)
//  One floating menu, created when a row's button is clicked and removed on
//  any outside click, Escape, scroll or resize. Offers Rename (inline, in
//  place of the title) and Delete (after a confirmation).
///////////////////////////////////////////////////////////////////////////
let docMenuEl = null;

function closeDocMenu() {
  if (docMenuEl) {
    docMenuEl.remove();
    docMenuEl = null;
  }
}

document.addEventListener("click", closeDocMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDocMenu(); });
window.addEventListener("resize", closeDocMenu);
window.addEventListener("scroll", closeDocMenu, true);

function openDocMenu(anchor, docRecord, itemEl, titleEl) {
  closeDocMenu();

  const menu = document.createElement("div");
  menu.id = "home-doc-menu";
  menu.setAttribute("role", "menu");

  const addEntry = (label, className, onClick) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.className = "home-doc-menu-item" + (className ? ` ${className}` : "");
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeDocMenu();
      onClick();
    });
    menu.appendChild(btn);
    return btn;
  };

  const renameEntry = addEntry("Rename", "", () => startRenameDocument(docRecord, titleEl));
  addEntry("Delete", "home-doc-menu-danger", () => deleteDocument(docRecord, itemEl));

  document.body.appendChild(menu);
  docMenuEl = menu;

  // Right-aligned under the button, or above it if there's no room below.
  const rect = anchor.getBoundingClientRect();
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  let top = rect.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = rect.top - menu.offsetHeight - 4;
  menu.style.top = `${Math.max(8, top)}px`;

  renameEntry.focus();
}

function startRenameDocument(docRecord, titleEl) {
  const originalTitle = docRecord.title || "Untitled document";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "home-doc-rename-input";
  input.value = originalTitle;
  input.maxLength = 120;
  input.setAttribute("aria-label", "Document name");
  // Clicking inside the box mustn't open the document.
  input.addEventListener("click", (e) => e.stopPropagation());

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;

    const newTitle = input.value.trim();
    if (!save || !newTitle || newTitle === originalTitle) {
      input.replaceWith(titleEl);
      return;
    }

    titleEl.textContent = newTitle;
    input.replaceWith(titleEl);

    try {
      await renameDocumentRecord(docRecord.id, newTitle);
      docRecord.title = newTitle;
    } catch (err) {
      console.error("HOME: failed to rename document:", err);
      titleEl.textContent = originalTitle;
      alert("Couldn't rename that document. Try again in a moment.");
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

async function deleteDocument(docRecord, itemEl) {
  const name = docRecord.title || "Untitled document";
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;

  try {
    await deleteDocumentRecord(docRecord.id);
  } catch (err) {
    console.error("HOME: failed to delete document:", err);
    alert("Couldn't delete that document. Try again in a moment.");
    return;
  }

  itemEl.remove();
  if (state.currentDocId === docRecord.id) state.currentDocId = null;

  const listEl = document.getElementById("home-document-list");
  if (listEl.children.length === 0) {
    listEl.innerHTML = `<p class="tool-hint">You don't have any documents yet — click "+ New Document" to get started.</p>`;
  }
}

async function loadHomeScreen() {
  const listEl = document.getElementById("home-document-list");
  listEl.innerHTML = `<p class="tool-hint">Loading your documents...</p>`;

  let docs;
  try {
    docs = await listUserDocuments(state.currentUser.uid);
  } catch (err) {
    console.error("HOME: failed to load documents:", err);
    listEl.innerHTML = `<p style="color:#b00;">Couldn't load your documents right now. Try refreshing.</p>`;
    return;
  }

  if (docs.length === 0) {
    listEl.innerHTML = `<p class="tool-hint">You don't have any documents yet — click "+ New Document" to get started.</p>`;
    return;
  }

  listEl.innerHTML = "";
  docs.forEach(docRecord => {
    const item = document.createElement("div");
    item.className = "home-doc-item";

    const left = document.createElement("div");
    const title = document.createElement("p");
    title.className = "home-doc-title";
    title.textContent = docRecord.title || "Untitled document";

    const meta = document.createElement("p");
    meta.className = "home-doc-meta";
    const purposeLabel = docRecord.purpose === "memorize" ? "Memorize" : "Analysis";
    const relTime = formatRelativeTime(docRecord.updatedAt);
    meta.textContent = relTime ? `${purposeLabel} · Edited ${relTime}` : purposeLabel;

    left.appendChild(title);
    left.appendChild(meta);
    item.appendChild(left);

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "home-doc-menu-btn";
    menuBtn.textContent = "\u22EE"; // vertical three dots
    menuBtn.title = "More actions";
    menuBtn.setAttribute("aria-label", `Actions for ${docRecord.title || "Untitled document"}`);
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // don't open the document
      openDocMenu(menuBtn, docRecord, item, title);
    });
    item.appendChild(menuBtn);

    item.addEventListener("click", () => openExistingDocument(docRecord.id));

    listEl.appendChild(item);
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: openExistingDocument
//  Inputs: docId — Firestore document id
//  Outputs: Populates state from the saved record and shows the reader
//  Summary: Reverse of saveCurrentDocument() below — restores everything
//    that was saved for this document and renders it.
///////////////////////////////////////////////////////////////////////////
async function openExistingDocument(docId) {
  let record;
  try {
    record = await getDocumentRecord(docId);
  } catch (err) {
    console.error("OPEN DOCUMENT: failed to load:", err);
    alert("Couldn't open that document. Try again in a moment.");
    return;
  }

  if (!record) {
    alert("That document couldn't be found — it may have been deleted.");
    return;
  }

  state.currentDocId = docId;
  state.documentTitle = record.title || "";
  state.purpose = record.purpose || "";
  state.analysisType = record.analysisType || "literary";
  state.highlightColor = record.highlightColor || "#ffff00";
  state.chunks = record.chunks || [];
  state.annotations = record.annotations || [];
  state.annotationsSummary = record.annotationsSummary || null;
  state.provocations = record.provocations || [];
  state.lenses = (record.lenses || []).map(normalizeLens);
  state.activeLensId = null;
  state.lensCurrentHitId = null;

  resetTransientState();
  resetReaderView();
  renderDocument();
  renderBookmarkList();
  showScreen("reader");
}

///////////////////////////////////////////////////////////////////////////
//  Function: saveCurrentDocument
//  Inputs: None
//  Outputs: Writes the current document's saveable state to Firestore
//  Summary: Called by the Save button. Only the durable, user-created
//    content is saved — not transient UI state like which lens is
//    currently applied or what's mid-draft in the Rephrase tool.
///////////////////////////////////////////////////////////////////////////
async function saveCurrentDocument() {
  if (!state.currentDocId) return;

  const statusEl = document.getElementById("save-status");
  const saveBtn = document.getElementById("save-document");
  saveBtn.disabled = true;
  statusEl.style.color = "";
  statusEl.textContent = "Saving...";

  try {
    await saveDocumentRecord(state.currentDocId, {
      title: state.documentTitle,
      purpose: state.purpose,
      analysisType: state.analysisType,
      highlightColor: state.highlightColor,
      chunks: state.chunks,
      annotations: state.annotations,
      annotationsSummary: state.annotationsSummary,
      provocations: state.provocations,
      lenses: state.lenses
    });
    statusEl.textContent = "Saved.";
    setTimeout(() => { statusEl.textContent = ""; }, 2500);
  } catch (err) {
    console.error("SAVE: failed:", err);
    statusEl.textContent = "Couldn't save — try again.";
    statusEl.style.color = "#b00";
  } finally {
    saveBtn.disabled = false;
  }
}

document.getElementById("save-document").addEventListener("click", saveCurrentDocument);

document.getElementById("back-to-documents").addEventListener("click", () => {
  showScreen("home");
  loadHomeScreen();
});

document.getElementById("home-new-document").addEventListener("click", () => {
  // Reset upload-screen inputs from any previous document
  document.getElementById("document-input").value = "";
  document.getElementById("file-input").value = "";
  document.getElementById("file-upload-status").textContent = "";
  showScreen("upload");
});

///////////////////////////////////////////////////////////////////////////
// AUTH STATE — drives which screen is shown on load and after login/logout
///////////////////////////////////////////////////////////////////////////
onAuthChange((user) => {
  state.currentUser = user;
  if (user) {
    showScreen("home");
    loadHomeScreen();
  } else {
    showScreen("login");
  }
});

//UPLOAD SCREEN — Analysis subtype visibility
//  The "Analysis Focus" dropdown only makes sense when purpose is set to
//  Analysis, so it's shown/hidden in sync with the purpose dropdown.
///////////////////////////////////////////////////////////////////////////
function syncAnalysisTypeVisibility() {
  const purposeSelect = document.getElementById("purpose-select");
  const container = document.getElementById("analysis-type-container");
  if (!purposeSelect || !container) return;
  container.style.display = purposeSelect.value === "analysis" ? "block" : "none";
}

document.getElementById("purpose-select").addEventListener("change", syncAnalysisTypeVisibility);
syncAnalysisTypeVisibility(); // set correct initial state on page load

//RENDER FUNCTIONS

///////////////////////////////////////////////////////////////////////////
//  Function: loadDocument
//  Inputs: text (string), purpose (string: "analysis" or "memorize")
//  Outputs: Writes document text, purpose, and paragraph chunks to state
//  Error Checking: Assumes valid text and purpose are provided
//  Summary: Loads the user's document into the global state, records the
//    selected reading mode, and splits the document into paragraph-level
//    chunks. These chunks serve as the structural foundation for lenses,
//    provocations, annotations, and rephrasing.
///////////////////////////////////////////////////////////////////////////
function loadDocument(text, purpose, analysisType) {
  // Start from a clean slate: without this, annotations, lenses, and
  // provocations from whichever document was open before would carry over
  // into this new one (and get saved into it).
  state.currentDocId = null;
  state.annotations = [];
  state.annotationsSummary = null;
  state.provocations = [];
  state.lenses = [];
  state.activeLensId = null;
  state.lensCurrentHitId = null;
  resetTransientState();

  state.documentText = text;
  state.purpose = purpose;
  state.analysisType = purpose === "analysis" ? (analysisType || "literary") : "literary";

  // Normalize all newline types
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  // Split on ANY blank line OR single newline
  let paragraphs = normalized
    .split(/\n\s*\n|\n+/)   // ← this is the key change
    .map(p => p.trim())
    .filter(p => p.length > 0);

  // Store chunks
  state.chunks = paragraphs.map((p, i) => ({
    id: i,
    text: p
  }));
}

///////////////////////////////////////////////////////////////////////////
//  Function: getParagraph
//  Inputs: id (integer representing a paragraph ID)
//  Outputs: Returns the paragraph object matching the given ID
//  Error Checking: Returns undefined if the ID does not exist
//  Summary: Retrieves a specific paragraph chunk from the global state.
//    This provides a consistent way for modules to access the exact
//    passage needed for provocations, rephrasing, lenses, and annotations.
///////////////////////////////////////////////////////////////////////////
function getParagraph(id) {
  return state.chunks.find(chunk => chunk.id === id);
}

///////////////////////////////////////////////////////////////////////////
//  Function: escapeHtml
//  Summary: Document text is untrusted (it can contain "<" or "&"), so it
//    has to be escaped before being placed into innerHTML.
///////////////////////////////////////////////////////////////////////////
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildParagraphHtml
//  Inputs: text (the paragraph's text), highlights (the student's yellow-
//    pen annotations), lensHits (hits from the applied lens), lens (the
//    applied lens, for its color)
//  Outputs: An HTML string for the paragraph
//  Summary: Highlights and lens hits can overlap in any way, so rather
//    than trying to nest them by hand, this cuts the text at every
//    boundary any of them has, and styles each resulting piece according
//    to whichever highlight and/or lens hit covers it. The lens shading is
//    the outer span and the student's highlight the inner one, so both
//    stay visible where they overlap.
///////////////////////////////////////////////////////////////////////////
function buildParagraphHtml(text, highlights, lensHits, lens) {
  const len = text.length;
  const clamp = n => Math.max(0, Math.min(len, n));

  const points = new Set([0, len]);
  highlights.forEach(h => { points.add(clamp(h.startOffset)); points.add(clamp(h.endOffset)); });
  lensHits.forEach(h => { points.add(clamp(h.startOffset)); points.add(clamp(h.endOffset)); });
  const cuts = Array.from(points).sort((a, b) => a - b);

  let html = "";

  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b <= a) continue;

    let piece = escapeHtml(text.slice(a, b));

    const highlight = highlights.find(h => h.startOffset <= a && h.endOffset >= b);
    if (highlight) {
      const color = highlight.color || "#ffff00";
      piece = `<span class="highlighted" style="background-color:${color};">${piece}</span>`;
    }

    // If lens hits overlap, a strong one wins over a partial one.
    const covering = lensHits.filter(h => h.startOffset <= a && h.endOffset >= b);
    const hit = covering.find(h => h.strength === "strong") || covering[0];
    if (hit && lens) {
      const current = hit.id === state.lensCurrentHitId ? " lens-hit-current" : "";
      piece = `<span class="lens-hit${current}" data-hit-id="${hit.id}" style="${lensHitStyle(lens.color, hit.strength)}">${piece}</span>`;
    }

    html += piece;
  }

  return html;
}

///////////////////////////////////////////////////////////////////////////
//  Function: renderDocument
//  Inputs: None
//  Outputs: Renders all paragraph chunks into #document-pane as <p> tags
//  Error Checking: Assumes state.chunks is already populated by loadDocument
//  Summary: Generates the scrollable document viewer in the left pane of
//    the reader screen. Each paragraph chunk is converted into a <p>
//    element with a data-id attribute.
///////////////////////////////////////////////////////////////////////////
function renderDocument() {
  const pane = document.getElementById("document-pane");
  const savedScroll = pane.scrollTop; // rebuilding the pane resets scrolling; restored at the end
  pane.innerHTML = "";

  const activeLens = state.lenses.find(l => l.id === state.activeLensId) || null;

  state.chunks.forEach(chunk => {
    const p = document.createElement("p");
    p.dataset.id = chunk.id;

    // -----------------------------
    // 1 + 2. Annotation highlights and lens hits
    //  Both are drawn as spans over the paragraph's text. If a paragraph
    //  has neither, it stays plain text.
    // -----------------------------
    const highlights = state.annotations
      .filter(a => a.paragraphId === chunk.id && a.type === "highlight")
      .sort((a, b) => a.startOffset - b.startOffset);

    const lensHits = activeLens
      ? activeLens.hits.filter(h => h.paragraphId === chunk.id)
      : [];

    if (highlights.length === 0 && lensHits.length === 0) {
      p.textContent = chunk.text;
    } else {
      p.innerHTML = buildParagraphHtml(chunk.text, highlights, lensHits, activeLens);
    }

    // -----------------------------
    // 3. Provocation incorrect highlight (green)
    // -----------------------------
    const provForParagraph = state.provocations.filter(
      prov => prov.paragraphId === chunk.id && prov.status === "incorrect"
    );

    if (provForParagraph.length > 0) {
      p.style.backgroundColor = "#b7ff8f"; // highlighter green
    }

    // -----------------------------
    // 4. Note icons
    // -----------------------------
    const notes = state.annotations.filter(a =>
      a.paragraphId === chunk.id && a.type === "note"
    );

    notes.forEach(note => {
      const icon = document.createElement("span");
      icon.classList.add("note-icon");
      icon.dataset.noteId = note.id;
      icon.textContent = "📝";

      icon.addEventListener("click", (event) => {
        event.stopPropagation();
        showNotePopup(note, icon);
      });

      p.appendChild(icon);
    });

    // -----------------------------
    // 5. Provocation icons (💡)
    // -----------------------------
    const provs = state.provocations.filter(
      prov => prov.paragraphId === chunk.id
    );

    provs.forEach(prov => {
      const icon = document.createElement("span");
      icon.classList.add("provocation-icon");
      icon.dataset.provId = prov.id;
      icon.textContent = "💡";

      icon.style.position = "absolute";
      icon.style.right = "0px";
      icon.style.top = "0px";

      icon.addEventListener("click", (event) => {
        event.stopPropagation();

        window.dispatchEvent(new CustomEvent("provocation:selected", {
          detail: { provId: prov.id }
        }));
      });

      p.appendChild(icon);
    });

    pane.appendChild(p);
  });

  renderBookmarkIcons();
  pane.scrollTop = savedScroll;
}

///////////////////////////////////////////////////////////////////////////
//  Function: layoutParagraphIcons
//  Inputs: None
//  Outputs: Repositions all icons (notes, provocations, bookmarks) within
//    each paragraph so they sit side-by-side instead of overlapping, and
//    sizes each paragraph's right-side gutter to fit only as many icons
//    as that specific paragraph actually has.
//  Summary: Notes, provocations, and bookmarks are each added to a
//    paragraph independently by separate code (and bookmarks are added by
//    a whole separate function, renderBookmarkIcons, called after this
//    one), so none of them know whether another icon has already claimed
//    the same spot. This runs last, once every icon for every paragraph
//    already exists in the DOM: it lines icons up left-to-right along the
//    paragraph's top-right corner, and grows that paragraph's own
//    padding-right just enough to fit them — a paragraph with 0 or 1
//    icons keeps the normal, small gutter; a paragraph with several
//    icons gets a wider one, instead of every paragraph in the document
//    reserving space for a worst-case icon count it will probably never
//    have.
///////////////////////////////////////////////////////////////////////////
function layoutParagraphIcons() {
  const pane = document.getElementById("document-pane");
  const paragraphs = pane.querySelectorAll("p");

  const ICON_STEP_PX = 22;   // horizontal spacing between stacked icons
  const BASE_GUTTER_PX = 24; // normal/default gutter width (fits 0–1 icons)

  paragraphs.forEach(p => {
    const icons = Array.from(
      p.querySelectorAll(".note-icon, .provocation-icon, .bookmark-icon")
    );

    icons.forEach((icon, index) => {
      icon.style.position = "absolute";
      icon.style.top = "0px";
      icon.style.right = `${index * ICON_STEP_PX}px`;
    });

    // Gutter only grows past the base size once there's more than one
    // icon competing for the same space.
    const neededWidth = icons.length * ICON_STEP_PX + 4;
    p.style.paddingRight = `${Math.max(BASE_GUTTER_PX, neededWidth)}px`;
  });

  // Changing the gutters can change how paragraphs wrap, which moves
  // where every lens hit sits on the page — so the lens minimap is
  // refreshed here, after layout has settled.
  refreshLensMinimap();
}

///////////////////////////////////////////////////////////////////////////
//  Function: setupTabs
//  Inputs: None
//  Outputs: Activates sidebar tab switching
//  Summary: Enables interactive switching between sidebar modules.
//    Highlights the active tab and prepares the content area for
//    Phase 6–8 modules.
///////////////////////////////////////////////////////////////////////////
function setupTabs() {
  const tabs = document.querySelectorAll("#tool-tabs button");
  const content = document.getElementById("tool-content");
  const annotationTools = document.getElementById("annotation-tools");

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {

      // Remove active class from all tabs
      tabs.forEach(t => t.classList.remove("active"));

      // Add active class to clicked tab
      tab.classList.add("active");

      // Point the "?" button at this tab's tutorial
      setHelpTab(tab.dataset.tab);

      // Clear content area
      content.innerHTML = "";

      // Show annotation tools ONLY when annotations tab is selected
      if (tab.dataset.tab === "annotations") {
        annotationTools.style.display = "block";
        loadAnnotationsUI();
      } else {
        annotationTools.style.display = "none";
      }

      // Load Rephrase UI when Rephrase tab is selected
      if (tab.dataset.tab === "rephrase") {
        loadRephraseUI();
        return;
      }

      // Load Lens UI when Lens tab is selected
      if (tab.dataset.tab === "lenses") {
        loadLensesUI();
        return;
      }

      // Load Provocations UI when Provocations tab is selected
      if (tab.dataset.tab === "provocations") {
        loadProvocationsUI();
        return;
      }

    });
  });
}

// The tab buttons are static HTML, so their listeners are attached exactly
// once, at startup. (Calling this every time a document was opened stacked
// duplicate listeners, so each tab click ran its loader several times.)
setupTabs();

///////////////////////////////////////////////////////////////////////////
//  Function: resetReaderView
//  Summary: Puts the reader's chrome back to a blank starting point when a
//    document is opened: no active tab, empty sidebar content, annotation
//    tools hidden, popups closed, and the document scrolled to the top.
///////////////////////////////////////////////////////////////////////////
function resetReaderView() {
  document.querySelectorAll("#tool-tabs button").forEach(t => t.classList.remove("active"));
  document.getElementById("tool-content").innerHTML = "";
  document.getElementById("annotation-tools").style.display = "none";
  hideHelp();
  document.getElementById("note-popup").style.display = "none";
  document.getElementById("bookmark-popup").style.display = "none";
  document.getElementById("save-status").textContent = "";
  document.getElementById("document-pane").scrollTop = 0;
}

///////////////////////////////////////////////////////////////////////////
//  Function: resetTransientState
//  Summary: Clears per-document working state (the current text selection
//    and the Rephrase tool's draft) so nothing from the previously open
//    document can leak into a newly opened one.
///////////////////////////////////////////////////////////////////////////
function resetTransientState() {
  currentSelections = [];
  state.rephrase = {
    selectedParagraphIds: [],
    selectedText: "",
    paragraphs: [],
    lexile: null,
    includeExample: false,
    result: ""
  };
}

///////////////////////////////////////////////////////////////////////////
//  Function: loadRephraseUI
//  Inputs: None
//  Outputs: Injects the rephrase tool UI into #tool-content and initializes
//    event handling for lexile selection, example toggle, and submission
//  Error Checking: Assumes state.purpose and state.rephrase exist and that
//    #tool-content is a valid DOM element
//  Summary: Builds the rephrase interface, positions the lexile dropdown and
//    submit button on the top row, conditionally reveals the example checkbox
//    for memorize mode, and wires UI updates to initRephraseUI for processing
///////////////////////////////////////////////////////////////////////////
function loadRephraseUI() {
  const content = document.getElementById("tool-content");

content.innerHTML = `
  <div class="rephrase-top-row">
    <select id="rephrase-lexile">
      <option value="200">200L (K)</option>
      <option value="400">400L (1st Grade)</option>
      <option value="550">550L (2nd Grade)</option>
      <option value="670">670L (3rd Grade)</option>
      <option value="770">770L (4th Grade)</option>
      <option value="860">860L (5th Grade)</option>
      <option value="950">950L (6th Grade)</option>
      <option value="1000">1000L (7th Grade)</option>
      <option value="1050">1050L (8th Grade)</option>
      <option value="1100">1100L (9th Grade)</option>
      <option value="1150">1150L (10th Grade)</option>
      <option value="1200">1200L (11th Grade)</option>
      <option value="1300">1300L (12th Grade)</option>
    </select>

    <button id="rephrase-submit">Rephrase</button>
  </div>

  <label id="rephrase-example-wrapper" style="display:none;">
    <input type="checkbox" id="rephrase-include-example">
    Include an example
  </label>

  <textarea id="rephrase-output"
            class="output-box"
            style="display:none;"></textarea>
`;


  if (state.purpose === "memorize") {
    document.getElementById("rephrase-example-wrapper").style.display = "block";
  }

  initRephraseUI({
    getState: () => state,
    setResult: (text) => {
      state.rephrase.result = text;

      const box = document.getElementById("rephrase-output");
      box.style.display = "block";
      box.value = text;

      // Auto-expand to fit content
      box.style.height = "auto";
      box.style.height = box.scrollHeight + "px";
    }

  });
}

function loadLensesUI() {
  initLensUI();
}


//BOOKMARK FUNCTIONS

///////////////////////////////////////////////////////////////////////////
//  Function: renderBookmarkList
//  Inputs: None
//  Outputs: Renders all bookmark annotations into the #bookmark-items list
//  Error Checking: Assumes state.annotations already contains bookmark objects
//  Summary: Populates the collapsible bookmark list in the sidebar by
//    generating a button for each stored bookmark.
///////////////////////////////////////////////////////////////////////////
function renderBookmarkList() {
  const container = document.getElementById("bookmark-items");
  container.innerHTML = "";

  const bookmarks = state.annotations.filter(a => a.type === "bookmark");

  bookmarks.forEach(b => {
    const btn = document.createElement("button");
    btn.textContent = b.name;

    btn.addEventListener("click", () => {
      jumpToBookmark(b);
    });

    container.appendChild(btn);
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: renderBookmarkIcons
//  Inputs: None
//  Outputs: Places a bookmark icon next to the first line of each bookmark
//  Error Checking: Assumes state.annotations contains bookmark objects
//  Summary: Renders clickable bookmark icons inside the document pane.
//    Also re-runs layoutParagraphIcons() at the end, since several call
//    sites call this function directly (rather than the full
//    renderDocument()) as a lighter-weight update when only bookmarks have
//    changed — without this, those paths would add/remove a bookmark icon
//    but never reposition it relative to any note/provocation icon
//    already on the same paragraph, causing icons to overlap.
///////////////////////////////////////////////////////////////////////////
function renderBookmarkIcons() {
  const pane = document.getElementById("document-pane");
  const paragraphs = pane.querySelectorAll("p");

  // Remove old icons
  pane.querySelectorAll(".bookmark-icon").forEach(icon => icon.remove());

  const bookmarks = state.annotations.filter(a => a.type === "bookmark");

  bookmarks.forEach(b => {
    const p = Array.from(paragraphs).find(
      el => Number(el.dataset.id) === b.paragraphId
    );
    if (!p) return;

    const icon = document.createElement("span");
    icon.textContent = "🔖";
    icon.className = "bookmark-icon";
    icon.dataset.id = b.id;

    icon.style.top = "0px";

    icon.addEventListener("click", () => {
      openBookmarkPopup(b, icon);
    });

    p.appendChild(icon);
  });

  layoutParagraphIcons();
}

///////////////////////////////////////////////////////////////////////////
//  Function: jumpToBookmark
//  Inputs: bookmark (object) – A bookmark containing paragraphId and offsets
//  Outputs: Scrolls the document pane to the bookmarked text location
//  Error Checking: Assumes the paragraph exists and offsets are valid
//  Summary: Locates the bookmarked text range in the document and smoothly
//    scrolls the reader pane so the bookmarked passage is brought into view.
///////////////////////////////////////////////////////////////////////////
function jumpToBookmark(bookmark) {
  const pane = document.getElementById("document-pane");
  const paragraphs = pane.querySelectorAll("p");

  const p = Array.from(paragraphs).find(
    el => Number(el.dataset.id) === bookmark.paragraphId
  );

  if (!p) return;

  const range = document.createRange();
  let walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let offset = bookmark.startOffset;

  while (node && offset > node.length) {
    offset -= node.length;
    node = walker.nextNode();
  }

  if (node) {
    range.setStart(node, offset);
    const rect = range.getBoundingClientRect();
    pane.scrollTo({
      top: pane.scrollTop + rect.top - pane.getBoundingClientRect().top - 40,
      behavior: "smooth"
    });
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: openBookmarkPopup
//  Inputs: bookmark (object), icon (DOM element)
//  Outputs: Displays a popup positioned next to the bookmark icon,
//           showing the bookmark name and action buttons
//  Error Checking: Assumes the bookmark exists and the icon is valid
//  Summary: Opens the bookmark popup UI, populates it with the bookmark’s
//           name, and positions it relative to the clicked bookmark icon.
///////////////////////////////////////////////////////////////////////////
function openBookmarkPopup(bookmark, icon) {
  const popup = document.getElementById("bookmark-popup");
  const text = document.getElementById("bookmark-popup-text");

  text.textContent = bookmark.name;

  const rect = icon.getBoundingClientRect();
  const paneRect = document.getElementById("tool-pane").getBoundingClientRect();

  popup.style.left = `${rect.right + 10}px`;
  popup.style.top = `${rect.top - paneRect.top}px`;
  popup.style.display = "block";

  popup.dataset.id = bookmark.id;
}

//NOTE FUNCTIONS

///////////////////////////////////////////////////////////////////////////
//  Function: showNotePopup
//  Inputs:
//    note (object) – The note annotation object containing:
//        • id (string) – Unique annotation identifier
//        • paragraphId (number) – Paragraph where the note is attached
//        • startOffset (number) – Start position of the annotated text
//        • endOffset (number) – End position of the annotated text
//        • noteText (string) – The user’s saved note content
//
//    iconElement (HTMLElement) – The DOM element representing the note
//        icon the user clicked. Used to determine popup positioning.
//  Outputs:
//    Displays the note popup box (#note-popup) in the sidebar next to
//    the annotation tools. Populates the popup with the note’s text,
//    stores the note ID for edit/delete actions, and positions the popup
//    relative to the sidebar container.
//  Summary:
//    Opens a note viewer when the user clicks a note
//    icon. The popup shows the note text and provides edit/delete
//    controls. This function handles positioning, populating, and
//    activating the popup UI. It does not modify annotation data; edit
//    and delete actions are handled by separate event listeners.
//
///////////////////////////////////////////////////////////////////////////
function showNotePopup(note, iconElement) {
  const popup = document.getElementById("note-popup");
  const text = document.getElementById("note-popup-text");

  text.textContent = note.noteText;
  popup.dataset.noteId = note.id;

  const iconRect = iconElement.getBoundingClientRect();
  const sidebar = document.getElementById("tool-pane");
  const sidebarRect = sidebar.getBoundingClientRect();

  // Make sure popup is inside the sidebar so it uses sidebar's coordinate system
  if (popup.parentElement !== sidebar) {
    sidebar.appendChild(popup);
  }

  // Vertical: icon's top relative to sidebar
  const topOffset = iconRect.top - sidebarRect.top + sidebar.scrollTop;

  // Horizontal: 5px from sidebar's left edge
  const leftOffset = 5;

  popup.style.position = "absolute";
  popup.style.left = `${leftOffset}px`;
  popup.style.top = `${topOffset}px`;

  popup.style.display = "block";
}

//LENS FUNCTIONS live in modules/lens.js now (creating, applying, navigating,
//and deleting lenses all happen there).

//MISCELLANEOUS FUNCTIONS

///////////////////////////////////////////////////////////////////////////
//  Function: captureSelection
//  Inputs: None
//  Outputs: Updates currentSelection with paragraph ID + offsets
//  Summary: Uses window.getSelection() to capture selected text, maps it
//    to the correct paragraph, and computes start/end offsets.
///////////////////////////////////////////////////////////////////////////
function captureSelection() {
  const sel = window.getSelection();
  currentSelections = [];

  // SAFETY: Do nothing if document not loaded yet
  if (state.chunks.length === 0) return;

  if (!sel || sel.isCollapsed) return;

  const range = sel.getRangeAt(0);
  const selectedText = sel.toString().trim();
  if (!selectedText) return;

  const paragraphs = Array.from(document.querySelectorAll("#document-pane p"));
  if (paragraphs.length === 0) return; // SAFETY

  paragraphs.forEach(p => {
    const paragraphRange = document.createRange();
    paragraphRange.selectNodeContents(p);

    // Safety: Only compare ranges if both share a common root
    try {
      const intersects =
        range.compareBoundaryPoints(Range.END_TO_START, paragraphRange) < 0 &&
        range.compareBoundaryPoints(Range.START_TO_END, paragraphRange) > 0;

      if (!intersects) return;
    } catch (e) {
      return; // Skip paragraphs that cause DOM errors
    }

    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let startOffset = null;
    let endOffset = null;

    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const length = textNode.textContent.length;

      if (textNode === range.startContainer) {
        startOffset = offset + range.startOffset;
      }
      if (textNode === range.endContainer) {
        endOffset = offset + range.endOffset;
      }

      offset += length;
    }

    // Measure against the paragraph's real text: the DOM text also contains
    // the note/bookmark/provocation icon emoji appended to the paragraph.
    const paragraphId = parseInt(p.dataset.id, 10);
    const chunkText = getParagraph(paragraphId)?.text ?? p.textContent;

    if (startOffset === null) startOffset = 0;
    if (endOffset === null) endOffset = chunkText.length;
    startOffset = Math.min(startOffset, chunkText.length);
    endOffset = Math.min(endOffset, chunkText.length);
    if (endOffset <= startOffset) return; // selection only touched an icon

    currentSelections.push({
      paragraphId,
      startOffset,
      endOffset,
      text: chunkText.slice(startOffset, endOffset)
    });
  });


  // Ensure rephrase state exists
  state.rephrase = state.rephrase || {};

  // Store selected text for the rephrase tool
  state.rephrase.selectedText = selectedText;

  // Store the paragraph IDs containing the selection
  state.rephrase.selectedParagraphIds = currentSelections.map(sel => sel.paragraphId);

  // ⭐ CRITICAL: Store actual paragraph text array for the Worker
  state.rephrase.paragraphs = currentSelections.map(sel => sel.text);
}



///////////////////////////////////////////////////////////////////////////
// UI ELEMENTS AND EVENT LISTENERS
///////////////////////////////////////////////////////////////////////////

//ANNOTATION BUTTONS

//Highlight color picker
document.getElementById("highlight-color").addEventListener("input", (e) => {
  state.highlightColor = e.target.value;
});

//Highlight button
document.getElementById("btn-highlight").addEventListener("click", () => {
  if (currentSelections.length === 0) return;

  currentSelections.forEach(sel => {
    addAnnotation("highlight", sel, { color: state.highlightColor });
  });

  renderDocument();
});

//Unhighlight button
document.getElementById("btn-unhighlight").addEventListener("click", () => {
  if (currentSelections.length === 0) return;

  currentSelections.forEach(sel => {
    state.annotations = state.annotations.filter(a => {
      if (a.type !== "highlight") return true;

      const overlaps =
        a.paragraphId === sel.paragraphId &&
        a.startOffset < sel.endOffset &&
        a.endOffset > sel.startOffset;

      return !overlaps;
    });
  });

  renderDocument();
  window.getSelection().removeAllRanges();
  currentSelections = [];
});

//Bookmark button
document.getElementById("btn-bookmark").addEventListener("click", () => {
  if (!currentSelections || currentSelections.length === 0) {
    return;
  }

  // Only one of Bookmark/Note input should be open at a time
  document.getElementById("note-input-container").style.display = "none";

  document.getElementById("bookmark-input-container").style.display = "flex";
});

// Submit Bookmark Button (enter button)
document.getElementById("bookmark-submit").addEventListener("click", () => {
  const container = document.getElementById("bookmark-input-container");
  const input = document.getElementById("bookmark-input");
  const name = input.value.trim();

  if (!name) {
    return;
  }

  // Edit mode
  if (container.dataset.editingId) {
    const id = container.dataset.editingId;
    const bookmark = state.annotations.find(a => a.id === id);
    if (bookmark) {
      bookmark.name = name;
    }

    // Clear editing mode
    delete container.dataset.editingId;

    input.value = "";
    container.style.display = "none";

    renderBookmarkList();
    renderBookmarkIcons();
    return;
  }

  // Create mode
  if (!currentSelections || currentSelections.length === 0) return;

  const firstSelection = currentSelections[0];
  createBookmark(name, firstSelection);

  input.value = "";
  container.style.display = "none";

  renderBookmarkList();
  renderBookmarkIcons();
});

// Cancel Bookmark Button
document.getElementById("bookmark-cancel").addEventListener("click", () => {
  const container = document.getElementById("bookmark-input-container");
  const input = document.getElementById("bookmark-input");

  input.value = "";
  delete container.dataset.editingId;
  container.style.display = "none";
});



// Toggle to expand/collapse bookmark list
document.getElementById("bookmark-toggle").addEventListener("click", () => {
  const items = document.getElementById("bookmark-items");
  const toggle = document.getElementById("bookmark-toggle");

  if (items.style.display === "none") {
    items.style.display = "block";
    toggle.textContent = "Bookmarks ▲";
  } else {
    items.style.display = "none";
    toggle.textContent = "Bookmarks ▼";
  }
});

// Close Bookmark button
document.getElementById("bookmark-close").addEventListener("click", () => {
  document.getElementById("bookmark-popup").style.display = "none";
});

// Delete Bookmark button
document.getElementById("bookmark-delete").addEventListener("click", () => {
  const popup = document.getElementById("bookmark-popup");
  const id = popup.dataset.id;

  state.annotations = state.annotations.filter(a => a.id !== id);

  popup.style.display = "none";
  renderBookmarkList();
  renderBookmarkIcons();
});

// Edit Bookmark button
document.getElementById("bookmark-edit").addEventListener("click", () => {
  const popup = document.getElementById("bookmark-popup");
  const id = popup.dataset.id;

  const bookmark = state.annotations.find(a => a.id === id);
  if (!bookmark) return;

  // Close popup
  popup.style.display = "none";

  // Open the existing bookmark input box
  const container = document.getElementById("bookmark-input-container");
  const input = document.getElementById("bookmark-input");

  container.style.display = "flex";

  // Pre-fill with current bookmark name
  input.value = bookmark.name;

  // Mark that we are editing instead of creating
  container.dataset.editingId = id;
});


// Add Note button
document.getElementById("btn-add-note").addEventListener("click", () => {
  if (currentSelections.length === 0) {
    return;
  }

  // Only one of Bookmark/Note input should be open at a time
  document.getElementById("bookmark-input-container").style.display = "none";

  delete document.getElementById("note-input-container").dataset.editingId;
  document.getElementById("note-input-container").style.display = "flex";
  document.getElementById("note-input").value = "";
});

// Submit Note button (enter button). Handles both creating a new note and
// saving an edit to an existing one, depending on whether editingId is set.
document.getElementById("note-submit").addEventListener("click", () => {
  const container = document.getElementById("note-input-container");
  const noteText = document.getElementById("note-input").value.trim();
  if (!noteText) {
    return;
  }

  if (container.dataset.editingId) {
    const note = state.annotations.find(a => a.id === container.dataset.editingId);
    if (note) note.noteText = noteText;
    delete container.dataset.editingId;
  } else {
    // Attach note ONLY to the first selected paragraph
    const firstSelection = currentSelections[0];
    if (firstSelection) {
      addAnnotation("note", firstSelection, { noteText });
    }
  }

  container.style.display = "none";
  renderDocument();
});

// Cancel Note button
document.getElementById("note-cancel").addEventListener("click", () => {
  const container = document.getElementById("note-input-container");
  document.getElementById("note-input").value = "";
  delete container.dataset.editingId;
  container.style.display = "none";
});


// Edit Note button
document.getElementById("note-edit").addEventListener("click", () => {
  const popup = document.getElementById("note-popup");
  const note = state.annotations.find(a => a.id === popup.dataset.noteId);
  if (!note) return;

  const container = document.getElementById("note-input-container");
  container.dataset.editingId = note.id;
  container.style.display = "flex";
  document.getElementById("note-input").value = note.noteText;

  popup.style.display = "none";
});

// Delete Note button
document.getElementById("note-delete").addEventListener("click", () => {
  const popup = document.getElementById("note-popup");
  const noteId = popup.dataset.noteId;

  // Remove annotation from state
  state.annotations = state.annotations.filter(a => a.id !== noteId);

  // Hide popup
  popup.style.display = "none";

  // Re-render document so the icon disappears
  renderDocument();
});

// Close Note button
document.getElementById("note-close").addEventListener("click", () => {
  const popup = document.getElementById("note-popup");
  popup.style.display = "none";
});

// ADDITIONAL EVENT LISTENERS

// Captures text selection when the user releases the mouse button
// Clicking a highlighted lens sentence shows why it matched.
document.getElementById("document-pane").addEventListener("click", handleDocumentPaneClick);

document.getElementById("document-pane").addEventListener("mouseup", () => {
  if (state.chunks.length === 0) return;  // Safety
  captureSelection();
});

// Touch and keyboard selections.
//  Selecting with a finger (long-press, then dragging the selection handles)
//  or with Shift+arrow keys never fires "mouseup", so the listener above
//  alone misses them. Two additions cover those cases:
//
//  1. "selectionchange" fires whenever the browser's selection moves, however
//     it was made. It fires many times while a handle is being dragged, so it
//     is debounced, and it only ever CAPTURES (a non-empty selection that sits
//     inside the document pane). It never clears: on iPadOS, tapping a sidebar
//     button (Highlight, Bookmark...) can collapse the selection before the
//     button's click lands, and clearing then would make the button do nothing.
//  2. A tap (touchend) inside the pane re-reads the selection after a short
//     delay, mirroring what mouseup does for a click: a tap that dismisses the
//     selection clears it, one that finishes a selection captures it.
let selectionChangeTimer = null;

document.addEventListener("selectionchange", () => {
  clearTimeout(selectionChangeTimer);
  selectionChangeTimer = setTimeout(() => {
    if (state.chunks.length === 0) return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const pane = document.getElementById("document-pane");
    if (!pane.contains(sel.anchorNode) || !pane.contains(sel.focusNode)) return;

    captureSelection();
  }, 200);
});

document.getElementById("document-pane").addEventListener("touchend", () => {
  setTimeout(() => {
    if (state.chunks.length === 0) return;
    captureSelection();
  }, 300);
});

///////////////////////////////////////////////////////////////////////////
//  Function: extractTextFromPdf
//  Inputs: arrayBuffer (ArrayBuffer) — raw bytes of a .pdf file
//  Outputs: Promise<string> — extracted text, with a best-effort attempt
//    at paragraph breaks
//  Summary: PDFs don't have explicit paragraph markup like .docx does —
//    pdf.js only gives us positioned text runs on a page. This groups
//    runs into lines by shared y-position, then inserts a paragraph break
//    wherever the vertical gap between consecutive lines is noticeably
//    larger than the page's typical line spacing (a proxy for "this is a
//    new paragraph, not just the next line of the same one"). On top of
//    that base layout-detection pass, four targeted cleanup heuristics
//    handle the most common PDF-extraction artifacts:
//      1. Line-wrap hyphens ("mathe-" + "matics") are rejoined into one
//         word instead of left as a literal hyphen.
//      2. Footnote-marker digits (small superscript numbers embedded mid-
//         sentence) are dropped using pdf.js's own font-size data, before
//         they ever get glued into a line.
//      3. Running headers/footers/page numbers that repeat near-
//         identically across multiple pages (only checked among
//         paragraphs that sit at the very start/end of their page,
//         where headers/footers actually land) are detected and removed.
//      4. A drop-cap artifact at the very start of a paragraph (e.g. a
//         stylized "T" rendered as a separate text run from "he term...",
//         producing "T he term...") is merged back together.
//    None of these are perfect — multi-column layouts, tables, or unusual
//    formatting may still come out imperfectly and could need manual
//    cleanup after upload. Scanned/image-only PDFs have no embedded text
//    at all and will produce nothing.
///////////////////////////////////////////////////////////////////////////
async function extractTextFromPdf(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  // Each entry is one paragraph, tagged with which page it came from and
  // whether it was the first or last paragraph extracted on that page —
  // used later by the header/footer detection pass (fix #3).
  const allEntries = [];

  // Fix #1: rejoin a hyphenated line-wrap word instead of leaving the
  // literal hyphen + line break in place.
  function joinLine(paragraph, nextLineText) {
    const trimmedCurrent = paragraph.replace(/\s+$/, "");
    if (/[a-z]-$/.test(trimmedCurrent) && /^[a-z]/.test(nextLineText.trimStart())) {
      return trimmedCurrent.slice(0, -1) + nextLineText.trimStart();
    }
    return paragraph + " " + nextLineText;
  }

  // Fix #4: a single capital letter, a space, then a lowercase letter at
  // the very start of a paragraph is almost never real English — it's the
  // signature of a drop-cap rendered as its own separate text run.
  function fixDropCap(text) {
    return text.replace(/^([A-Z]) ([a-z])/, "$1$2");
  }

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Fix #2: drop likely footnote-marker items before grouping into
    // lines. Footnote markers are almost always small superscript digits —
    // a noticeably smaller font than the page's dominant body-text size —
    // so use pdf.js's own per-item height instead of guessing from text
    // patterns alone.
    const nonEmptyItems = content.items.filter(item => item.str.trim().length > 0);
    const heightCounts = new Map();
    nonEmptyItems.forEach(item => {
      const h = Math.round(Math.abs(item.height) || 0);
      if (h > 0) heightCounts.set(h, (heightCounts.get(h) || 0) + 1);
    });
    let dominantHeight = 0;
    let dominantCount = 0;
    heightCounts.forEach((count, h) => {
      if (count > dominantCount) {
        dominantCount = count;
        dominantHeight = h;
      }
    });

    const filteredItems = content.items.filter(item => {
      const isPureDigits = /^\d+$/.test(item.str.trim());
      const h = Math.abs(item.height) || 0;
      const isNoticeablySmaller = dominantHeight > 0 && h > 0 && h < dominantHeight * 0.8;
      return !(isPureDigits && isNoticeablySmaller);
    });

    // Group remaining text items into lines based on shared y-position (baseline).
    const lines = [];
    let currentLine = null;

    filteredItems.forEach(item => {
      const y = Math.round(item.transform[5]);
      if (currentLine && Math.abs(currentLine.y - y) < 2) {
        currentLine.text += item.str;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = { y, text: item.str };
      }
    });
    if (currentLine) lines.push(currentLine);
    if (lines.length === 0) continue;

    // Typical line-to-line spacing on this page, used to detect a gap
    // large enough to be a paragraph break rather than just the next line.
    const deltas = [];
    for (let i = 1; i < lines.length; i++) {
      deltas.push(Math.abs(lines[i - 1].y - lines[i].y));
    }
    const sorted = [...deltas].sort((a, b) => a - b);
    const medianDelta = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
    const paragraphGapThreshold = medianDelta * 1.5 || 20;

    const pageParagraphs = [];
    let currentParagraph = lines[0].text;
    for (let i = 1; i < lines.length; i++) {
      const gap = Math.abs(lines[i - 1].y - lines[i].y);
      if (gap > paragraphGapThreshold) {
        pageParagraphs.push(fixDropCap(currentParagraph.trim()));
        currentParagraph = lines[i].text;
      } else {
        currentParagraph = joinLine(currentParagraph, lines[i].text);
      }
    }
    pageParagraphs.push(fixDropCap(currentParagraph.trim()));

    pageParagraphs
      .filter(p => p.length > 0)
      .forEach((text, idx, arr) => {
        allEntries.push({
          text,
          page: pageNum,
          isPageEdge: idx === 0 || idx === arr.length - 1
        });
      });
  }

  // Fix #3: detect and remove running headers/footers/page numbers.
  // Only paragraphs that sat at the very start or end of their page are
  // considered candidates, so a genuinely repeated sentence elsewhere in
  // the body text is never mistaken for a header/footer. Leading/trailing
  // digits (page numbers) are stripped before comparing, so e.g. "2 journal
  // of world history, spring 1994" and "3 journal of world history, spring
  // 1994" are recognized as the same repeating footer.
  function normalizeForRepeatDetection(text) {
    return text
      .toLowerCase()
      .replace(/^\d+\s*/, "")
      .replace(/\s*\d+$/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const edgePageSets = new Map(); // normalized text -> Set of page numbers it appeared on
  allEntries.forEach(entry => {
    if (!entry.isPageEdge) return;
    const norm = normalizeForRepeatDetection(entry.text);
    if (!norm) return;
    if (!edgePageSets.has(norm)) edgePageSets.set(norm, new Set());
    edgePageSets.get(norm).add(entry.page);
  });

  const repeatedHeaderFooterTexts = new Set();
  edgePageSets.forEach((pagesSeenOn, norm) => {
    if (pagesSeenOn.size >= 2) {
      repeatedHeaderFooterTexts.add(norm);
    }
  });

  const cleanedParagraphs = allEntries
    .filter(entry => {
      if (!entry.isPageEdge) return true;
      return !repeatedHeaderFooterTexts.has(normalizeForRepeatDetection(entry.text));
    })
    .map(entry => entry.text);

  return cleanedParagraphs.filter(p => p.length > 0).join("\n\n");
}

///////////////////////////////////////////////////////////////////////////
//  Function: extractTextFromDocx
//  Inputs: arrayBuffer (ArrayBuffer) — raw bytes of a .docx file
//  Outputs: Promise<string> — extracted text, one paragraph per line
//  Summary: .docx files have real paragraph markup, so mammoth.js's raw
//    text extraction is much more reliable than the PDF heuristic above —
//    each Word paragraph comes back on its own line already.
///////////////////////////////////////////////////////////////////////////
async function extractTextFromDocx(arrayBuffer) {
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join("\n\n");
}

///////////////////////////////////////////////////////////////////////////
//  Function: deriveTitleFromText
//  Inputs: text — the full document text
//  Outputs: A short, human-readable title guessed from the first line
//  Summary: Documents aren't given an explicit title on upload, so this
//    takes the first non-empty line (trimmed to a reasonable length) as a
//    stand-in. Good enough for most pasted articles/essays, which tend to
//    open with a title line; imperfect for documents that don't.
///////////////////////////////////////////////////////////////////////////
function deriveTitleFromText(text) {
  const firstLine = text.split("\n").map(l => l.trim()).find(l => l.length > 0) || "Untitled document";
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
}

///////////////////////////////////////////////////////////////////////////
//  Function: createDocumentAndEnterReader
//  Inputs: text, purpose, analysisType
//  Outputs: Loads the document into state, creates its Firestore record,
//    and shows the reader screen
//  Summary: Shared by both the paste-text and file-upload paths, since
//    both need to do the same thing once they have extracted text.
///////////////////////////////////////////////////////////////////////////
async function createDocumentAndEnterReader(text, purpose, analysisType) {
  loadDocument(text, purpose, analysisType);
  state.documentTitle = deriveTitleFromText(text);

  try {
    const docId = await createDocumentRecord(state.currentUser.uid, {
      title: state.documentTitle,
      purpose: state.purpose,
      analysisType: state.analysisType,
      highlightColor: state.highlightColor,
      chunks: state.chunks,
      annotations: [],
      annotationsSummary: null,
      provocations: [],
      lenses: []
    });
    state.currentDocId = docId;
  } catch (err) {
    console.error("NEW DOCUMENT: failed to create Firestore record:", err);
    alert("Couldn't save this as a new document, but you can still read it — Save may not work until this is resolved.");
  }

  resetReaderView();
  renderDocument();
  renderBookmarkList();
  showScreen("reader");
}

//Allows the user to upload a .txt, .pdf, or .docx file instead of pasting text
document.getElementById("file-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById("file-upload-status");
  const extension = file.name.split(".").pop().toLowerCase();

  statusEl.textContent = extension === "pdf" || extension === "docx"
    ? "Reading file..."
    : "";

  let text;
  try {
    if (extension === "txt") {
      text = await file.text();
    } else if (extension === "pdf") {
      const arrayBuffer = await file.arrayBuffer();
      text = await extractTextFromPdf(arrayBuffer);
    } else if (extension === "docx") {
      const arrayBuffer = await file.arrayBuffer();
      text = await extractTextFromDocx(arrayBuffer);
    } else {
      statusEl.textContent = "";
      alert("Unsupported file type. Please upload a .txt, .pdf, or .docx file.");
      return;
    }
  } catch (err) {
    console.error("FILE UPLOAD: failed to extract text:", err);
    statusEl.textContent = "";
    alert("Couldn't read that file. Make sure it's a valid .txt, .pdf, or .docx file — scanned/image-only PDFs aren't supported since they have no embedded text.");
    return;
  }

  statusEl.textContent = "";

  const purpose = document.getElementById("purpose-select").value;
  const analysisType = document.getElementById("analysis-type-select").value;

  // Prevent empty documents (also catches PDFs with no extractable text,
  // e.g. scanned/image-only pages)
  if (!text || !text.trim()) {
    alert("No readable text was found in that file. If it's a scanned or image-only PDF, this tool can't extract text from it — try pasting the text directly instead.");
    return;
  }

  await createDocumentAndEnterReader(text, purpose, analysisType);
});

// Start Reading button
document.getElementById("start-reading").addEventListener("click", async () => {
  const text = document.getElementById("document-input").value;
  const purpose = document.getElementById("purpose-select").value;
  const analysisType = document.getElementById("analysis-type-select").value;

  // Prevent empty documents
  if (!text.trim()) {
    alert("Please paste text or upload a .txt file before continuing.");
    return;
  }

  await createDocumentAndEnterReader(text, purpose, analysisType);
});

// Lets other modules (e.g. lens.js's "Add selection") read what the
// student currently has selected in the document.
function getCurrentSelections() {
  return currentSelections;
}

export { state, renderDocument, getCurrentSelections };