import { decodeFunctionData } from "viem";
import { prepareOpportunityCommit } from "./auditCanonical.js";
import { postingAuditPayload, fundingOpportunityAuditPayload } from "./opportunityAuditPayload.js";
import { registryAddress, verifyMinedProposal } from "./proposalAuditRecovery.js";
import registry from "./auditRegistry.contract.json" with { type: "json" };
import { getStorage } from "firebase-admin/storage";
import { createHash } from "node:crypto";

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export async function verifyPublication({ scope, record, client, readAttachment }) {
  if (scope === "proposals") return verifyMinedProposal(record, client, { readAttachment });
  const openFunding = record.opportunityType === "open-funding";
  const expected = prepareOpportunityCommit({ recordId: record.id,
    actor: registry.entityIdScheme === 2 ? record.ownerId : undefined,
    payload: openFunding ? fundingOpportunityAuditPayload(record) : postingAuditPayload(record),
    kind: openFunding ? 1 : 0, expiresAt: record.expiresAt });
  const hash = record.audit?.transactionHash;
  if (!/^0x[0-9a-f]{64}$/i.test(hash ?? "")) throw new Error("A mined audit transaction is required before publishing.");
  const address = registryAddress();
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash }), client.getTransaction({ hash }),
  ]);
  if (receipt.status !== "success" || !same(transaction.to, address)
      || !same(transaction.from, record.ownerId) || Number(transaction.chainId) !== registry.chainId
      || !same(receipt.transactionHash, hash) || !same(transaction.hash, hash)
      || typeof receipt.blockNumber !== "bigint" || receipt.blockNumber !== transaction.blockNumber
      || !receipt.blockHash || !same(receipt.blockHash, transaction.blockHash)) {
    throw new Error("The audit transaction does not belong to this record and wallet.");
  }
  const [block, nextBlock] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }),
    client.getBlock({ blockNumber: receipt.blockNumber + 1n }),
  ]);
  if (!same(block.hash, receipt.blockHash) || !same(nextBlock.parentHash, block.hash)) {
    throw new Error("The audit transaction needs another confirmation. Retry shortly.");
  }
  const decoded = decodeFunctionData({ abi: registry.abi, data: transaction.input });
  const args = decoded.functionName === "commitOpportunity" ? expected.args
    : decoded.functionName === "updateOpportunity" ? [expected.entityId, expected.contentHash, expected.args[3]] : null;
  if (!args || args.length !== decoded.args.length || args.some((v, i) => !same(v, decoded.args[i]))) {
    throw new Error("The content differs from its audit transaction.");
  }
  const actual = await client.readContract({ address, abi: registry.abi, functionName: "getOpportunity", args: [expected.entityId] });
  const value = (key, index) => actual[key] ?? actual[index];
  if (!same(value("owner", 0), record.ownerId) || !same(value("contentHash", 2), expected.contentHash)
      || !same(value("kind", 1), expected.args[1]) || !same(value("expiresAt", 5), expected.args[3])
      || value("withdrawn", 6) === true) {
    throw new Error("The content differs from the current audit registry record.");
  }
  for (const attachment of record.attachments ?? []) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(attachment.id ?? "")) throw new Error("Invalid attachment.");
    const path = `problems/${record.ownerId}/${record.id}/${attachment.id}.pdf`;
    const bytes = readAttachment ? await readAttachment(path) : (await getStorage().bucket().file(path).download())[0];
    if (bytes.length !== attachment.size || (attachment.sha256
        && `0x${createHash("sha256").update(bytes).digest("hex")}` !== attachment.sha256)) {
      throw new Error("The attachment differs from the publication content.");
    }
  }
  return { ...record.audit, entityId: expected.entityId, contentHash: expected.contentHash,
    status: "confirmed", blockNumber: Number(receipt.blockNumber), lastError: "" };
}
