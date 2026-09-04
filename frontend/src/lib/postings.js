import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { deleteAttachment, toPostingRecord } from "./attachments.js";
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
export const POSTING_STATUS_DRAFT = "draft";

/** Reserves a posting id without writing anything. Call before the first upload. */
export function newPostingId() {
  requireFirebase();
  return doc(collection(db, "problems")).id;
}

function postingRef(postingId) {
  return doc(db, "problems", postingId);
}

function opportunityMetricsRef(postingId) {
  return doc(db, "opportunityMetrics", postingId);
}

function trimmed(value) {
  return String(value ?? "").trim();
}

export function normaliseOpportunityMetrics(value = {}) {
  const proposalCount = Number(value.proposalCount);
  const fundedAmount = Number(value.fundedAmount);
  const fundingProgressPercent = Number(value.fundingProgressPercent);
  return {
    proposalCount: Number.isInteger(proposalCount) && proposalCount >= 0 ? proposalCount : 0,
    fundedAmount: Number.isFinite(fundedAmount) && fundedAmount >= 0 ? fundedAmount : 0,
    fundingProgressPercent: Number.isFinite(fundingProgressPercent)
      ? Math.max(0, Math.min(100, fundingProgressPercent))
      : 0,
  };
}

async function findOpportunityMetrics(postingId, fallback = {}) {
  const snapshot = await getDoc(opportunityMetricsRef(postingId));
  return normaliseOpportunityMetrics(snapshot.exists() ? snapshot.data() : fallback);
}

function postingFromSnapshot(snapshot, metrics) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    ...data,
    ...metrics,
    categories: Array.isArray(data.categories) ? data.categories : [],
    tags: Array.isArray(data.tags) ? data.tags : [],
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
  };
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
export function buildPostingDocument({
  ownerId, organisation, form, attachments = [], audit = null,
  status = POSTING_STATUS_SUBMITTED, now = new Date(),
}) {
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
    amount: Number(form.amount) || 0,
    currency: form.currency,
    // Stored as a concrete instant, not "90 days", so the expiry does not shift
    // meaning depending on when it is read.
    expiresAt: Timestamp.fromDate(expiryDateFrom(form.expiryDays, now)),
    status,
    attachments: attachments.map(toPostingRecord),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  // Audit metadata is excluded from the content hash and records only delivery
  // state. The create screen now supplies it after the chain confirms.
  if (audit) document.audit = { ...audit };
  return document;
}

export async function createPosting({
  postingId,
  ownerId,
  organisation,
  form,
  attachments = [],
  audit = null,
  record: preparedRecord = null,
}) {
  requireFirebase();
  const record = preparedRecord
    ? { ...preparedRecord }
    : buildPostingDocument({ ownerId, organisation, form, attachments, audit });
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

function normalisePosting(id, data) {
  return {
    id,
    ...data,
    categories: Array.isArray(data.categories) ? data.categories : [],
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
  };
}

export async function findPosting(postingId) {
  requireFirebase();
  const snapshot = await getDoc(postingRef(postingId));
  if (!snapshot.exists()) return null;
  const metrics = await findOpportunityMetrics(snapshot.id, snapshot.data());
  return postingFromSnapshot(snapshot, metrics);
}

export async function listPublishedPostings() {
  requireFirebase();
  const snapshot = await getDocs(query(
    collection(db, "problems"),
    where("status", "in", ["submitted", "open"]),
    orderBy("createdAt", "desc"),
  ));

  const visible = snapshot.docs.filter((item) => {
    const data = item.data();
    return !data.expiresAt
      || (typeof data.expiresAt.toDate === "function"
        ? data.expiresAt.toDate()
        : new Date(data.expiresAt)) > new Date();
  });

  // Each metric read is independent. Running them together keeps the listing to
  // two network turns without exposing private proposal or funding documents.
  return Promise.all(visible.map(async (item) => postingFromSnapshot(
    item,
    await findOpportunityMetrics(item.id, item.data()),
  )));
}

/**
 * QCDAO-50 - drafts.
 *
 * A draft is the same document in `status: draft`. firestore.rules exempts that
 * status from the funded-posting schema, so an unfinished form still saves.
 */

/**
 * Saves the form as a draft. `exists` says whether the record is already there;
 * the caller knows, and reading first is not an option - the read rule
 * dereferences resource.data, so a get on a posting that does not exist yet is
 * denied rather than returning empty.
 */
export async function saveDraft({ postingId, ownerId, organisation, form, attachments = [], exists = false }) {
  requireFirebase();
  const record = buildPostingDocument({
    ownerId, organisation, form, attachments, status: POSTING_STATUS_DRAFT,
  });

  if (exists) {
    // createdAt must equal request.time on create and never move afterwards.
    const { createdAt, ...rest } = record;
    await updateDoc(postingRef(postingId), rest);
  } else {
    await setDoc(postingRef(postingId), record);
  }

  return findPosting(postingId);
}

/**
 * Promotes a draft to submitted. Full validation applies at this point.
 *
 * `record` is the document that was hashed and anchored on-chain. It MUST be
 * reused rather than rebuilt: buildPostingDocument() derives expiresAt from
 * `now`, so a rebuild here produces a different expiry from the one in the
 * confirmed hash, and later verification against Firestore fails.
 */
export async function publishDraft({
  postingId, ownerId, organisation, form, attachments = [], record: preparedRecord = null,
}) {
  requireFirebase();
  const built = preparedRecord
    ? { ...preparedRecord, status: POSTING_STATUS_SUBMITTED }
    : buildPostingDocument({
      ownerId, organisation, form, attachments, status: POSTING_STATUS_SUBMITTED,
    });
  const { createdAt, ...record } = built;
  await updateDoc(postingRef(postingId), record);
  return findPosting(postingId);
}

/** Every posting this wallet owns, drafts included, newest first. */
export async function listOwnPostings(ownerId) {
  requireFirebase();
  const snapshot = await getDocs(query(
    collection(db, "problems"),
    where("ownerId", "==", String(ownerId).toLowerCase()),
    orderBy("updatedAt", "desc"),
  ));
  return snapshot.docs.map((item) => normalisePosting(item.id, item.data()));
}

/** Deletes a posting and the stored files it referenced. */
export async function deletePosting(posting) {
  requireFirebase();
  // Files first: once the record is gone its attachment paths are unrecoverable
  // and the objects would be orphaned until the sweeper runs.
  await Promise.allSettled((posting.attachments ?? []).map((attachment) => deleteAttachment({
    attachment, ownerId: posting.ownerId, problemId: posting.id,
  })));
  await deleteDoc(postingRef(posting.id));
}
