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
import {
  fundingTagsFromCategories,
  OPEN_FUNDING_TYPE,
  parseFundingTags,
} from "../config/fundingOpportunity.js";
import { findPosting } from "./postings.js";

export const FUNDING_STATUS_SUBMITTED = "submitted";

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
  };
}

export function buildFundingOpportunityDocument({ ownerId, organisation, form, now = new Date() }) {
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
    status: FUNDING_STATUS_SUBMITTED,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export async function createFundingOpportunity({
  opportunityId,
  ownerId,
  organisation,
  form,
  record: preparedRecord = null,
}) {
  requireFirebase();
  const record = preparedRecord
    ? { ...preparedRecord }
    : buildFundingOpportunityDocument({ ownerId, organisation, form });
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
