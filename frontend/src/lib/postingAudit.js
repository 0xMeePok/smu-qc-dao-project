import { OPPORTUNITY_KIND } from "../config/auditRegistry.js";
import {
  configuredAuditRegistryAddress,
  createOpportunityAuditFlow,
} from "./opportunityAuditFlow.js";
import { findPosting, postingAuditPayload, updatePostingAudit } from "./postings.js";
import {
  prepareOpportunityWithdrawal,
  withdrawOpportunityAudit,
  writeOpportunityAudit,
} from "./auditRegistry.js";

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

export async function anchorOpportunityWithdrawal(record, { account, adapters, reason, onStatus } = {}) {
  const address = configuredAuditRegistryAddress();
  if (!address) throw new Error("AuditRegistry is not configured.");
  return withdrawOpportunityAudit(
    prepareOpportunityWithdrawal({
      recordId: record.id, ownerId: record.ownerId, reason,
    }),
    { address, account, adapters, onStatus },
  );
}
