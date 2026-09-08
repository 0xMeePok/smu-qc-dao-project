import { prepareOpportunityCommit } from "./auditCanonical.js";

export const TRACKED_POSTING_FIELDS = [
  "title", "summary", "businessContext", "currentApproach", "currentLimitations",
  "expectedOutcome", "successCriteria", "dataAvailability",
  "categories", "amount", "currency", "expiresAt", "attachments",
];

export const TRACKED_FUNDING_FIELDS = [
  "title", "fundingThesis", "eligibilityNotes",
  "categories", "tags", "amount", "currency", "expiresAt", "attachments",
];

function trimmed(value) {
  return String(value ?? "").trim();
}

function canonical(value) {
  if (value === undefined) return null;
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonical(value[key]);
      return out;
    }, {});
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function isOpenFunding(record = {}) {
  return record.opportunityType === "open-funding";
}

export function trackedOpportunityFields(record) {
  return isOpenFunding(record) ? TRACKED_FUNDING_FIELDS : TRACKED_POSTING_FIELDS;
}

export function changedOpportunityFields(before = {}, after = {}) {
  const keys = new Set([
    ...trackedOpportunityFields(before),
    ...trackedOpportunityFields(after),
  ]);
  return [...keys].filter((key) => !same(before?.[key], after?.[key]));
}

function postingPayload(record) {
  return {
    ownerId: trimmed(record.ownerId).toLowerCase(),
    organisation: trimmed(record.organisation),
    title: trimmed(record.title),
    businessContext: trimmed(record.businessContext),
    summary: trimmed(record.summary),
    currentApproach: trimmed(record.currentApproach),
    currentLimitations: trimmed(record.currentLimitations),
    expectedOutcome: trimmed(record.expectedOutcome),
    successCriteria: trimmed(record.successCriteria),
    dataAvailability: trimmed(record.dataAvailability),
    categories: [...(record.categories ?? [])].map(trimmed).sort(),
    amount: Number(record.amount),
    currency: trimmed(record.currency),
    expiresAt: record.expiresAt,
    attachments: [...(record.attachments ?? [])]
      .map((item) => ({
        id: trimmed(item.id),
        name: trimmed(item.name),
        size: Number(item.size),
        contentType: trimmed(item.contentType || "application/pdf"),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function fundingPayload(record) {
  const attachments = [...(record.attachments ?? [])]
    .map((item) => ({
      id: trimmed(item.id),
      name: trimmed(item.name),
      size: Number(item.size),
      contentType: trimmed(item.contentType || "application/pdf"),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    opportunityType: "open-funding",
    ownerId: trimmed(record.ownerId).toLowerCase(),
    organisation: trimmed(record.organisation),
    title: trimmed(record.title),
    fundingThesis: trimmed(record.fundingThesis),
    eligibilityNotes: trimmed(record.eligibilityNotes),
    categories: [...(record.categories ?? [])].map(trimmed).sort(),
    tags: [...(record.tags ?? [])].map(trimmed).filter(Boolean).sort(),
    amount: Number(record.amount),
    currency: trimmed(record.currency),
    expiresAt: record.expiresAt,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function contentHashOf(record, recordId) {
  try {
    return prepareOpportunityCommit({
      recordId,
      payload: isOpenFunding(record) ? fundingPayload(record) : postingPayload(record),
      kind: isOpenFunding(record) ? 1 : 0,
      expiresAt: record.expiresAt,
    }).contentHash;
  } catch {
    return "";
  }
}

export function opportunityRevisionEntry({ recordId, before, after, at }) {
  const changedFields = changedOpportunityFields(before, after);
  const statusChanged = before.status !== after.status;
  if (!changedFields.length && !statusChanged) return null;

  const entry = {
    actor: after.ownerId ?? before.ownerId ?? "",
    ownerId: after.ownerId ?? before.ownerId ?? "",
    changedFields,
    previousStatus: before.status ?? "",
    status: after.status ?? "",
    contentHashBefore: contentHashOf(before, recordId),
    contentHashAfter: contentHashOf(after, recordId),
    at,
  };
  if (statusChanged && after.status === "cancelled") {
    entry.withdrawalReason = String(after.withdrawalReason ?? "").slice(0, 1000);
  }
  return entry;
}

export async function recordOpportunityRevision({ db, recordId, eventId, before, after, at }) {
  if (!before || !after) return null;
  if (before.status === "draft") return null;

  const entry = opportunityRevisionEntry({ recordId, before, after, at });
  if (!entry) return null;

  await db.collection("problems").doc(recordId)
    .collection("revisions").doc(eventId)
    .set(entry);
  return entry;
}
