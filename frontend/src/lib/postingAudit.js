import { OPPORTUNITY_KIND } from "../config/auditRegistry.js";
import {
  configuredAuditRegistryAddress,
  createOpportunityAuditFlow,
} from "./opportunityAuditFlow.js";
import { postingAuditPayload, updatePostingAudit } from "./postings.js";

const postingAudit = createOpportunityAuditFlow({
  kind: OPPORTUNITY_KIND.BUSINESS_PROBLEM,
  payloadFor: postingAuditPayload,
  persistAudit: ({ recordId, audit }) => updatePostingAudit({ postingId: recordId, audit }),
  entityLabel: "posting",
});

export { configuredAuditRegistryAddress };
export const preparePostingAudit = postingAudit.prepare;
export const postingAuditReceipt = postingAudit.receipt;
export const readPostingAudit = postingAudit.read;
export const anchorPostingAudit = postingAudit.anchor;
