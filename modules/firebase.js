///////////////////////////////////////////////////////////////////////////
// firebase.js
//  Initializes Firebase (Auth + Firestore) and exposes small, purpose-built
//  helper functions for the rest of the app. Nothing outside this file
//  should import directly from the Firebase SDK — every other module goes
//  through these helpers, so if the underlying SDK version or API ever
//  changes, this is the only file that needs to change.
//
//  Loaded via Firebase's CDN-hosted ES modules (gstatic), matching this
//  project's existing no-bundler, plain-<script type="module"> setup —
//  there's no npm/webpack step, so the "npm install firebase" version of
//  the setup snippet from the Firebase console doesn't apply here.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// Values from Firebase Console → Project Settings → General → "Your apps".
// This is a public client identifier, not a secret — security comes from
// Firestore security rules and the Auth providers enabled in the console,
// not from hiding this config.
const firebaseConfig = {
  apiKey: "AIzaSyBmXd1hBW_pMIYG2QqGvyB9SkabHuGny3Y",
  authDomain: "ai-document-reader-901ba.firebaseapp.com",
  projectId: "ai-document-reader-901ba",
  storageBucket: "ai-document-reader-901ba.firebasestorage.app",
  messagingSenderId: "885098590654",
  appId: "1:885098590654:web:925af3e13b56992d0509ef",
  measurementId: "G-V6GTNBWFY9"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

///////////////////////////////////////////////////////////////////////////
// Auth helpers
///////////////////////////////////////////////////////////////////////////

async function signUpEmail(email, password) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  return credential.user;
}

async function signInEmail(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

async function signInGoogle() {
  const provider = new GoogleAuthProvider();
  const credential = await signInWithPopup(auth, provider);
  return credential.user;
}

function signOutUser() {
  return signOut(auth);
}

// Calls callback(user) immediately with the current auth state, and again
// every time it changes (login, logout, token refresh). user is null when
// signed out.
function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

///////////////////////////////////////////////////////////////////////////
// Firestore document helpers
//  Each user's documents live in a flat "documents" collection, with an
//  ownerId field identifying who it belongs to. Firestore security rules
//  (set up separately in the console) are what actually enforce that a
//  user can only read/write their own documents — these helpers don't
//  enforce that themselves, they rely on the rules.
///////////////////////////////////////////////////////////////////////////

const DOCUMENTS_COLLECTION = "documents";

// Creates a new document record and returns its generated id.
async function createDocumentRecord(ownerId, data) {
  const ref = await addDoc(collection(db, DOCUMENTS_COLLECTION), {
    ownerId,
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return ref.id;
}

// Overwrites the saved fields of an existing document record (used by the
// Save button). Does NOT touch ownerId or createdAt.
async function saveDocumentRecord(docId, data) {
  await setDoc(
    doc(db, DOCUMENTS_COLLECTION, docId),
    { ...data, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

// Changes only the title of an existing document record (used by the home
// screen's Rename). Deliberately leaves updatedAt alone, so renaming doesn't
// reorder the list or change its "Edited ..." time.
async function renameDocumentRecord(docId, title) {
  await updateDoc(doc(db, DOCUMENTS_COLLECTION, docId), { title });
}

// Permanently deletes a document record (used by the home screen's Delete).
async function deleteDocumentRecord(docId) {
  await deleteDoc(doc(db, DOCUMENTS_COLLECTION, docId));
}

// Fetches one document record by id. Returns null if it doesn't exist.
async function getDocumentRecord(docId) {
  const snap = await getDoc(doc(db, DOCUMENTS_COLLECTION, docId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

// Lists all document records owned by the given user, most recently
// updated first — used to populate the home screen.
async function listUserDocuments(ownerId) {
  const q = query(
    collection(db, DOCUMENTS_COLLECTION),
    where("ownerId", "==", ownerId),
    orderBy("updatedAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export {
  auth,
  signUpEmail,
  signInEmail,
  signInGoogle,
  signOutUser,
  onAuthChange,
  createDocumentRecord,
  saveDocumentRecord,
  renameDocumentRecord,
  deleteDocumentRecord,
  getDocumentRecord,
  listUserDocuments
};