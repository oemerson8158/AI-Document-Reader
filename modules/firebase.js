///////////////////////////////////////////////////////////////////////////
// firebase.js
//  Initializes Firebase (Auth + Firestore) and exposes small helper
//  functions for the rest of the app. Nothing outside this file imports
//  from the Firebase SDK directly, so an SDK change only touches this file.
//
//  The SDK is loaded from Firebase's CDN as ES modules (the project has no
//  bundler).
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
  serverTimestamp,
  Timestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// A public client identifier, not a secret. Security comes from the
// Firestore security rules and the Auth providers enabled in the console.
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

///////////////////////////////////////////////////////////////////////////
//  Function: signUpEmail
//  Inputs: email, password
//  Outputs: Promise<User> — the newly created user
///////////////////////////////////////////////////////////////////////////
async function signUpEmail(email, password) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  return credential.user;
}

///////////////////////////////////////////////////////////////////////////
//  Function: signInEmail
//  Inputs: email, password
//  Outputs: Promise<User> — the signed-in user
///////////////////////////////////////////////////////////////////////////
async function signInEmail(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

///////////////////////////////////////////////////////////////////////////
//  Function: signInGoogle
//  Inputs: None
//  Outputs: Promise<User> — the signed-in user
//  Summary: Signs in through a Google popup.
///////////////////////////////////////////////////////////////////////////
async function signInGoogle() {
  const provider = new GoogleAuthProvider();
  const credential = await signInWithPopup(auth, provider);
  return credential.user;
}

///////////////////////////////////////////////////////////////////////////
//  Function: signOutUser
//  Inputs: None
//  Outputs: Promise — resolves when signed out
///////////////////////////////////////////////////////////////////////////
function signOutUser() {
  return signOut(auth);
}

///////////////////////////////////////////////////////////////////////////
//  Function: onAuthChange
//  Inputs: callback(user) — user is null when signed out
//  Outputs: Returns the unsubscribe function
//  Summary: Calls the callback immediately with the current auth state and
//    again on every change (login, logout, token refresh).
///////////////////////////////////////////////////////////////////////////
function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

///////////////////////////////////////////////////////////////////////////
// Firestore document helpers
//  Every user's documents live in one flat "documents" collection, each
//  with an ownerId field. These helpers don't check ownership themselves;
//  the Firestore security rules (set in the console) enforce that a user
//  can only read and write their own documents.
///////////////////////////////////////////////////////////////////////////

const DOCUMENTS_COLLECTION = "documents";

///////////////////////////////////////////////////////////////////////////
//  Function: createDocumentRecord
//  Inputs: ownerId (user uid), data (the document's fields)
//  Outputs: Promise<string> — the new document's id
///////////////////////////////////////////////////////////////////////////
async function createDocumentRecord(ownerId, data) {
  const ref = await addDoc(collection(db, DOCUMENTS_COLLECTION), {
    ownerId,
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return ref.id;
}

///////////////////////////////////////////////////////////////////////////
//  Function: saveDocumentRecord
//  Inputs: docId, data (the fields to save)
//  Outputs: Promise — resolves when saved
//  Summary: Used by the Save button. Updates updatedAt; leaves ownerId and
//    createdAt alone.
///////////////////////////////////////////////////////////////////////////
async function saveDocumentRecord(docId, data) {
  await setDoc(
    doc(db, DOCUMENTS_COLLECTION, docId),
    { ...data, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

///////////////////////////////////////////////////////////////////////////
//  Function: renameDocumentRecord
//  Inputs: docId, title
//  Outputs: Promise — resolves when renamed
//  Summary: Changes only the title, leaving updatedAt alone so renaming
//    doesn't reorder the home screen list.
///////////////////////////////////////////////////////////////////////////
async function renameDocumentRecord(docId, title) {
  await updateDoc(doc(db, DOCUMENTS_COLLECTION, docId), { title });
}

///////////////////////////////////////////////////////////////////////////
//  Function: deleteDocumentRecord
//  Inputs: docId
//  Outputs: Promise — resolves when permanently deleted
///////////////////////////////////////////////////////////////////////////
async function deleteDocumentRecord(docId) {
  await deleteDoc(doc(db, DOCUMENTS_COLLECTION, docId));
}

///////////////////////////////////////////////////////////////////////////
//  Function: getDocumentRecord
//  Inputs: docId
//  Outputs: Promise<object | null> — { id, ...fields }, or null if the
//    document doesn't exist
///////////////////////////////////////////////////////////////////////////
async function getDocumentRecord(docId) {
  const snap = await getDoc(doc(db, DOCUMENTS_COLLECTION, docId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

///////////////////////////////////////////////////////////////////////////
//  Function: listUserDocuments
//  Inputs: ownerId (user uid)
//  Outputs: Promise<object[]> — the user's documents, most recently
//    updated first
//  Summary: Populates the home screen.
///////////////////////////////////////////////////////////////////////////
async function listUserDocuments(ownerId) {
  const q = query(
    collection(db, DOCUMENTS_COLLECTION),
    where("ownerId", "==", ownerId),
    orderBy("updatedAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

///////////////////////////////////////////////////////////////////////////
// Share helpers ("Send a copy")
//  A share is a snapshot of a document, stored under a random id that works
//  as the link's secret. The security rules let any signed-in user read one
//  share if they know its id (and it hasn't expired), but never list them.
///////////////////////////////////////////////////////////////////////////

const SHARES_COLLECTION = "shares";
const SHARE_LIFETIME_DAYS = 30;

///////////////////////////////////////////////////////////////////////////
//  Function: createShareRecord
//  Inputs: ownerId (sender's uid), data (the snapshot's fields)
//  Outputs: Promise<string> — the new share's id
//  Summary: Stamps the share with an expiry date, after which the security
//    rules stop allowing it to be read.
///////////////////////////////////////////////////////////////////////////
async function createShareRecord(ownerId, data) {
  const expiresAt = Timestamp.fromDate(
    new Date(Date.now() + SHARE_LIFETIME_DAYS * 24 * 60 * 60 * 1000)
  );
  const ref = await addDoc(collection(db, SHARES_COLLECTION), {
    ownerId,
    ...data,
    createdAt: serverTimestamp(),
    expiresAt
  });
  return ref.id;
}

///////////////////////////////////////////////////////////////////////////
//  Function: getShareRecord
//  Inputs: shareId
//  Outputs: Promise<object | null> — { id, ...fields }, or null if the
//    share doesn't exist
//  Summary: A missing or expired share is refused by the security rules, so
//    callers should expect a "permission-denied" error for those too.
///////////////////////////////////////////////////////////////////////////
async function getShareRecord(shareId) {
  const snap = await getDoc(doc(db, SHARES_COLLECTION, shareId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
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
  listUserDocuments,
  SHARE_LIFETIME_DAYS,
  createShareRecord,
  getShareRecord
};