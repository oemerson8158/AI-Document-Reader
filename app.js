///////////////////////////////////////////////////////////////////////////
// app.js
//  Entry point of the AI Document Reader, an interactive reading tool that
//  helps students understand complex documents. It owns the shared state and
//  the reader screen, and wires together the feature modules: annotations,
//  topic lenses, Lexile rephrasing, and AI-generated provocations.
//
//  Sections, in order: state, screens, login, home, sharing (send a copy),
//  upload (file import), document rendering, paragraph icons, sidebar tabs,
//  text selection, annotation tools (highlights, bookmarks, notes), and
//  startup.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

import { addAnnotation, createBookmark, loadAnnotationsUI, copyTextToClipboard } from "./modules/annotations.js";
import { initRephraseUI } from "./modules/rephrase.js";
import {
  initLensUI,
  normalizeLens,
  refreshLensMinimap,
  handleDocumentPaneClick,
  lensHitStyle,
  lensParagraphColor
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
  listUserDocuments,
  SHARE_LIFETIME_DAYS,
  createShareRecord,
  getShareRecord
} from "./modules/firebase.js";

///////////////////////////////////////////////////////////////////////////
// State
///////////////////////////////////////////////////////////////////////////

// The student's current text selection, as [{ paragraphId, startOffset,
// endOffset, text }]. Read by the annotation tools and lens.js.
let currentSelections = [];

// Shared application data. Every module reads and updates this object.
const state = {
  currentUser: null,
  currentDocId: null,
  documentTitle: "",
  purpose: "",
  analysisType: "literary",
  highlightColor: "#ffff00",
  chunks: [],              // the document's paragraphs: [{ id, text }]
  annotations: [],
  annotationsSummary: null,
  provocations: [],
  lenses: [],
  activeLensId: null,      // lens currently applied to the reader, if any
  lensCurrentHitId: null,  // hit last navigated to (for Previous/Next)
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
// Screens
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: showScreen
//  Inputs: screenName — "login", "home", "upload", or "reader"
//  Outputs: Shows that top-level screen and hides the other three
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
// Login screen
//  One form serves both sign-in and account creation, toggled by authMode.
///////////////////////////////////////////////////////////////////////////

let authMode = "signin"; // "signin" | "signup"

///////////////////////////////////////////////////////////////////////////
//  Function: showAuthError
//  Inputs: message (string)
//  Outputs: Shows the message above the login form
///////////////////////////////////////////////////////////////////////////
function showAuthError(message) {
  const errEl = document.getElementById("auth-error");
  errEl.textContent = message;
  errEl.style.display = "block";
}

///////////////////////////////////////////////////////////////////////////
//  Function: clearAuthError
//  Inputs: None
//  Outputs: Hides the login error message
///////////////////////////////////////////////////////////////////////////
function clearAuthError() {
  const errEl = document.getElementById("auth-error");
  errEl.style.display = "none";
  errEl.textContent = "";
}

///////////////////////////////////////////////////////////////////////////
//  Function: setAuthMode
//  Inputs: mode — "signin" or "signup"
//  Outputs: Updates the form's button and toggle text to match
///////////////////////////////////////////////////////////////////////////
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

///////////////////////////////////////////////////////////////////////////
//  Function: friendlyAuthErrorMessage
//  Inputs: err (a Firebase auth error)
//  Outputs: Plain-English text for the error codes a user is likely to hit
///////////////////////////////////////////////////////////////////////////
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
    // onAuthChange (registered at startup) navigates to the home screen.
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
// Home screen
///////////////////////////////////////////////////////////////////////////

// The floating Rename / Delete menu on a document row, if open.
let docMenuEl = null;

///////////////////////////////////////////////////////////////////////////
//  Function: formatRelativeTime
//  Inputs: timestamp (a Firestore Timestamp)
//  Outputs: Text like "5 minutes ago"; a date after 30 days; "" if missing
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
//  Function: closeDocMenu
//  Inputs: None
//  Outputs: Removes the document menu if open
///////////////////////////////////////////////////////////////////////////
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

///////////////////////////////////////////////////////////////////////////
//  Function: openDocMenu
//  Inputs: anchor (the three-dots button), docRecord, itemEl (the row),
//    titleEl (the row's title element)
//  Outputs: Shows a menu with Rename, Make a copy, Send a copy, and Delete
//    under the button, or above it if there's no room below
///////////////////////////////////////////////////////////////////////////
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
  addEntry("Make a copy", "", () => makeCopyOfDocument(docRecord));
  addEntry("Send a copy", "", () => openSendCopyDialog(docRecord));
  addEntry("Delete", "home-doc-menu-danger", () => deleteDocument(docRecord, itemEl));

  document.body.appendChild(menu);
  docMenuEl = menu;

  const rect = anchor.getBoundingClientRect();
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  let top = rect.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = rect.top - menu.offsetHeight - 4;
  menu.style.top = `${Math.max(8, top)}px`;

  renameEntry.focus();
}

///////////////////////////////////////////////////////////////////////////
//  Function: startRenameDocument
//  Inputs: docRecord, titleEl (the row's title element)
//  Outputs: Replaces the title with a text box; Enter or clicking away
//    saves the new name, Escape cancels
//  Summary: Reverts the title if saving to Firestore fails.
///////////////////////////////////////////////////////////////////////////
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

///////////////////////////////////////////////////////////////////////////
//  Function: deleteDocument
//  Inputs: docRecord, itemEl (the row)
//  Outputs: After confirmation, deletes the document and removes its row
///////////////////////////////////////////////////////////////////////////
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

///////////////////////////////////////////////////////////////////////////
//  Function: makeCopyOfDocument
//  Inputs: docRecord (a document from the home list)
//  Outputs: Creates a new document in the student's own account, titled
//    "Copy of <title>", and refreshes the home list
//  Summary: Copies the last saved version, with everything in it: text,
//    highlights, notes, bookmarks, lenses, provocations with their answers,
//    and the annotations summary.
///////////////////////////////////////////////////////////////////////////
async function makeCopyOfDocument(docRecord) {
  const name = docRecord.title || "Untitled document";

  try {
    await createDocumentRecord(state.currentUser.uid, {
      title: `Copy of ${name}`.slice(0, 120),
      purpose: docRecord.purpose || "analysis",
      analysisType: docRecord.analysisType || "literary",
      highlightColor: docRecord.highlightColor || "#ffff00",
      chunks: docRecord.chunks || [],
      annotations: docRecord.annotations || [],
      annotationsSummary: docRecord.annotationsSummary || null,
      provocations: docRecord.provocations || [],
      lenses: docRecord.lenses || []
    });
  } catch (err) {
    console.error("HOME: failed to copy document:", err);
    alert("Couldn't make a copy of that document. Try again in a moment.");
    return;
  }

  loadHomeScreen();
}

///////////////////////////////////////////////////////////////////////////
//  Function: loadHomeScreen
//  Inputs: None
//  Outputs: Fills #home-document-list with the user's documents, most
//    recently edited first
///////////////////////////////////////////////////////////////////////////
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
//  Outputs: Loads the saved record into state and shows the reader
//  Summary: The reverse of saveCurrentDocument().
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

  // The reader must be visible before rendering: icon placement measures
  // where text is drawn, and a hidden screen has no layout.
  showScreen("reader");
  renderDocument();
  renderBookmarkList();
}

///////////////////////////////////////////////////////////////////////////
//  Function: saveCurrentDocument
//  Inputs: None
//  Outputs: Writes the document's saveable state to Firestore
//  Summary: Called by the Save button. Saves only durable content, not
//    transient UI state such as the applied lens or a Rephrase draft.
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
  document.getElementById("document-input").value = "";
  updateCharCount();
  document.getElementById("file-input").value = "";
  document.getElementById("file-upload-status").textContent = "";
  showScreen("upload");
});

///////////////////////////////////////////////////////////////////////////
// Sharing (send a copy)
//  "Send a copy" saves a snapshot of a document as a share record and gives
//  the sender a link (?share=<id>). A signed-in recipient who opens the link
//  can add their own copy to their documents. Nothing is delivered
//  automatically: the sender passes the link on. The copy includes
//  everything in the document's last saved version: the text, highlights,
//  notes, bookmarks, lenses, provocations with the sender's answers, and the
//  annotations summary.
///////////////////////////////////////////////////////////////////////////

// Share id from the URL the app was opened with; handled once signed in.
let pendingShareId = new URLSearchParams(window.location.search).get("share");

// The open dialog's overlay, if any.
let modalEl = null;

///////////////////////////////////////////////////////////////////////////
//  Function: closeModal
//  Inputs: None
//  Outputs: Removes the open dialog, if any
///////////////////////////////////////////////////////////////////////////
function closeModal() {
  if (modalEl) {
    modalEl.remove();
    modalEl = null;
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: openModal
//  Inputs: title (string), contentEl (the dialog's body), actions
//    ([{ label, className, onClick(button) }], shown as a row of buttons)
//  Outputs: Shows a dialog over the page, replacing any open one. Escape or
//    a click outside it closes it.
///////////////////////////////////////////////////////////////////////////
function openModal(title, contentEl, actions) {
  closeModal();

  const overlay = document.createElement("div");
  overlay.id = "modal-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", title);

  const heading = document.createElement("h3");
  heading.className = "modal-title";
  heading.textContent = title;

  const actionRow = document.createElement("div");
  actionRow.className = "modal-actions";
  actions.forEach(({ label, className, onClick }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener("click", () => onClick(btn));
    actionRow.appendChild(btn);
  });

  modal.append(heading, contentEl, actionRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modalEl = overlay;
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

///////////////////////////////////////////////////////////////////////////
//  Function: buildShareUrl
//  Inputs: shareId
//  Outputs: A link to this app carrying the share id
///////////////////////////////////////////////////////////////////////////
function buildShareUrl(shareId) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("share", shareId);
  return url.toString();
}

///////////////////////////////////////////////////////////////////////////
//  Function: openLinkDialog
//  Inputs: url (the share link)
//  Outputs: Shows the finished link with a Copy button
///////////////////////////////////////////////////////////////////////////
function openLinkDialog(url) {
  const content = document.createElement("div");

  const text = document.createElement("p");
  text.className = "modal-text";
  text.textContent = `Send this link to the person you want to share with. They'll need to sign in to add their copy. Anyone who has the link can add a copy, and it stops working after ${SHARE_LIFETIME_DAYS} days.`;

  const row = document.createElement("div");
  row.className = "modal-link-row";

  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.value = url;
  input.className = "modal-link-input";
  input.setAttribute("aria-label", "Share link");
  input.addEventListener("focus", () => input.select());

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn-secondary modal-copy-btn";
  copyBtn.textContent = "Copy";

  let resetTimer = null;
  copyBtn.addEventListener("click", async () => {
    const ok = await copyTextToClipboard(url);
    copyBtn.textContent = ok ? "Copied!" : "Couldn't copy";
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  });

  row.append(input, copyBtn);
  content.append(text, row);

  openModal("Link ready", content, [
    { label: "Done", className: "btn-primary", onClick: closeModal }
  ]);
}

///////////////////////////////////////////////////////////////////////////
//  Function: openSendCopyDialog
//  Inputs: docRecord (a document from the home list)
//  Outputs: Shows the Send a copy dialog; "Create link" saves a snapshot of
//    the document's last saved version and shows its link
//  Summary: The snapshot includes everything saved with the document,
//    including the sender's notes and provocation answers, and the dialog
//    says so.
///////////////////////////////////////////////////////////////////////////
function openSendCopyDialog(docRecord) {
  const name = docRecord.title || "Untitled document";

  const content = document.createElement("div");

  const intro = document.createElement("p");
  intro.className = "modal-text";
  intro.textContent = `Create a link that lets someone add their own copy of "${name}" to their documents. The copy includes everything in the last saved version: the text, your highlights, notes, bookmarks, lenses, provocations, and your answers to them. Your own document isn't changed. Anyone who has the link can add a copy, so only send it to people you trust.`;

  const error = document.createElement("p");
  error.className = "modal-error";

  content.append(intro, error);

  openModal("Send a copy", content, [
    { label: "Cancel", className: "btn-secondary", onClick: closeModal },
    {
      label: "Create link",
      className: "btn-primary",
      onClick: async (btn) => {
        btn.disabled = true;
        btn.textContent = "Creating...";
        error.textContent = "";

        try {
          const shareId = await createShareRecord(state.currentUser.uid, {
            title: name,
            purpose: docRecord.purpose || "analysis",
            analysisType: docRecord.analysisType || "literary",
            highlightColor: docRecord.highlightColor || "#ffff00",
            chunks: docRecord.chunks || [],
            annotations: docRecord.annotations || [],
            annotationsSummary: docRecord.annotationsSummary || null,
            provocations: docRecord.provocations || [],
            lenses: docRecord.lenses || []
          });
          openLinkDialog(buildShareUrl(shareId));
        } catch (err) {
          console.error("SHARE: failed to create share:", err);
          error.textContent = "Couldn't create the link. Try again in a moment.";
          btn.disabled = false;
          btn.textContent = "Create link";
        }
      }
    }
  ]);
}

///////////////////////////////////////////////////////////////////////////
//  Function: handleIncomingShare
//  Inputs: None (reads pendingShareId)
//  Outputs: Looks up the shared document and asks the recipient whether to
//    add a copy; "Add to my documents" creates it under their account and
//    refreshes the home list
//  Summary: The share id is removed from the address bar first, so a page
//    refresh doesn't prompt again. A missing or expired share is refused by
//    the security rules and reported as an invalid or expired link.
///////////////////////////////////////////////////////////////////////////
async function handleIncomingShare() {
  const shareId = pendingShareId;
  pendingShareId = null;
  document.getElementById("auth-share-note").style.display = "none";

  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("share");
  window.history.replaceState({}, "", cleanUrl.toString());

  let share;
  try {
    share = await getShareRecord(shareId);
  } catch (err) {
    console.error("SHARE: failed to open shared document:", err);
    alert(err && err.code === "permission-denied"
      ? "This link is invalid or has expired. Ask the sender for a new one."
      : "Couldn't open that shared document. Check your connection and try the link again.");
    return;
  }

  if (!share) {
    alert("This link is invalid or has expired. Ask the sender for a new one.");
    return;
  }

  const wordCount = (share.chunks || []).reduce(
    (n, c) => n + c.text.split(/\s+/).filter(Boolean).length,
    0
  );
  const purposeLabel = share.purpose === "memorize" ? "Memorize" : "Analysis";
  const hasExtras =
    (share.annotations || []).length > 0 ||
    (share.lenses || []).length > 0 ||
    (share.provocations || []).length > 0;

  const content = document.createElement("div");

  const text = document.createElement("p");
  text.className = "modal-text";
  text.textContent = `"${share.title}" (${purposeLabel}, about ${wordCount.toLocaleString()} words) was shared with you. Add a copy to your documents?` +
    (hasExtras ? " It includes the sender's highlights, notes, bookmarks, lenses, and provocations with their answers." : "");

  const error = document.createElement("p");
  error.className = "modal-error";

  content.append(text, error);

  openModal("Add a shared document", content, [
    { label: "Not now", className: "btn-secondary", onClick: closeModal },
    {
      label: "Add to my documents",
      className: "btn-primary",
      onClick: async (btn) => {
        btn.disabled = true;
        btn.textContent = "Adding...";
        error.textContent = "";

        try {
          await createDocumentRecord(state.currentUser.uid, {
            title: share.title,
            purpose: share.purpose || "analysis",
            analysisType: share.analysisType || "literary",
            highlightColor: share.highlightColor || "#ffff00",
            chunks: share.chunks || [],
            annotations: share.annotations || [],
            annotationsSummary: share.annotationsSummary || null,
            provocations: share.provocations || [],
            lenses: share.lenses || []
          });
          closeModal();
          loadHomeScreen();
        } catch (err) {
          console.error("SHARE: failed to add shared document:", err);
          error.textContent = "Couldn't add that document. Try again in a moment.";
          btn.disabled = false;
          btn.textContent = "Add to my documents";
        }
      }
    }
  ]);
}

///////////////////////////////////////////////////////////////////////////
// Upload screen (paste text or import a file)
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: syncAnalysisTypeVisibility
//  Inputs: None
//  Outputs: Shows the "Analysis Focus" dropdown only when the purpose is
//    Analysis
///////////////////////////////////////////////////////////////////////////
function syncAnalysisTypeVisibility() {
  const purposeSelect = document.getElementById("purpose-select");
  const container = document.getElementById("analysis-type-container");
  if (!purposeSelect || !container) return;
  container.style.display = purposeSelect.value === "analysis" ? "block" : "none";
}

document.getElementById("purpose-select").addEventListener("change", syncAnalysisTypeVisibility);

// Limits on new documents. Long readings take a long time on the free AI tier
// (see worker-sections.js), and a document must fit in one Firestore record.
// File size limits are only a safety net; the real gate is the character
// limit, applied to the text extracted from a file.
const MAX_DOCUMENT_CHARS = 60000;
const MAX_FILE_BYTES = {
  txt: 1 * 1024 * 1024,
  pdf: 10 * 1024 * 1024,
  docx: 10 * 1024 * 1024
};

///////////////////////////////////////////////////////////////////////////
//  Function: approxWords
//  Inputs: chars
//  Outputs: Rough word count (about 6 characters per word), rounded to 100
///////////////////////////////////////////////////////////////////////////
function approxWords(chars) {
  return Math.round(chars / 6 / 100) * 100;
}

///////////////////////////////////////////////////////////////////////////
//  Function: updateCharCount
//  Inputs: None
//  Outputs: Updates the live "N / 60,000 characters" counter under the paste
//    box, turning it red when over the limit
///////////////////////////////////////////////////////////////////////////
function updateCharCount() {
  const countEl = document.getElementById("char-count");
  const length = document.getElementById("document-input").value.trim().length;
  countEl.textContent = `${length.toLocaleString()} / ${MAX_DOCUMENT_CHARS.toLocaleString()} characters`;
  countEl.classList.toggle("char-count-over", length > MAX_DOCUMENT_CHARS);
}

document.getElementById("document-input").addEventListener("input", updateCharCount);

///////////////////////////////////////////////////////////////////////////
//  Function: isWithinLengthLimit
//  Inputs: text (a new document's text)
//  Outputs: true if it fits; otherwise shows a popup and returns false
///////////////////////////////////////////////////////////////////////////
function isWithinLengthLimit(text) {
  const length = text.trim().length;
  if (length <= MAX_DOCUMENT_CHARS) return true;

  alert(
    `This document is about ${approxWords(length).toLocaleString()} words ` +
    `(${length.toLocaleString()} characters), which is over the limit of about ` +
    `${approxWords(MAX_DOCUMENT_CHARS).toLocaleString()} words ` +
    `(${MAX_DOCUMENT_CHARS.toLocaleString()} characters). Try a shorter document, ` +
    `or paste in just the section you want to work with.`
  );
  return false;
}

///////////////////////////////////////////////////////////////////////////
//  Function: extractTextFromPdf
//  Inputs: arrayBuffer — raw bytes of a .pdf file
//  Outputs: Promise<string> — the text, with paragraphs separated by blank
//    lines
//  Summary: pdf.js only gives positioned text runs, so runs are grouped into
//    lines by y-position, and a paragraph break is inserted wherever the gap
//    between lines is well above the page's typical line spacing. Four
//    heuristics clean up common extraction artifacts:
//      1. Hyphens at line wraps ("mathe-" + "matics") are rejoined.
//      2. Footnote-marker digits are dropped (small pure-digit items).
//      3. Running headers, footers, and page numbers repeating across pages
//         are removed.
//      4. Drop caps split into their own run ("T he term") are merged back.
//    Multi-column layouts and tables may still need manual cleanup, and
//    scanned (image-only) PDFs have no text to extract.
///////////////////////////////////////////////////////////////////////////
async function extractTextFromPdf(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  // One entry per paragraph, tagged with its page and whether it was the
  // first or last on that page (used by header/footer detection, fix 3).
  const allEntries = [];

  // Fix 1
  function joinLine(paragraph, nextLineText) {
    const trimmedCurrent = paragraph.replace(/\s+$/, "");
    if (/[a-z]-$/.test(trimmedCurrent) && /^[a-z]/.test(nextLineText.trimStart())) {
      return trimmedCurrent.slice(0, -1) + nextLineText.trimStart();
    }
    return paragraph + " " + nextLineText;
  }

  // Fix 4: a capital, a space, then a lowercase letter at the start of a
  // paragraph is almost never real English.
  function fixDropCap(text) {
    return text.replace(/^([A-Z]) ([a-z])/, "$1$2");
  }

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Fix 2: footnote markers are small superscript digits, so compare each
    // item's height with the page's dominant text height.
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

    // Group items into lines by shared baseline y-position.
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

    // A gap well above the median line spacing marks a paragraph break.
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

  // Fix 3: only paragraphs at the very start or end of a page are header or
  // footer candidates, so repeated body text is never removed. Leading and
  // trailing digits are stripped before comparing, so "2 journal of world
  // history" and "3 journal of world history" match.
  function normalizeForRepeatDetection(text) {
    return text
      .toLowerCase()
      .replace(/^\d+\s*/, "")
      .replace(/\s*\d+$/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const edgePageSets = new Map(); // normalized text -> pages it appeared on
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
//  Inputs: arrayBuffer — raw bytes of a .docx file
//  Outputs: Promise<string> — the text, with paragraphs separated by blank
//    lines
//  Summary: .docx has real paragraph markup, so mammoth.js is far more
//    reliable than the PDF heuristics.
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
//  Outputs: A title taken from the first non-empty line, trimmed to 80
//    characters
//  Summary: Documents aren't titled on upload. This suits articles and
//    essays that open with a title line, and is imperfect otherwise.
///////////////////////////////////////////////////////////////////////////
function deriveTitleFromText(text) {
  const firstLine = text.split("\n").map(l => l.trim()).find(l => l.length > 0) || "Untitled document";
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
}

///////////////////////////////////////////////////////////////////////////
//  Function: createDocumentAndEnterReader
//  Inputs: text, purpose, analysisType
//  Outputs: Loads the document into state, creates its Firestore record,
//    and shows the reader
//  Summary: Shared by the paste-text and file-upload paths. Text over the
//    length limit is rejected first, before anything is created. If the
//    record can't be created, the student can still read, but Save won't work.
///////////////////////////////////////////////////////////////////////////
async function createDocumentAndEnterReader(text, purpose, analysisType) {
  if (!isWithinLengthLimit(text)) return;

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

  // The reader must be visible before rendering: icon placement measures
  // where text is drawn, and a hidden screen has no layout.
  showScreen("reader");
  renderDocument();
  renderBookmarkList();
}

document.getElementById("file-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById("file-upload-status");
  const extension = file.name.split(".").pop().toLowerCase();

  const maxBytes = MAX_FILE_BYTES[extension];
  if (maxBytes && file.size > maxBytes) {
    const toMb = bytes => (bytes / (1024 * 1024)).toFixed(1);
    statusEl.textContent = "";
    event.target.value = ""; // so the same file can be chosen again later
    alert(`That file is ${toMb(file.size)} MB, which is over the ${toMb(maxBytes)} MB limit for .${extension} files. Try a smaller file, or paste in just the section you want to work with.`);
    return;
  }

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

  // Also catches scanned PDFs, which have no extractable text.
  if (!text || !text.trim()) {
    alert("No readable text was found in that file. If it's a scanned or image-only PDF, this tool can't extract text from it — try pasting the text directly instead.");
    return;
  }

  await createDocumentAndEnterReader(text, purpose, analysisType);
});

document.getElementById("start-reading").addEventListener("click", async () => {
  const text = document.getElementById("document-input").value;
  const purpose = document.getElementById("purpose-select").value;
  const analysisType = document.getElementById("analysis-type-select").value;

  if (!text.trim()) {
    alert("Please paste text or upload a .txt file before continuing.");
    return;
  }

  await createDocumentAndEnterReader(text, purpose, analysisType);
});

///////////////////////////////////////////////////////////////////////////
// Document loading and rendering
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: loadDocument
//  Inputs: text, purpose ("analysis" | "memorize"), analysisType
//  Outputs: Resets the per-document state, then stores the purpose and
//    splits the text into paragraph chunks
//  Summary: The chunks are the structural base for lenses, provocations,
//    annotations, and rephrasing. Starting from a clean slate stops
//    annotations, lenses, and provocations of the previously open document
//    carrying over (and getting saved) into this one.
///////////////////////////////////////////////////////////////////////////
function loadDocument(text, purpose, analysisType) {
  state.currentDocId = null;
  state.annotations = [];
  state.annotationsSummary = null;
  state.provocations = [];
  state.lenses = [];
  state.activeLensId = null;
  state.lensCurrentHitId = null;
  resetTransientState();

  state.purpose = purpose;
  state.analysisType = purpose === "analysis" ? (analysisType || "literary") : "literary";

  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  // Every blank line or single newline starts a new paragraph.
  const paragraphs = normalized
    .split(/\n\s*\n|\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  state.chunks = paragraphs.map((p, i) => ({
    id: i,
    text: p
  }));
}

///////////////////////////////////////////////////////////////////////////
//  Function: getParagraph
//  Inputs: id (a paragraph id)
//  Outputs: The matching chunk, or undefined
///////////////////////////////////////////////////////////////////////////
function getParagraph(id) {
  return state.chunks.find(chunk => chunk.id === id);
}

///////////////////////////////////////////////////////////////////////////
//  Function: escapeHtml
//  Inputs: str
//  Outputs: The string with &, <, >, and " escaped
//  Summary: Document text is untrusted, so it must be escaped before going
//    into innerHTML.
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
//  Inputs: text (the paragraph), highlights (the student's highlight
//    annotations), lensHits (hits from the applied lens), lens
//  Outputs: An HTML string for the paragraph
//  Summary: Highlights and lens hits can overlap in any way, so the text is
//    cut at every boundary any of them has, and each piece is styled by
//    whichever highlight and/or lens hit covers it. The lens shading is the
//    outer span and the highlight the inner one, so both stay visible.
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

    // Where lens hits overlap, a strong one wins over a partial one.
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
//  Inputs: None (reads state.chunks and the annotations, provocations, and
//    applied lens)
//  Outputs: Rebuilds #document-pane with one <p> per chunk (data-id is the
//    chunk id), plus highlights, lens shading, and note, provocation, and
//    bookmark icons
//  Summary: Rebuilding resets scrolling, so the scroll position is restored.
///////////////////////////////////////////////////////////////////////////
function renderDocument() {
  const pane = document.getElementById("document-pane");
  const savedScroll = pane.scrollTop;
  pane.innerHTML = "";

  const activeLens = state.lenses.find(l => l.id === state.activeLensId) || null;

  state.chunks.forEach(chunk => {
    const p = document.createElement("p");
    p.dataset.id = chunk.id;

    // Highlights and lens hits are drawn as spans over the text; a paragraph
    // with neither stays plain text.
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

    // A paragraph containing a lens hit gets a light wash of the lens color,
    // lighter than the partial-match shade.
    if (activeLens && lensHits.length > 0) {
      p.classList.add("lens-paragraph");
      p.style.backgroundColor = lensParagraphColor(activeLens.color);
    }

    // Green for an incorrectly answered provocation; takes priority over the
    // lens wash.
    const provForParagraph = state.provocations.filter(
      prov => prov.paragraphId === chunk.id && prov.status === "incorrect"
    );

    if (provForParagraph.length > 0) {
      p.style.backgroundColor = "#b7ff8f";
      p.dataset.provIncorrect = "1"; // lets lens.js skip this paragraph when recoloring
    }

    // Note icons
    const notes = state.annotations.filter(a =>
      a.paragraphId === chunk.id && a.type === "note"
    );

    notes.forEach(note => {
      const icon = document.createElement("span");
      icon.classList.add("note-icon");
      icon.dataset.noteId = note.id;
      icon.dataset.startOffset = note.startOffset; // used to place the icon beside its selection
      icon.textContent = "📝";

      icon.addEventListener("click", (event) => {
        event.stopPropagation();
        showNotePopup(note, icon);
      });

      p.appendChild(icon);
    });

    // Provocation icons
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
// Paragraph icons
//  Note, provocation, and bookmark icons are added by separate code, so none
//  knows where the others sit. layoutParagraphIcons() runs last and places
//  them all.
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: getTextOffsetTop
//  Inputs: p (paragraph element), charOffset (index into the paragraph's
//    real text), icon (the icon being placed)
//  Outputs: Distance in px from the paragraph's top edge to the line holding
//    the character at charOffset, adjusted to center the icon on that line
//  Summary: Walks the paragraph's text nodes (skipping icon emoji) and
//    measures where the character is drawn. Highlight and lens spans split
//    the text into several nodes, so the offset is counted across all of them.
///////////////////////////////////////////////////////////////////////////
function getTextOffsetTop(p, charOffset, icon) {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
    acceptNode: node =>
      node.parentElement.closest(".note-icon, .provocation-icon, .bookmark-icon")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
  });

  let remaining = charOffset;
  let node = null;
  let last = null;
  while ((node = walker.nextNode())) {
    last = node;
    if (remaining < node.length) break;
    remaining -= node.length;
    node = null;
  }

  const target = node || last;
  if (!target || target.length === 0) return 0;

  const start = node ? remaining : target.length - 1;
  const range = document.createRange();
  range.setStart(target, start);
  range.setEnd(target, start + 1);

  const rect = range.getClientRects()[0];
  if (!rect) return 0;

  const centering = Math.max(0, ((icon.offsetHeight || rect.height) - rect.height) / 2);
  return Math.max(0, rect.top - p.getBoundingClientRect().top - centering);
}

///////////////////////////////////////////////////////////////////////////
//  Function: layoutParagraphIcons
//  Inputs: None
//  Outputs: Positions every icon in the document pane and sizes each
//    paragraph's right-hand gutter to fit its icons
//  Summary: Icons line up right to left along the paragraph's right edge.
//    Note and bookmark icons sit beside the first line of the text they were
//    created from; provocation icons stay at the top, since they belong to
//    the whole paragraph. Done in three passes (size gutters, measure,
//    position) so the browser lays out once, not once per paragraph.
///////////////////////////////////////////////////////////////////////////
function layoutParagraphIcons() {
  const pane = document.getElementById("document-pane");
  if (!pane) return;
  const paragraphs = Array.from(pane.querySelectorAll("p"));

  const ICON_STEP_PX = 22;   // horizontal spacing between icons
  const BASE_GUTTER_PX = 24; // gutter width for 0-1 icons

  // Pass 1: gutters first, since their width changes how paragraphs wrap.
  const layouts = paragraphs.map(p => {
    const icons = Array.from(
      p.querySelectorAll(".note-icon, .provocation-icon, .bookmark-icon")
    );
    const neededWidth = icons.length * ICON_STEP_PX + 4;
    p.style.paddingRight = `${Math.max(BASE_GUTTER_PX, neededWidth)}px`;
    return { p, icons };
  });

  // Pass 2: measure.
  layouts.forEach(layout => {
    layout.tops = layout.icons.map(icon => {
      if (icon.classList.contains("provocation-icon")) return 0;
      if (icon.dataset.startOffset === undefined) return 0;
      return getTextOffsetTop(layout.p, Number(icon.dataset.startOffset), icon);
    });
  });

  // Pass 3: position.
  layouts.forEach(({ icons, tops }) => {
    icons.forEach((icon, index) => {
      icon.style.position = "absolute";
      icon.style.top = `${tops[index]}px`;
      icon.style.right = `${index * ICON_STEP_PX}px`;
    });
  });

  // New gutters can change wrapping, which moves every lens hit, so the
  // minimap is refreshed once layout has settled.
  refreshLensMinimap();
}

// Resizing re-wraps paragraphs, which moves the selected lines.
window.addEventListener("resize", layoutParagraphIcons);

///////////////////////////////////////////////////////////////////////////
// Sidebar tabs
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: setupTabs
//  Inputs: None
//  Outputs: Wires up tab switching in the sidebar
//  Summary: Highlights the clicked tab, points the "?" button at its
//    tutorial, and loads that tab's UI. The annotation tools show only on
//    the Annotations tab. Called once at startup, since the tab buttons are
//    static HTML.
///////////////////////////////////////////////////////////////////////////
function setupTabs() {
  const tabs = document.querySelectorAll("#tool-tabs button");
  const content = document.getElementById("tool-content");
  const annotationTools = document.getElementById("annotation-tools");

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      setHelpTab(tab.dataset.tab);

      content.innerHTML = "";

      if (tab.dataset.tab === "annotations") {
        annotationTools.style.display = "block";
        loadAnnotationsUI();
      } else {
        annotationTools.style.display = "none";
      }

      if (tab.dataset.tab === "rephrase") {
        loadRephraseUI();
        return;
      }

      if (tab.dataset.tab === "lenses") {
        loadLensesUI();
        return;
      }

      if (tab.dataset.tab === "provocations") {
        loadProvocationsUI();
        return;
      }
    });
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: resetReaderView
//  Inputs: None
//  Outputs: Puts the reader's chrome back to a blank start: no active tab,
//    empty sidebar, annotation tools hidden, popups closed, document
//    scrolled to the top
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
//  Inputs: None
//  Outputs: Clears the current selection and the Rephrase draft
//  Summary: Stops working state of one document leaking into the next.
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
//  Outputs: Injects the Rephrase tab into #tool-content and wires it to
//    initRephraseUI
//  Summary: The "Include an example" checkbox appears only in Memorize mode.
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

      // Grow the box to fit its content.
      box.style.height = "auto";
      box.style.height = box.scrollHeight + "px";
    }
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: loadLensesUI
//  Inputs: None
//  Outputs: Loads the Lenses tab (all lens logic lives in lens.js)
///////////////////////////////////////////////////////////////////////////
function loadLensesUI() {
  initLensUI();
}

///////////////////////////////////////////////////////////////////////////
// Text selection
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: captureSelection
//  Inputs: None
//  Outputs: Fills currentSelections with a paragraph id and offsets for each
//    paragraph the selection touches, and stores the selected text for the
//    Rephrase tool
///////////////////////////////////////////////////////////////////////////
function captureSelection() {
  const sel = window.getSelection();
  currentSelections = [];

  if (state.chunks.length === 0) return;
  if (!sel || sel.isCollapsed) return;

  const range = sel.getRangeAt(0);
  const selectedText = sel.toString().trim();
  if (!selectedText) return;

  const paragraphs = Array.from(document.querySelectorAll("#document-pane p"));
  if (paragraphs.length === 0) return;

  paragraphs.forEach(p => {
    const paragraphRange = document.createRange();
    paragraphRange.selectNodeContents(p);

    // Comparing ranges can throw if they don't share a root.
    try {
      const intersects =
        range.compareBoundaryPoints(Range.END_TO_START, paragraphRange) < 0 &&
        range.compareBoundaryPoints(Range.START_TO_END, paragraphRange) > 0;

      if (!intersects) return;
    } catch (e) {
      return;
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

    // Measure against the chunk's real text: the DOM text also includes the
    // icon emoji appended to the paragraph.
    const paragraphId = parseInt(p.dataset.id, 10);
    const chunkText = getParagraph(paragraphId)?.text ?? p.textContent;

    if (startOffset === null) startOffset = 0;
    if (endOffset === null) endOffset = chunkText.length;
    startOffset = Math.min(startOffset, chunkText.length);
    endOffset = Math.min(endOffset, chunkText.length);
    if (endOffset <= startOffset) return; // the selection only touched an icon

    currentSelections.push({
      paragraphId,
      startOffset,
      endOffset,
      text: chunkText.slice(startOffset, endOffset)
    });
  });

  state.rephrase = state.rephrase || {};
  state.rephrase.selectedText = selectedText;
  state.rephrase.selectedParagraphIds = currentSelections.map(sel => sel.paragraphId);
  // The paragraphs array is what the worker's /rephrase route receives.
  state.rephrase.paragraphs = currentSelections.map(sel => sel.text);
}

///////////////////////////////////////////////////////////////////////////
//  Function: getCurrentSelections
//  Inputs: None
//  Outputs: The student's current selection (see currentSelections)
//  Summary: Lets other modules, e.g. lens.js's "Add selection", read it.
///////////////////////////////////////////////////////////////////////////
function getCurrentSelections() {
  return currentSelections;
}

// A click on a lens-highlighted sentence shows why it matched.
document.getElementById("document-pane").addEventListener("click", handleDocumentPaneClick);

document.getElementById("document-pane").addEventListener("mouseup", () => {
  if (state.chunks.length === 0) return;
  captureSelection();
});

// Touch and keyboard selections never fire "mouseup", so two more listeners
// cover them:
//  - "selectionchange" fires whenever the selection moves, however it was
//    made. It fires many times while a handle is dragged, so it's debounced.
//    It only captures a non-empty selection inside the document pane and
//    never clears one: on iPadOS, tapping a sidebar button (Highlight,
//    Bookmark...) can collapse the selection before the click lands, and
//    clearing would make the button do nothing.
//  - A tap (touchend) in the pane re-reads the selection after a short
//    delay, like mouseup does for a click.
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
// Annotation tools: highlights
///////////////////////////////////////////////////////////////////////////

document.getElementById("highlight-color").addEventListener("input", (e) => {
  state.highlightColor = e.target.value;
});

document.getElementById("btn-highlight").addEventListener("click", () => {
  if (currentSelections.length === 0) return;

  currentSelections.forEach(sel => {
    addAnnotation("highlight", sel, { color: state.highlightColor });
  });

  renderDocument();
});

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

///////////////////////////////////////////////////////////////////////////
// Annotation tools: bookmarks
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: renderBookmarkList
//  Inputs: None
//  Outputs: Fills the sidebar's #bookmark-items with one button per
//    bookmark; clicking one jumps to it
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
//  Outputs: Places a 🔖 icon on each bookmarked paragraph, then lays out all
//    paragraph icons
//  Summary: Several call sites call this directly, instead of the full
//    renderDocument(), when only bookmarks changed. Re-running
//    layoutParagraphIcons() here keeps the icons from overlapping those of
//    notes and provocations on the same paragraph.
///////////////////////////////////////////////////////////////////////////
function renderBookmarkIcons() {
  const pane = document.getElementById("document-pane");
  const paragraphs = pane.querySelectorAll("p");

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
    icon.dataset.startOffset = b.startOffset; // used to place the icon beside its selection

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
//  Inputs: bookmark ({ paragraphId, startOffset })
//  Outputs: Smoothly scrolls the document pane to the bookmarked text
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
//  Inputs: bookmark, icon (the clicked 🔖 element)
//  Outputs: Shows the popup, with the bookmark's name and Edit/Delete/Close
//    buttons, next to the icon
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

document.getElementById("btn-bookmark").addEventListener("click", () => {
  if (!currentSelections || currentSelections.length === 0) {
    return;
  }

  // Only one of the bookmark and note inputs is open at a time.
  document.getElementById("note-input-container").style.display = "none";
  document.getElementById("bookmark-input-container").style.display = "flex";
});

// Enter: creates a new bookmark, or saves an edit if editingId is set.
document.getElementById("bookmark-submit").addEventListener("click", () => {
  const container = document.getElementById("bookmark-input-container");
  const input = document.getElementById("bookmark-input");
  const name = input.value.trim();

  if (!name) {
    return;
  }

  if (container.dataset.editingId) {
    const bookmark = state.annotations.find(a => a.id === container.dataset.editingId);
    if (bookmark) {
      bookmark.name = name;
    }

    delete container.dataset.editingId;

    input.value = "";
    container.style.display = "none";

    renderBookmarkList();
    renderBookmarkIcons();
    return;
  }

  if (!currentSelections || currentSelections.length === 0) return;

  createBookmark(name, currentSelections[0]);

  input.value = "";
  container.style.display = "none";

  renderBookmarkList();
  renderBookmarkIcons();
});

document.getElementById("bookmark-cancel").addEventListener("click", () => {
  const container = document.getElementById("bookmark-input-container");
  const input = document.getElementById("bookmark-input");

  input.value = "";
  delete container.dataset.editingId;
  container.style.display = "none";
});

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

document.getElementById("bookmark-close").addEventListener("click", () => {
  document.getElementById("bookmark-popup").style.display = "none";
});

document.getElementById("bookmark-delete").addEventListener("click", () => {
  const popup = document.getElementById("bookmark-popup");

  state.annotations = state.annotations.filter(a => a.id !== popup.dataset.id);

  popup.style.display = "none";
  renderBookmarkList();
  renderBookmarkIcons();
});

document.getElementById("bookmark-edit").addEventListener("click", () => {
  const popup = document.getElementById("bookmark-popup");
  const id = popup.dataset.id;

  const bookmark = state.annotations.find(a => a.id === id);
  if (!bookmark) return;

  popup.style.display = "none";

  // Reuse the bookmark input box, pre-filled, in edit mode.
  const container = document.getElementById("bookmark-input-container");
  container.style.display = "flex";
  document.getElementById("bookmark-input").value = bookmark.name;
  container.dataset.editingId = id;
});

///////////////////////////////////////////////////////////////////////////
// Annotation tools: notes
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: showNotePopup
//  Inputs: note ({ id, noteText, ... }), iconElement (the clicked 📝)
//  Outputs: Shows #note-popup in the sidebar, level with the icon, with the
//    note's text and Edit/Delete/Close buttons
//  Summary: Display only; editing and deleting are handled by the buttons'
//    own listeners below.
///////////////////////////////////////////////////////////////////////////
function showNotePopup(note, iconElement) {
  const popup = document.getElementById("note-popup");
  const text = document.getElementById("note-popup-text");

  text.textContent = note.noteText;
  popup.dataset.noteId = note.id;

  const iconRect = iconElement.getBoundingClientRect();
  const sidebar = document.getElementById("tool-pane");
  const sidebarRect = sidebar.getBoundingClientRect();

  // Inside the sidebar, so the popup uses the sidebar's coordinate system.
  if (popup.parentElement !== sidebar) {
    sidebar.appendChild(popup);
  }

  const topOffset = iconRect.top - sidebarRect.top + sidebar.scrollTop;
  const leftOffset = 5;

  popup.style.position = "absolute";
  popup.style.left = `${leftOffset}px`;
  popup.style.top = `${topOffset}px`;

  popup.style.display = "block";
}

document.getElementById("btn-add-note").addEventListener("click", () => {
  if (currentSelections.length === 0) {
    return;
  }

  // Only one of the bookmark and note inputs is open at a time.
  document.getElementById("bookmark-input-container").style.display = "none";

  delete document.getElementById("note-input-container").dataset.editingId;
  document.getElementById("note-input-container").style.display = "flex";
  document.getElementById("note-input").value = "";
});

// Enter: creates a new note, or saves an edit if editingId is set.
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
    // A note attaches only to the first selected paragraph.
    const firstSelection = currentSelections[0];
    if (firstSelection) {
      addAnnotation("note", firstSelection, { noteText });
    }
  }

  container.style.display = "none";
  renderDocument();
});

document.getElementById("note-cancel").addEventListener("click", () => {
  const container = document.getElementById("note-input-container");
  document.getElementById("note-input").value = "";
  delete container.dataset.editingId;
  container.style.display = "none";
});

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

document.getElementById("note-delete").addEventListener("click", () => {
  const popup = document.getElementById("note-popup");

  state.annotations = state.annotations.filter(a => a.id !== popup.dataset.noteId);

  popup.style.display = "none";
  renderDocument();
});

document.getElementById("note-close").addEventListener("click", () => {
  document.getElementById("note-popup").style.display = "none";
});

///////////////////////////////////////////////////////////////////////////
// Startup
///////////////////////////////////////////////////////////////////////////

syncAnalysisTypeVisibility();
updateCharCount();
setupTabs();

// A share link opened while signed out: tell the student why they're being
// asked to sign in.
if (pendingShareId) {
  document.getElementById("auth-share-note").style.display = "block";
}

// Drives which screen shows on load and after login or logout.
onAuthChange((user) => {
  state.currentUser = user;
  if (user) {
    showScreen("home");
    loadHomeScreen();
    if (pendingShareId) handleIncomingShare();
  } else {
    showScreen("login");
  }
});

export { state, renderDocument, getCurrentSelections };