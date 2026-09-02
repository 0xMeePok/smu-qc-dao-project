import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { toPostingRecord } from "./attachments.js";
import { expiryDateFrom } from "../config/postingCategories.js";

/**
 * QCDAO-48 - funded business problem statements.
 *
 * Stored in `problems/{postingId}`, the collection firebase/firestore.rules already
 * governs. A posting created here goes straight to `submitted`; `draft` remains in
 * the rules for anything that needs to save before it is complete.
 *
 * The posting id is generated BEFORE the form is submitted, because attachments are
 * uploaded while the user is still filling the form and the id is part of their
 * storage path (see lib/attachments.js). That ordering is the one thing to preserve
 * if this module is ever rewritten.
 */

export const POSTING_STATUS_SUBMITTED = "submitted";

/** Reserves a posting id without writing anything. Call before the first upload. */
export function newPostingId() {
  requireFirebase();
  return doc(collection(db, "problems")).id;
}

function postingRef(postingId) {
  return doc(db, "problems", postingId);
}

function trimmed(value) {
  return String(value ?? "").trim();
}

/**
 * QCDAO-75 canonical opportunity payload v1.
 *
 * Only stable business fields are anchored. Firestore timestamps and the `audit`
 * receipt are deliberately excluded: updatedAt changes while the receipt advances,
 * and including the receipt in its own hash would be circular. Categories and
 * attachments are set-like in the UI, so they are sorted before canonical JSON is
 * produced by lib/auditRegistry.js.
 */
export function postingAuditPayload(posting) {
  return {
    ownerId: trimmed(posting.ownerId).toLowerCase(),
    organisation: trimmed(posting.organisation),
    title: trimmed(posting.title),
    businessContext: trimmed(posting.businessContext),
    summary: trimmed(posting.summary),
    currentApproach: trimmed(posting.currentApproach),
    currentLimitations: trimmed(posting.currentLimitations),
    expectedOutcome: trimmed(posting.expectedOutcome),
    successCriteria: trimmed(posting.successCriteria),
    dataAvailability: trimmed(posting.dataAvailability),
    categories: [...(posting.categories ?? [])].map(trimmed).sort(),
    amount: Number(posting.amount),
    currency: trimmed(posting.currency),
    expiresAt: posting.expiresAt,
    attachments: [...(posting.attachments ?? [])]
      .map((item) => ({
        id: trimmed(item.id),
        name: trimmed(item.name),
        size: Number(item.size),
        contentType: trimmed(item.contentType || "application/pdf"),
        path: trimmed(item.path),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/**
 * Builds the document from form state. Split out from the write so the exact shape
 * that will be sent can be asserted in tests without touching Firestore.
 *
 * `organisation` comes from the signed-in user's profile rather than the form: it
 * identifies the sponsor behind the posting, and letting the form set it freely
 * would let anyone post under any organisation's name.
 */
export function buildPostingDocument({ ownerId, organisation, form, attachments = [], audit = null, now = new Date() }) {
  const document = {
    ownerId: String(ownerId).toLowerCase(),
    organisation: trimmed(organisation),
    title: trimmed(form.title),
    businessContext: trimmed(form.businessContext),
    summary: trimmed(form.summary),
    currentApproach: trimmed(form.currentApproach),
    currentLimitations: trimmed(form.currentLimitations),
    expectedOutcome: trimmed(form.expectedOutcome),
    successCriteria: trimmed(form.successCriteria),
    dataAvailability: trimmed(form.dataAvailability),
    categories: [...form.categories],
    amount: Number(form.amount),
    currency: form.currency,
    // Stored as a concrete instant, not "90 days", so the expiry does not shift
    // meaning depending on when it is read.
    expiresAt: Timestamp.fromDate(expiryDateFrom(form.expiryDays, now)),
    status: POSTING_STATUS_SUBMITTED,
    attachments: attachments.map(toPostingRecord),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  // The posting is authoritative even while Arbitrum Sepolia is unavailable.
  // Audit metadata is an optional resumable outbox/receipt, never the record itself.
  if (audit) document.audit = { ...audit };
  return document;
}

export async function createPosting({ postingId, ownerId, organisation, form, attachments = [], audit = null }) {
  requireFirebase();
  const record = buildPostingDocument({ ownerId, organisation, form, attachments, audit });
  await setDoc(postingRef(postingId), record);

  // Read back rather than returning `record`. createdAt and updatedAt are
  // serverTimestamp() SENTINELS before the write - placeholders, not times - so a
  // confirmation screen rendering them would show nothing useful. Reading returns
  // the instants Firestore actually recorded, which is what the posting is
  // timestamped with and what the countdown is measured against.
  return (await findPosting(postingId)) ?? { id: postingId, ...record };
}

/** Persists one transition of the queued -> submitted/pending -> confirmed/failed receipt. */
export async function updatePostingAudit({ postingId, audit }) {
  requireFirebase();
  await updateDoc(postingRef(postingId), {
    audit: { ...audit },
    updatedAt: serverTimestamp(),
  });
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
    categories: Array.isArray(data.categories) ? data.categories : [],
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
  };
}

export async function listPublishedPostings() {
  requireFirebase();
  const snapshot = await getDocs(query(
    collection(db, "problems"),
    where("status", "in", ["submitted", "open"]),
  ));

  return snapshot.docs
    .map((item) => {
      const data = item.data();
      return {
        id: item.id,
        ...data,
        categories: Array.isArray(data.categories) ? data.categories : [],
            attachments: Array.isArray(data.attachments) ? data.attachments : [],
      };
    })
    .filter((item) => !item.expiresAt
      || (typeof item.expiresAt.toDate === "function"
        ? item.expiresAt.toDate()
        : new Date(item.expiresAt)) > new Date());
}
