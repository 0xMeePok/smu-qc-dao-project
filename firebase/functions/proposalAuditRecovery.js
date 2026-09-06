import { decodeFunctionData } from "viem";
import { createHash } from "node:crypto";
import { getStorage } from "firebase-admin/storage";
import { prepareStoredProposal } from "./proposalAuditPayload.js";
import registry from "./auditRegistry.contract.json" with { type: "json" };

export const AUDIT_JOBS = "proposalAuditJobs";
export const RETRY_LIMIT = 3;
export const PROPOSAL_CONFIRMATIONS = 2n;
export const retryDelay = (attempt) => 60_000 * 2 ** Math.max(0, attempt - 1);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function readAttachmentBytes(path) {
  const [bytes] = await getStorage().bucket().file(path).download();
  return bytes;
}

async function verifyAttachmentBytes(record, reader = readAttachmentBytes) {
  for (const attachment of record.attachments ?? []) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(attachment?.id ?? "")
        || !/^0x[0-9a-f]{64}$/.test(attachment?.sha256 ?? "")) {
      throw new Error("Mismatch detected: the proposal attachment digest is missing or invalid.");
    }
    const path = `proposals/${String(record.researcherId).toLowerCase()}/${record.id}/${attachment.id}.pdf`;
    const actual = `0x${createHash("sha256").update(await reader(path)).digest("hex")}`;
    if (actual !== attachment.sha256) {
      throw new Error("Mismatch detected: the stored proposal attachment differs from its recorded digest.");
    }
  }
}

export function registryAddress() {
  const address = process.env.AUDIT_REGISTRY_ADDRESS || registry.address;
  if (!/^0x[0-9a-f]{40}$/i.test(address) || /^0x0{40}$/i.test(address)) throw new Error("AuditRegistry configuration is invalid.");
  return address;
}

// Confirmation is a server attestation of a mined, successful commit for this
// exact stored record and researcher, never a client-supplied status or hash.
export async function verifyMinedProposal(record, client, { readAttachment = readAttachmentBytes } = {}) {
  const expected = prepareStoredProposal(record);
  const hash = record.audit?.transactionHash;
  if (!/^0x[0-9a-f]{64}$/i.test(hash ?? "")) throw new Error("The researcher must submit the wallet transaction first.");
  const address = registryAddress();
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash }), client.getTransaction({ hash }),
  ]);
  if (receipt.status !== "success") throw new Error("The verification transaction reverted. The proposal remains saved.");
  if (!same(transaction.to, address) || !same(transaction.from, record.researcherId)
      || !same(receipt.transactionHash, hash) || !same(transaction.hash, hash)
      || Number(transaction.chainId) !== registry.chainId) {
    throw new Error("The transaction does not belong to this researcher and AuditRegistry.");
  }
  if (typeof receipt.blockNumber !== "bigint" || typeof transaction.blockNumber !== "bigint"
      || !receipt.blockHash || !transaction.blockHash
      || receipt.blockNumber !== transaction.blockNumber || !same(receipt.blockHash, transaction.blockHash)) {
    throw new Error("The transaction is not final yet; its canonical block is not available.");
  }
  const [canonicalBlock, confirmationBlock] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }),
    client.getBlock({ blockNumber: receipt.blockNumber + PROPOSAL_CONFIRMATIONS - 1n }),
  ]);
  if (!same(canonicalBlock.hash, receipt.blockHash)
      || !same(confirmationBlock.parentHash, receipt.blockHash)) {
    throw new Error("The transaction is not final yet; confirmation will be checked again.");
  }
  const decoded = decodeFunctionData({ abi: registry.abi, data: transaction.input });
  if (decoded.functionName !== "commitProposal" || decoded.args.length !== expected.args.length
      || decoded.args.some((arg, index) => !same(arg, expected.args[index]))) {
    throw new Error("Mismatch detected: the stored proposal differs from the submitted transaction.");
  }
  await verifyAttachmentBytes(record, readAttachment);
  const actual = await client.readContract({ address, abi: registry.abi, functionName: "getProposal", args: [expected.entityId] });
  const value = (key, index) => actual[key] ?? actual[index];
  if (!same(value("researcher", 0), record.researcherId)
      || !same(value("opportunityId", 1), expected.opportunityId)
      || Number(value("opportunityRevisionIndex", 2)) !== expected.expectedOpportunityRevisionIndex
      || !same(value("proposalHash", 4), expected.proposalHash)
      || !same(value("solutionHash", 5), expected.solutionHash)) {
    throw new Error("Mismatch detected: the current proposal differs from AuditRegistry.");
  }
  const blockNumber = Number(receipt.blockNumber);
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) throw new Error("Invalid confirmation block.");
  return { ...record.audit, entityId: expected.entityId, contentHash: expected.contentHash,
    status: "confirmed", blockNumber, lastError: "" };
}

export function recoveryError(error) {
  const text = [error?.name, error?.shortMessage, error?.message].filter(Boolean).join(" ");
  const transient = /notfound|not found|not final|canonical block|timeout|timed out|etimedout|econnreset|eai_again|enetunreach|temporar|http|socket|network|fetch|429|500|502|503|504|gateway/i.test(text);
  return { transient, message: transient
    ? "Proposal saved. Confirmation is not available yet; the same transaction will be checked again."
    : /mismatch|reverted|does not belong|must submit|configuration/i.test(text)
      ? error.message.slice(0, 500)
      : "Proposal saved. Verification could not be completed; an administrator can inspect and retry it." };
}

export async function enqueueProposalAudit({ db, record, now }) {
  if (!record || record.status === "draft" || record.audit?.status === "confirmed") return;
  const ref = db.collection(AUDIT_JOBS).doc(record.id);
  const hash = record.audit?.transactionHash || "";
  await db.runTransaction(async (tx) => {
    const current = await tx.get(db.collection("proposals").doc(record.id));
    if (!current.exists || current.data().audit?.status === "confirmed"
        || (current.data().audit?.transactionHash || "") !== hash) return;
    const old = await tx.get(ref);
    if (old.exists && old.data().transactionHash === hash) return;
    tx.set(ref, { proposalId: record.id, title: record.title, researcherId: record.researcherId,
      transactionHash: hash, status: hash ? "pending" : "waiting-wallet", attemptCount: 0,
      nextAttemptAt: now, updatedAt: now, lastError: "" });
  });
}

export async function recoverProposalAudit({ db, client, proposalId, now, Timestamp, manual = false }) {
  const jobRef = db.collection(AUDIT_JOBS).doc(proposalId);
  const recordRef = db.collection("proposals").doc(proposalId);
  // Lease prevents callable, trigger and scheduler from racing each other.
  const job = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(jobRef);
    if (!snapshot.exists) throw new Error("Verification has not been queued yet. Refresh and try again.");
    const data = snapshot.data();
    if (data.leaseUntil?.toMillis() > now.toMillis()) throw new Error("Verification is already being checked. Refresh shortly.");
    if (!data.transactionHash) throw new Error("The researcher must submit the wallet transaction first.");
    if (!manual && (data.attemptCount >= RETRY_LIMIT || data.nextAttemptAt.toMillis() > now.toMillis())) return null;
    const attemptCount = manual ? 1 : data.attemptCount + 1;
    tx.update(jobRef, { attemptCount, leaseUntil: Timestamp.fromMillis(now.toMillis() + 90_000) });
    return { ...data, attemptCount };
  });
  if (!job) return null;
  let audit, failure;
  let record;
  try {
    const snapshot = await recordRef.get();
    record = snapshot.exists ? { ...snapshot.data(), id: snapshot.id } : null;
    if (!record || record.audit?.transactionHash !== job.transactionHash) throw new Error("The proposal or transaction has changed. Refresh verification.");
    audit = await verifyMinedProposal(record, client);
  } catch (error) { failure = recoveryError(error); }
  const saved = await db.runTransaction(async (tx) => {
    const [latest, latestJob] = await Promise.all([tx.get(recordRef), tx.get(jobRef)]);
    if (!latestJob.exists || latestJob.data().transactionHash !== job.transactionHash
        || latestJob.data().leaseUntil?.toMillis() !== now.toMillis() + 90_000) return false;
    let unchanged = false;
    try {
      unchanged = latest.exists && record && latest.data().audit?.transactionHash === job.transactionHash
        && prepareStoredProposal({ ...latest.data(), id: proposalId }).canonicalPayload === prepareStoredProposal(record).canonicalPayload
        && prepareStoredProposal({ ...latest.data(), id: proposalId }).canonicalSolution === prepareStoredProposal(record).canonicalSolution;
    } catch { /* Unsupported or changed data must never be confirmed. */ }
    if (!unchanged) {
      tx.update(jobRef, { status: "failed", lastError: "The record changed during verification. Refresh and retry.", leaseUntil: now });
      return false;
    }
    if (audit) tx.update(recordRef, { audit, updatedAt: now });
    const retry = failure?.transient && job.attemptCount < RETRY_LIMIT;
    if (failure && latest.data().audit?.status !== "confirmed") {
      tx.update(recordRef, { "audit.status": retry ? "pending" : "failed", "audit.lastError": failure.message, updatedAt: now });
    }
    tx.update(jobRef, { status: audit ? "confirmed" : retry ? "pending" : "failed",
      lastError: failure?.message || "", updatedAt: now, leaseUntil: now,
      nextAttemptAt: Timestamp.fromMillis(now.toMillis() + retryDelay(job.attemptCount)) });
    return true;
  });
  if (!saved) throw new Error("The record changed during verification. Refresh and retry.");
  if (failure) throw new Error(failure.message);
  return audit;
}
