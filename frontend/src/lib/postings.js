import {
  collection,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { toPostingRecord } from "./attachments.js";

/**
 * The thin slice of the postings ("problems") collection that QCDAO-58 needs.
 *
 * This is NOT the posting form's data layer - that belongs to the story building
 * the form. It exists so the attachment work can be exercised against the real
 * firebase/firestore.rules instead of a mock, and so whoever builds the form has
 * a working reference for the one part that is easy to get wrong: the posting id
 * must be generated BEFORE any file is uploaded, because it is baked into the
 * storage path and into the rule that validates each attachment record.
 */

/** Reserves a posting id without writing anything. Call before the first upload. */
export function newPostingId() {
  requireFirebase();
  return doc(collection(db, "problems")).id;
}

function postingRef(postingId) {
  return doc(db, "problems", postingId);
}

/**
 * Creates the posting. `status` is forced to 'draft' because firestore.rules
 * rejects a create in any other state - the status machine starts here and is
 * only advanced by updates.
 */
export async function createPosting({ postingId, ownerId, form, attachments = [] }) {
  requireFirebase();
  const record = {
    ownerId: String(ownerId).toLowerCase(),
    title: form.title.trim(),
    summary: form.summary.trim(),
    amount: Number(form.amount) || 0,
    status: "draft",
    attachments: attachments.map(toPostingRecord),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await setDoc(postingRef(postingId), record);
  return record;
}

/** Replaces the attachment list on an existing posting. */
export async function savePostingAttachments({ postingId, attachments }) {
  requireFirebase();
  await updateDoc(postingRef(postingId), {
    attachments: attachments.map(toPostingRecord),
    updatedAt: serverTimestamp(),
  });
}

export async function findPosting(postingId) {
  requireFirebase();
  const snapshot = await getDoc(postingRef(postingId));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  return {
    id: snapshot.id,
    ...data,
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
  };
}
