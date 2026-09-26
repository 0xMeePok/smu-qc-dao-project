/**
 * Full validation of a problem or open-funding record that is about to become
 * marketplace-visible (status `submitted` or `open`).
 *
 * WHY THIS LIVES HERE. Firestore caps a rule evaluation at 1,000 expressions.
 * Publishing a posting with a PDF and its audit receipt ran the whole-document
 * schema checks AND the publication-proof checks in one evaluation, crossed that
 * cap, and every such publish was denied as permission-denied. attestPublication
 * now runs these checks and marks the proof `validated`; the rules accept a
 * publish only against a validated proof whose record the write reproduces
 * exactly, and keep every check that depends on the request itself (caller,
 * reservation, timestamps, expiry window, receipt shape, status transition).
 *
 * THIS MUST STAY AT LEAST AS STRICT AS THE RULES IT REPLACES:
 *   hasProblemSchema, validProblem, validFundedPosting, legacyTextIsBounded,
 *   validOpenFunding, completeOpenFunding, validAttachments(data, false),
 *   and the create rule's empty withdrawalReason.
 * An on-chain transaction proves only that the caller anchored this content, not
 * that the content is valid - anyone can anchor anything from their own wallet.
 * A proof without the marker is never trusted for a publish.
 */

export const PUBLISH_VALIDATION = "problem-publish-v1";

const PROBLEM_KEYS = new Set([
  "ownerId", "organisation", "title", "summary", "amount", "status",
  "businessContext", "currentApproach", "currentLimitations",
  "expectedOutcome", "successCriteria", "dataAvailability",
  "opportunityType", "fundingThesis", "eligibilityNotes", "tags",
  "categories", "currency", "expiresAt", "attachments", "withdrawalReason",
]);

const OPEN_FUNDING_KEYS = new Set([
  "opportunityType", "ownerId", "organisation", "title",
  "fundingThesis", "eligibilityNotes", "categories", "tags",
  "amount", "currency", "expiresAt", "status", "attachments", "withdrawalReason",
]);

const ALLOWED_CATEGORIES = new Set([
  "ai", "quantum", "web3", "robotics", "iot", "data",
  "security", "cloud", "simulation", "optimisation",
  "sustainability", "other",
]);

const CURRENCIES = new Set(["USDT", "USDC", "XSGD"]);
const ATTACHMENT_KEYS = new Set(["id", "name", "size", "contentType", "sha256"]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const isString = (value) => typeof value === "string";
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
// isNonEmptyString in the rules: MORE than one character.
const nonEmpty = (value, max) => isString(value) && value.length > 1 && value.length <= max;
// optionalString in the rules: absent, or a string within the bound.
const optional = (record, key, max) => !(key in record) || (isString(record[key]) && record[key].length <= max);
const has = (record, key) => Object.prototype.hasOwnProperty.call(record, key);

function isTimestamp(value) {
  return Boolean(value) && typeof value.toMillis === "function" && Number.isFinite(value.toMillis());
}

function validAmount(value) {
  return isNumber(value) && value >= 0 && value <= 1_000_000_000;
}

function validCategories(value) {
  return Array.isArray(value) && value.length <= 6 && value.every((item) => ALLOWED_CATEGORIES.has(item));
}

function validFundingTags(tags) {
  return Array.isArray(tags)
    && tags.length >= 1 && tags.length <= 8
    && new Set(tags).size === tags.length
    && tags.every((tag) => isString(tag) && tag.length > 0 && tag.length <= 40);
}

// attachmentEntry(item, false): four legacy fields, or five with the digest.
function validAttachment(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const keys = Object.keys(item);
  if (!(keys.length === 4 || keys.length === 5) || !keys.every((key) => ATTACHMENT_KEYS.has(key))) return false;
  if (!["id", "name", "size", "contentType"].every((key) => has(item, key))) return false;
  return isString(item.id) && /^[A-Za-z0-9_-]{8,64}$/.test(item.id)
    && isString(item.name) && item.name.length > 0 && item.name.length <= 200
    && isNumber(item.size) && item.size > 0 && item.size <= MAX_ATTACHMENT_BYTES
    && item.contentType === "application/pdf"
    && (keys.length === 4 || (isString(item.sha256) && /^0x[0-9a-f]{64}$/.test(item.sha256)));
}

function validAttachments(record) {
  const items = has(record, "attachments") ? record.attachments : [];
  return Array.isArray(items) && items.length <= 2 && items.every(validAttachment);
}

// validProblem + validFundedPosting for a business problem leaving draft.
function validBusinessProblem(record, profileOrganisation) {
  return Object.keys(record).every((key) => PROBLEM_KEYS.has(key))
    && (!has(record, "opportunityType") || record.opportunityType === "business-problem")
    && nonEmpty(record.title, 160)
    && nonEmpty(record.summary, 4000)
    && nonEmpty(record.organisation, 120)
    && nonEmpty(record.businessContext, 4000)
    && nonEmpty(record.currentApproach, 4000)
    && nonEmpty(record.currentLimitations, 4000)
    && nonEmpty(record.expectedOutcome, 4000)
    && nonEmpty(record.successCriteria, 4000)
    && nonEmpty(record.dataAvailability, 4000)
    && optional(record, "opportunityType", 80)
    && optional(record, "fundingThesis", 4000)
    && optional(record, "eligibilityNotes", 4000)
    && validCategories(record.categories) && record.categories.length >= 1
    && (!has(record, "tags") || (Array.isArray(record.tags) && (record.tags.length === 0 || validFundingTags(record.tags))))
    && CURRENCIES.has(record.currency)
    && validAmount(record.amount) && record.amount > 0
    && record.organisation === profileOrganisation;
}

// validOpenFunding + completeOpenFunding.
function validOpenFunding(record, profileOrganisation) {
  return Object.keys(record).every((key) => OPEN_FUNDING_KEYS.has(key))
    && ["organisation", "title", "fundingThesis", "eligibilityNotes", "categories", "tags", "amount", "currency", "expiresAt"]
      .every((key) => has(record, key))
    && nonEmpty(record.title, 160)
    && nonEmpty(record.fundingThesis, 4000)
    && nonEmpty(record.eligibilityNotes, 4000)
    && validCategories(record.categories)
    && validFundingTags(record.tags)
    && validAmount(record.amount) && record.amount > 0
    && CURRENCIES.has(record.currency)
    && isString(record.organisation) && record.organisation === profileOrganisation;
}

/**
 * True when `record` (the proof's content: no id, createdAt, updatedAt or audit)
 * is a complete marketplace posting owned by `uid`, sponsored by the caller's
 * profile organisation. `expiresAt` must already be a Firestore Timestamp.
 */
export function isPublishableProblem(record, { uid, profileOrganisation }) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (!isString(uid) || !/^0x[0-9a-f]{40}$/.test(uid) || record.ownerId !== uid) return false;
  if (!(record.status === "submitted" || record.status === "open")) return false;
  if (!isTimestamp(record.expiresAt)) return false;
  // The create rule admits only an empty seed; a draft is never withdrawn.
  if (has(record, "withdrawalReason") && record.withdrawalReason !== "") return false;
  if (!isString(profileOrganisation)) return false;
  if (!validAttachments(record)) return false;
  return has(record, "opportunityType") && record.opportunityType === "open-funding"
    ? validOpenFunding(record, profileOrganisation)
    : validBusinessProblem(record, profileOrganisation);
}
