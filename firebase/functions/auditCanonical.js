import { encodeAbiParameters, keccak256, stringToHex } from "viem";
export const AUDIT_HASH_SCHEME = 1;
const OPPORTUNITY_KIND = { BUSINESS_PROBLEM: 0, OPEN_FUNDING: 1, FUNDING_REQUEST: 2 };

export const AUDIT_ENTITY_TYPE = Object.freeze({
  OPPORTUNITY: "opportunity",
  PROPOSAL: "proposal",
});

export const MAX_AUDIT_RETRIES = 3;
export const MAX_ANCHOR_SCAN = 32;

const ENTITY_TYPES = new Set(Object.values(AUDIT_ENTITY_TYPE));
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function assertEntityType(entityType) {
  if (!ENTITY_TYPES.has(entityType)) {
    throw new TypeError(`Unsupported audit entity type: ${String(entityType)}`);
  }
}

function assertHashScheme(hashScheme) {
  if (hashScheme !== AUDIT_HASH_SCHEME) {
    throw new TypeError(`Only canonical audit hash scheme ${AUDIT_HASH_SCHEME} is supported.`);
  }
}

export function assertBytes32(value, label) {
  if (!BYTES32.test(String(value ?? ""))) {
    throw new TypeError(`${label} must be a bytes32 hex value.`);
  }
  return String(value).toLowerCase();
}

function normalizeCanonical(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError("Audit payload numbers must be finite safe integers.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") return { $integer: value.toString(10) };
  if (typeof value === "undefined") {
    throw new TypeError("Audit payloads cannot contain undefined values.");
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("Audit payload contains an invalid date.");
    return { $timestamp: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { $bytes: `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}` };
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Audit payloads cannot contain cycles.");
    ancestors.add(value);
    const result = value.map((item) => normalizeCanonical(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    // Firestore Timestamp exposes toDate(); converting it here keeps browser and
    // test payloads identical without importing Firebase into this pure layer.
    if (typeof value.toDate === "function") return normalizeCanonical(value.toDate(), ancestors);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Audit payloads may contain only plain objects, arrays, and supported scalars.");
    }
    if (ancestors.has(value)) throw new TypeError("Audit payloads cannot contain cycles.");
    ancestors.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key.normalize("NFC")] = normalizeCanonical(value[key], ancestors);
    }
    ancestors.delete(value);
    return result;
  }
  throw new TypeError(`Unsupported audit payload value: ${typeof value}`);
}

/**
 * Canonical JSON hash scheme 1. Object keys are sorted recursively, arrays retain
 * their order, strings are NFC-normalized, and dates are explicit tagged values.
 */
export function canonicalizeAuditPayload(
  entityType,
  payload,
  { hashScheme = AUDIT_HASH_SCHEME } = {},
) {
  assertEntityType(entityType);
  assertHashScheme(hashScheme);
  return JSON.stringify(normalizeCanonical({ entityType, hashScheme, payload }));
}

export function hashAuditPayload(entityType, payload, options) {
  return keccak256(stringToHex(canonicalizeAuditPayload(entityType, payload, options)));
}

export function createAuditEntityId(
  entityType,
  recordId,
  { hashScheme = AUDIT_HASH_SCHEME } = {},
) {
  assertEntityType(entityType);
  assertHashScheme(hashScheme);
  const id = String(recordId ?? "").trim();
  if (!id) throw new TypeError("Audit record id is required.");
  const canonical = JSON.stringify(normalizeCanonical({
    entityType,
    hashScheme,
    namespace: "qcdao.audit.entity",
    recordId: id,
  }));
  return keccak256(stringToHex(canonical));
}

export const opportunityEntityId = (recordId, options) =>
  createAuditEntityId(AUDIT_ENTITY_TYPE.OPPORTUNITY, recordId, options);
export const proposalEntityId = (recordId, options) =>
  createAuditEntityId(AUDIT_ENTITY_TYPE.PROPOSAL, recordId, options);

export function proposalRevisionDigest(proposalHash, solutionHash) {
  const first = assertBytes32(proposalHash, "Proposal hash");
  const second = assertBytes32(solutionHash, "Solution hash");
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }],
    [first, second],
  ));
}

function normalizeKind(kind) {
  if (Number.isInteger(kind) && kind >= 0 && kind <= 2) return kind;
  const key = String(kind ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  const kinds = {
    businessproblem: OPPORTUNITY_KIND.BUSINESS_PROBLEM,
    openfunding: OPPORTUNITY_KIND.OPEN_FUNDING,
    fundingrequest: OPPORTUNITY_KIND.FUNDING_REQUEST,
  };
  if (!(key in kinds)) throw new TypeError("Unknown opportunity kind.");
  return kinds[key];
}

export function toUnixSeconds(value) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new TypeError("Expiry cannot be negative.");
    return value;
  }
  if (value && typeof value.toDate === "function") return toUnixSeconds(value.toDate());
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("Expiry is not a valid date.");
    return BigInt(Math.floor(value.getTime() / 1000));
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new TypeError("Expiry is not a valid date.");
    return BigInt(Math.floor(parsed.getTime() / 1000));
  }
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new TypeError("Expiry must be Unix seconds, a Date, or a Firestore Timestamp.");
}

function prepared(base) {
  return Object.freeze({ __auditPrepared: true, ...base, args: Object.freeze(base.args) });
}

export function prepareOpportunityCommit({
  recordId,
  payload,
  kind = OPPORTUNITY_KIND.BUSINESS_PROBLEM,
  expiresAt,
  hashScheme = AUDIT_HASH_SCHEME,
}) {
  const entityId = opportunityEntityId(recordId, { hashScheme });
  const canonicalPayload = canonicalizeAuditPayload(AUDIT_ENTITY_TYPE.OPPORTUNITY, payload, { hashScheme });
  const contentHash = keccak256(stringToHex(canonicalPayload));
  const normalizedKind = normalizeKind(kind);
  const normalizedExpiry = toUnixSeconds(expiresAt);
  const expectedOwner = /^0x[0-9a-fA-F]{40}$/.test(String(payload?.ownerId ?? ""))
    ? String(payload.ownerId).toLowerCase()
    : null;
  return prepared({
    entityType: AUDIT_ENTITY_TYPE.OPPORTUNITY,
    entityId,
    contentHash,
    anchorHash: contentHash,
    canonicalPayload,
    expectedOwner,
    hashScheme,
    functionName: "commitOpportunity",
    args: [entityId, normalizedKind, contentHash, normalizedExpiry],
  });
}

export function prepareProposalCommit({
  recordId,
  opportunityRecordId,
  opportunityId,
  proposalPayload,
  solutionPayload,
  expectedOpportunityRevisionIndex,
  hashScheme = AUDIT_HASH_SCHEME,
}) {
  const entityId = proposalEntityId(recordId, { hashScheme });
  const parentId = opportunityId
    ? assertBytes32(opportunityId, "Opportunity id")
    : opportunityEntityId(opportunityRecordId, { hashScheme });
  const canonicalProposal = canonicalizeAuditPayload(
    AUDIT_ENTITY_TYPE.PROPOSAL,
    { document: "proposal", value: proposalPayload },
    { hashScheme },
  );
  const canonicalSolution = canonicalizeAuditPayload(
    AUDIT_ENTITY_TYPE.PROPOSAL,
    { document: "solution", value: solutionPayload },
    { hashScheme },
  );
  const proposalHash = keccak256(stringToHex(canonicalProposal));
  const solutionHash = keccak256(stringToHex(canonicalSolution));
  const revisionIndex = Number(expectedOpportunityRevisionIndex);
  if (!Number.isInteger(revisionIndex) || revisionIndex < 0 || revisionIndex > 4_294_967_295) {
    throw new TypeError("Expected opportunity revision index must fit uint32.");
  }
  return prepared({
    entityType: AUDIT_ENTITY_TYPE.PROPOSAL,
    entityId,
    opportunityId: parentId,
    expectedResearcher: /^0x[0-9a-fA-F]{40}$/.test(proposalPayload?.researcherId ?? "") ? proposalPayload.researcherId.toLowerCase() : null,
    contentHash: proposalHash,
    proposalHash,
    solutionHash,
    expectedOpportunityRevisionIndex: revisionIndex,
    anchorHash: proposalRevisionDigest(proposalHash, solutionHash),
    canonicalPayload: canonicalProposal,
    canonicalSolution,
    hashScheme,
    functionName: "commitProposal",
    args: [
      entityId,
      parentId,
      proposalHash,
      solutionHash,
      revisionIndex,
    ],
  });
}

export function prepareProposalUpdate(input) {
  const proposal = prepareProposalCommit(input);
  return prepared({
    ...proposal,
    functionName: "updateHashes",
    args: [
      proposal.entityId,
      proposal.proposalHash,
      proposal.solutionHash,
      proposal.expectedOpportunityRevisionIndex,
    ],
  });
}

