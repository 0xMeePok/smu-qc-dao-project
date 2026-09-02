import { encodeAbiParameters, keccak256, stringToHex } from "viem";
import {
  readContract as wagmiReadContract,
  waitForTransactionReceipt as wagmiWaitForTransactionReceipt,
  writeContract as wagmiWriteContract,
} from "wagmi/actions";
import {
  AUDIT_HASH_SCHEME,
  AUDIT_REGISTRY_ABI,
  AUDIT_REGISTRY_CHAIN_ID,
  OPPORTUNITY_KIND,
  getAuditRegistryAddress,
} from "../config/auditRegistry.js";
import { wagmiConfig } from "./wagmi.js";

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

function assertBytes32(value, label) {
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
  return prepared({
    entityType: AUDIT_ENTITY_TYPE.PROPOSAL,
    entityId,
    opportunityId: parentId,
    contentHash: proposalHash,
    proposalHash,
    solutionHash,
    anchorHash: proposalRevisionDigest(proposalHash, solutionHash),
    canonicalPayload: canonicalProposal,
    canonicalSolution,
    hashScheme,
    functionName: "commitProposal",
    args: [entityId, parentId, proposalHash, solutionHash],
  });
}

export function createWagmiAuditAdapters(config = wagmiConfig) {
  return {
    writeContract: (request) => wagmiWriteContract(config, request),
    waitForTransactionReceipt: (request) => wagmiWaitForTransactionReceipt(config, request),
    readContract: (request) => wagmiReadContract(config, request),
  };
}

function auditAdapters(adapters) {
  const resolved = adapters ?? createWagmiAuditAdapters();
  for (const method of ["writeContract", "waitForTransactionReceipt", "readContract"]) {
    if (typeof resolved[method] !== "function") {
      throw new TypeError(`Audit adapter is missing ${method}().`);
    }
  }
  return resolved;
}

function canonicalRegistryAddress(requestedAddress) {
  const configured = getAuditRegistryAddress();
  if (requestedAddress
      && String(requestedAddress).toLowerCase() !== configured.toLowerCase()) {
    throw new Error("AuditRegistry address does not match the configured deployment.");
  }
  return configured;
}

function cappedRetries(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.min(MAX_AUDIT_RETRIES, Math.trunc(Number(value))));
}

function errorText(error) {
  return [error?.name, error?.shortMessage, error?.message, error?.cause?.message]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function classifyAuditError(error, { attempt = 0, maxRetries = 0 } = {}) {
  const text = errorText(error);
  const code = error?.code ?? error?.cause?.code;
  let category = "unknown";
  if (code === 4001 || /userrejected|user rejected|denied transaction signature/.test(text)) {
    category = "user-rejected";
  } else if (/contractfunctionreverted|execution reverted|revert|invalidinput|invalidstate|accessdenied/.test(text)) {
    category = "contract-reverted";
  } else if (/invalid address|missing or invalid|chain mismatch|unsupported chain|wrong network/.test(text)) {
    category = "configuration";
  } else if (/timeout|timed out|http|socket|network|fetch|rate limit|429|503|gateway/.test(text)) {
    category = "transient";
  }
  const retryLimit = cappedRetries(maxRetries);
  return Object.freeze({
    category,
    retryable: category === "transient" && attempt < retryLimit,
    attempt,
    maxRetries: retryLimit,
  });
}

async function retryRead(operation, maxRetries, onRetry) {
  const limit = cappedRetries(maxRetries);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const classification = classifyAuditError(error, { attempt, maxRetries: limit });
      if (!classification.retryable) {
        error.auditClassification = classification;
        throw error;
      }
      await onRetry?.({ attempt: attempt + 1, error, classification });
    }
  }
}

export async function waitForAuditReceipt({
  transactionHash,
  adapters,
  confirmations = 1,
  timeout = 120_000,
  maxRetries = 2,
  onRetry,
}) {
  const resolved = auditAdapters(adapters);
  const hash = assertBytes32(transactionHash, "Transaction hash");
  return retryRead(
    () => resolved.waitForTransactionReceipt({
      hash,
      chainId: AUDIT_REGISTRY_CHAIN_ID,
      confirmations,
      timeout,
    }),
    maxRetries,
    onRetry,
  );
}

async function status(onStatus, statusName, details = {}) {
  await onStatus?.(Object.freeze({ status: statusName, ...details }));
}

/** Writes once, then safely retries polling the same transaction hash. */
export async function executePreparedAudit(preparedAudit, {
  address,
  account,
  adapters,
  confirmations = 1,
  timeout = 120_000,
  maxReceiptRetries = 2,
  onStatus,
} = {}) {
  if (!preparedAudit?.__auditPrepared) throw new TypeError("A prepared audit operation is required.");
  const resolved = auditAdapters(adapters);
  const contractAddress = canonicalRegistryAddress(address);
  // Status callbacks are awaited in order. A caller may persist each transition;
  // letting those writes race can otherwise leave an older `pending` write landing
  // after `confirmed` and permanently regress the displayed receipt state.
  await status(onStatus, "queued", { prepared: preparedAudit });
  let transactionHash;
  try {
    transactionHash = await resolved.writeContract({
      address: contractAddress,
      abi: AUDIT_REGISTRY_ABI,
      functionName: preparedAudit.functionName,
      args: preparedAudit.args,
      account,
      chainId: AUDIT_REGISTRY_CHAIN_ID,
    });
  } catch (error) {
    await status(onStatus, "failed", { error, classification: classifyAuditError(error) });
    throw error;
  }

  await status(onStatus, "submitted", { transactionHash });
  await status(onStatus, "pending", { transactionHash });
  let receipt;
  try {
    receipt = await waitForAuditReceipt({
      transactionHash,
      adapters: resolved,
      confirmations,
      timeout,
      maxRetries: maxReceiptRetries,
      onRetry: (retry) => status(onStatus, "pending", { transactionHash, retry }),
    });
  } catch (error) {
    error.transactionHash = transactionHash;
    await status(onStatus, "failed", {
      transactionHash,
      error,
      classification: error.auditClassification ?? classifyAuditError(error),
    });
    throw error;
  }
  if (receipt?.status !== "success") {
    const error = new Error("AuditRegistry transaction reverted.");
    error.name = "AuditTransactionRevertedError";
    error.transactionHash = transactionHash;
    error.receipt = receipt;
    await status(onStatus, "failed", {
      transactionHash,
      error,
      classification: classifyAuditError(error),
    });
    throw error;
  }
  const result = Object.freeze({
    status: "confirmed",
    transactionHash,
    blockNumber: receipt.blockNumber,
    receipt,
    prepared: preparedAudit,
  });
  await status(onStatus, "confirmed", result);
  return result;
}

function asPrepared(input, prepare) {
  return input?.__auditPrepared ? input : prepare(input);
}

export function commitOpportunityAudit(input, options) {
  return executePreparedAudit(asPrepared(input, prepareOpportunityCommit), options);
}

export function commitProposalAudit(input, options) {
  return executePreparedAudit(asPrepared(input, prepareProposalCommit), options);
}

function tupleField(value, name, index) {
  return value?.[name] ?? value?.[index];
}

function sameHex(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function mismatch(mismatches, field, expected, actual, compare = Object.is) {
  if (!compare(expected, actual)) mismatches.push({ field, expected, actual });
}

async function readWithRetries(functionName, args, options) {
  const resolved = auditAdapters(options.adapters);
  const address = canonicalRegistryAddress(options.address);
  return retryRead(
    () => resolved.readContract({
      address,
      abi: AUDIT_REGISTRY_ABI,
      functionName,
      args,
      chainId: AUDIT_REGISTRY_CHAIN_ID,
    }),
    options.maxReadRetries ?? 2,
    options.onRetry,
  );
}

async function findMatchingAnchor(entityId, expectedHash, options) {
  if (options.verifyAnchor === false) return null;
  const count = BigInt(await readWithRetries("anchorCount", [entityId], options));
  const scan = BigInt(Math.min(Number(count), MAX_ANCHOR_SCAN));
  for (let offset = 0n; offset < scan; offset += 1n) {
    const index = count - 1n - offset;
    const anchor = await readWithRetries("anchorAt", [entityId, index], options);
    if (sameHex(tupleField(anchor, "contentHash", 2), expectedHash)) {
      return {
        index,
        anchor,
      };
    }
  }
  return { anchor: null };
}

function verification(preparedAudit, actual, anchor, mismatches) {
  if (anchor && !anchor.anchor) {
    mismatches.push({ field: "anchor", expected: preparedAudit.anchorHash, actual: null });
  }
  return Object.freeze({
    verified: mismatches.length === 0,
    status: mismatches.length === 0 ? "verified" : "mismatch",
    mismatches: Object.freeze(mismatches),
    expected: preparedAudit,
    actual,
    anchor,
  });
}

export async function verifyOpportunityAudit(input, options = {}) {
  const expected = asPrepared(input, prepareOpportunityCommit);
  const actual = await readWithRetries("getOpportunity", [expected.entityId], options);
  const mismatches = [];
  if (expected.expectedOwner) {
    mismatch(mismatches, "owner", expected.expectedOwner,
      tupleField(actual, "owner", 0), sameHex);
  }
  mismatch(mismatches, "contentHash", expected.contentHash,
    tupleField(actual, "contentHash", 2), sameHex);
  mismatch(mismatches, "kind", Number(expected.args[1]),
    Number(tupleField(actual, "kind", 1)));
  mismatch(mismatches, "expiresAt", expected.args[3],
    BigInt(tupleField(actual, "expiresAt", 5)));
  const anchor = await findMatchingAnchor(
    expected.entityId, expected.anchorHash, options,
  );
  return verification(expected, actual, anchor, mismatches);
}

export async function verifyProposalAudit(input, options = {}) {
  const expected = asPrepared(input, prepareProposalCommit);
  const actual = await readWithRetries("getProposal", [expected.entityId], options);
  const mismatches = [];
  mismatch(mismatches, "opportunityId", expected.opportunityId,
    tupleField(actual, "opportunityId", 1), sameHex);
  mismatch(mismatches, "proposalHash", expected.proposalHash,
    tupleField(actual, "proposalHash", 4), sameHex);
  mismatch(mismatches, "solutionHash", expected.solutionHash,
    tupleField(actual, "solutionHash", 5), sameHex);
  const anchor = await findMatchingAnchor(
    expected.entityId, expected.anchorHash, options,
  );
  return verification(expected, actual, anchor, mismatches);
}
