import { AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { MAX_ANCHOR_SCAN } from "../../../firebase/functions/auditCanonical.js";
import { isActiveAuditDeployment, resolveAuditDeployment } from "../../../firebase/functions/auditDeployments.js";
import { loadEscrowVerification } from "../../../firebase/functions/escrowAudit.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";

const slots = new Map();
const retained = new Map();
const pendingAudit = new Set();

const keyOf = (entityId) => String(entityId ?? "").toLowerCase();

function pinReads(adapters, config, block) {
  if (typeof block?.number !== "bigint") throw new Error("Could not read the current escrow block. Please refresh.");
  return (request) => adapters.readContract({ ...request, chainId: config.chainId, blockNumber: block.number });
}

function ensureAuditPromise(slot) {
  if (slot.auditPromise) return slot.auditPromise;
  slot.auditPromise = new Promise((resolve, reject) => {
    slot.resolveAudit = resolve;
    slot.rejectAudit = reject;
  });
  return slot.auditPromise;
}

function scheduleAnchors(readContract, config, entityId, count) {
  const total = BigInt(count);
  const scan = Math.min(Number(total), MAX_ANCHOR_SCAN);
  if (!Number.isSafeInteger(scan) || scan <= 0) return { indexes: [], anchors: [] };
  const indexes = Array.from({ length: scan }, (_, offset) => total - 1n - BigInt(offset));
  return Promise.all(indexes.map((index) => readContract({
    address: config.address, abi: config.abi, functionName: "anchorAt", args: [entityId, index],
  }))).then((anchors) => ({ indexes, anchors }));
}

function scheduleAudit(slot, readContract, config, expected) {
  if (slot.auditScheduled) return;
  slot.auditScheduled = true;
  ensureAuditPromise(slot);
  const proposal = readContract({
    address: config.address, abi: config.abi, functionName: "getProposal", args: [expected.entityId],
  });
  const count = readContract({
    address: config.address, abi: config.abi, functionName: "anchorCount", args: [expected.entityId],
  });
  // count resolves with the linkage multicall. The anchor reads are attached
  // before that result is awaited, so they join the identity wave.
  const anchors = count.then((value) => scheduleAnchors(readContract, config, expected.entityId, value));
  Promise.all([proposal, anchors]).then(
    ([proposalRecord, anchorBundle]) => slot.resolveAudit({ proposal: proposalRecord, ...anchorBundle }),
    (error) => slot.rejectAudit(error),
  );
}

/**
 * Display-only. Starts the block and deployment transaction, then one multicall
 * for linkage plus the proposal record and anchor count. Audit display reads
 * attach before that multicall is built. Writes do not call this.
 */
export function beginEscrowDisplay({ proposal, adapters, config = AUDIT_REGISTRY_CONFIG }) {
  const expected = prepareStoredProposal(proposal, { registryConfig: config });
  const key = keyOf(expected.entityId);
  const existing = slots.get(key);
  if (existing) return existing;
  const usingConfigured = config === AUDIT_REGISTRY_CONFIG;
  const slot = {
    wantAudit: pendingAudit.has(key),
    auditScheduled: false,
    auditPromise: null,
    scheduleAudit: null,
    ready: null,
  };
  if (slot.wantAudit) ensureAuditPromise(slot);
  slots.set(key, slot);
  slot.ready = Promise.all([
    usingConfigured
      ? resolveAuditDeployment(proposal, { getTransaction: adapters.getTransaction, activeConfig: AUDIT_REGISTRY_CONFIG })
      : config,
    adapters.getBlock({ chainId: config.chainId, blockTag: "latest" }),
  ]).then(([resolved, block]) => {
    const readContract = pinReads(adapters, resolved, block);
    const canonical = loadEscrowVerification({
      expected, config: resolved, readContract, allowImmutableCache: true,
    });
    slot.scheduleAudit = () => scheduleAudit(slot, readContract, resolved, expected);
    if (slot.wantAudit) slot.scheduleAudit();
    canonical.finally(() => {
      if (slot.auditPromise) retained.set(key, slot.auditPromise);
      if (slots.get(key) === slot) slots.delete(key);
      pendingAudit.delete(key);
      setTimeout(() => { if (retained.get(key) === slot.auditPromise) retained.delete(key); }, 5_000);
    });
    return {
      block,
      config: resolved,
      isHistorical: usingConfigured && !isActiveAuditDeployment(resolved, AUDIT_REGISTRY_CONFIG),
    };
  });
  slot.ready.catch((error) => slot.rejectAudit?.(error));
  return slot;
}

/** Marks this proposal's display read to include getProposal, anchorCount and anchorAt. */
export function requestDisplayAudit(entityId) {
  const key = keyOf(entityId);
  if (!key) return null;
  pendingAudit.add(key);
  const slot = slots.get(key);
  if (!slot) return retained.get(key) ?? null;
  slot.wantAudit = true;
  ensureAuditPromise(slot);
  slot.scheduleAudit?.();
  return slot.auditPromise;
}

/** The joined audit reads, once a display escrow read is in flight. Null when there is none. */
export function claimDisplayAudit(entityId) {
  return requestDisplayAudit(entityId);
}
