import { AUDIT_ENTITY_ID_SCHEME } from "../config/auditRegistry.js";
import { AUDIT_REGISTRY_CHAIN_ID, OPPORTUNITY_KIND } from "../config/auditRegistry.js";
import {
  configuredAuditRegistryAddress,
  createOpportunityAuditFlow,
} from "./opportunityAuditFlow.js";
import { findPosting, postingAuditPayload, updatePostingAudit } from "./postings.js";
import {
  createWagmiAuditAdapters,
  prepareOpportunityWithdrawal,
  withdrawOpportunityAudit,
  writeOpportunityAudit,
} from "./auditRegistry.js";
import {
  isExpiredOpenOpportunity,
  isResponseWindowClosed,
} from "../../../firebase/functions/opportunityExpiry.js";

const postingAudit = createOpportunityAuditFlow({
  kind: OPPORTUNITY_KIND.BUSINESS_PROBLEM,
  payloadFor: postingAuditPayload,
  loadRecord: findPosting,
  persistAudit: ({ recordId, audit }) => updatePostingAudit({ postingId: recordId, audit }),
  entityLabel: "posting",
  commitAudit: writeOpportunityAudit,
});

export { configuredAuditRegistryAddress };
export const preparePostingAudit = postingAudit.prepare;
export const postingAuditReceipt = postingAudit.receipt;
export const readPostingAudit = postingAudit.read;
export const anchorPostingAudit = postingAudit.anchor;

export function receiptForWrite(audit) {
  return audit && audit.status === "confirmed" ? { ...audit, status: "pending" } : audit;
}

export function anchorOpportunityBeforeWrite(record, options = {}) {
  return postingAudit.anchor(record, { ...options, persistReceipt: false });
}

/** Chain time, not the browser clock: withdrawOpportunity has no deadline check of its own. */
export async function assertWithdrawalWindowOpen(record, adapters) {
  let now = Date.now();
  try {
    const block = await (adapters ?? createWagmiAuditAdapters()).getBlock?.({ chainId: AUDIT_REGISTRY_CHAIN_ID });
    if (typeof block?.timestamp === "bigint") now = Number(block.timestamp) * 1000;
  } catch {
    // An unreachable node fails the wallet step anyway; fall back to the local clock.
  }
  if (isExpiredOpenOpportunity(record, now)) {
    throw new Error("The response window has closed, so this opportunity will lapse automatically instead of being withdrawn.");
  }
  if (isResponseWindowClosed(record, now)) {
    throw new Error("The response window has closed, so this opportunity can no longer be withdrawn.");
  }
}

export async function anchorOpportunityWithdrawal(record, { account, adapters, reason, onStatus } = {}) {
  const address = configuredAuditRegistryAddress();
  if (!address) throw new Error("AuditRegistry is not configured.");
  await assertWithdrawalWindowOpen(record, adapters);
  return withdrawOpportunityAudit(
    prepareOpportunityWithdrawal({
      recordId: record.id, ownerId: record.ownerId, reason,
      actor: AUDIT_ENTITY_ID_SCHEME === 2 ? record.ownerId : undefined,
    }),
    { address, account, adapters, onStatus },
  );
}
