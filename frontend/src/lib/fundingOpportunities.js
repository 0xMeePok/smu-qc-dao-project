import {
  Timestamp,
  collection,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { expiryDateFrom } from "../config/postingCategories.js";
import { toPostingRecord } from "./attachments.js";
import {
  fundingTagsFromCategories,
  OPEN_FUNDING_TYPE,
  parseFundingTags,
} from "../config/fundingOpportunity.js";
import { findPosting } from "./postings.js";

export const FUNDING_STATUS_SUBMITTED = "submitted";
export const FUNDING_STATUS_DRAFT = "draft";

/**
 * Open funding is a distinct opportunity shape in the shared `problems`
 * collection. Keeping all opportunity kinds in that collection preserves the
 * existing proposal relationship and lets one indexed query feed Discover.
 */
export function newFundingOpportunityId() {
  requireFirebase();
  return doc(collection(db, "problems")).id;
}

function fundingOpportunityRef(opportunityId) {
  return doc(db, "problems", opportunityId);
}

function trimmed(value) {
  return String(value ?? "").trim();
}

export function fundingOpportunityAuditPayload(opportunity) {
  const attachments = [...(opportunity.attachments ?? [])]
    .map((item) => ({
      id: trimmed(item.id),
      name: trimmed(item.name),
      size: Number(item.size),
      contentType: trimmed(item.contentType || "application/pdf"),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    opportunityType: OPEN_FUNDING_TYPE,
    ownerId: trimmed(opportunity.ownerId).toLowerCase(),
    organisation: trimmed(opportunity.organisation),
    title: trimmed(opportunity.title),
    fundingThesis: trimmed(opportunity.fundingThesis),
    eligibilityNotes: trimmed(opportunity.eligibilityNotes),
    categories: [...(opportunity.categories ?? [])].map(trimmed).sort(),
    tags: parseFundingTags(opportunity.tags).sort(),
    amount: Number(opportunity.amount),
    currency: trimmed(opportunity.currency),
    expiresAt: opportunity.expiresAt,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function buildFundingOpportunityDocument({
  ownerId, organisation, form, attachments = [], now = new Date(),
  status = FUNDING_STATUS_SUBMITTED,
}) {
  return {
    opportunityType: OPEN_FUNDING_TYPE,
    ownerId: trimmed(ownerId).toLowerCase(),
    organisation: trimmed(organisation),
    title: trimmed(form.title),
    fundingThesis: trimmed(form.fundingThesis),
    eligibilityNotes: trimmed(form.eligibilityNotes),
    categories: [...form.categories],
    tags: fundingTagsFromCategories(form.categories),
    amount: Number(form.amount),
    currency: form.currency,
    expiresAt: Timestamp.fromDate(expiryDateFrom(form.expiryDays, now)),
    status,
    attachments: attachments.map(toPostingRecord),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export async function saveFundingDraft({
  opportunityId, ownerId, organisation, form, attachments = [], exists = false,
}) {
  requireFirebase();
  const record = buildFundingOpportunityDocument({
    ownerId, organisation, form, attachments, status: FUNDING_STATUS_DRAFT,
  });
  if (exists) {
    // createdAt must equal request.time on create and never move afterwards.
    const { createdAt, ...rest } = record;
    await updateDoc(fundingOpportunityRef(opportunityId), rest);
  } else {
    await setDoc(fundingOpportunityRef(opportunityId), record);
  }
  return findPosting(opportunityId);
}

/**
 * Promotes a draft to submitted. `record` is the document that was hashed and
 * anchored on-chain and MUST be reused rather than rebuilt: a rebuild derives a
 * fresh expiresAt that would no longer match the confirmed hash.
 */
export async function publishFundingDraft({
  opportunityId, ownerId, organisation, form, attachments = [], record: preparedRecord = null,
}) {
  requireFirebase();
  const built = preparedRecord
    ? { ...preparedRecord, status: FUNDING_STATUS_SUBMITTED }
    : buildFundingOpportunityDocument({ ownerId, organisation, form, attachments });
  const { createdAt, ...record } = built;
  await updateDoc(fundingOpportunityRef(opportunityId), record);
  return findPosting(opportunityId);
}

export async function createFundingOpportunity({
  opportunityId,
  ownerId,
  organisation,
  form,
  attachments = [],
  record: preparedRecord = null,
}) {
  requireFirebase();
  const record = preparedRecord
    ? { ...preparedRecord }
    : buildFundingOpportunityDocument({ ownerId, organisation, form, attachments });
  await setDoc(fundingOpportunityRef(opportunityId), record);
  return (await findPosting(opportunityId)) ?? { id: opportunityId, ...record };
}

export async function updateFundingOpportunityAudit({ opportunityId, audit }) {
  requireFirebase();
  await updateDoc(fundingOpportunityRef(opportunityId), {
    audit: { ...audit },
    updatedAt: serverTimestamp(),
  });
}
