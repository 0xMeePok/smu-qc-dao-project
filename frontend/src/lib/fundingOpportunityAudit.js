import { OPPORTUNITY_KIND } from "../config/auditRegistry.js";
import { createOpportunityAuditFlow } from "./opportunityAuditFlow.js";
import {
  fundingOpportunityAuditPayload,
  updateFundingOpportunityAudit,
} from "./fundingOpportunities.js";

const fundingOpportunityAudit = createOpportunityAuditFlow({
  kind: OPPORTUNITY_KIND.OPEN_FUNDING,
  payloadFor: fundingOpportunityAuditPayload,
  persistAudit: ({ recordId, audit }) => updateFundingOpportunityAudit({
    opportunityId: recordId,
    audit,
  }),
  entityLabel: "funding opportunity",
});

export const prepareFundingOpportunityAudit = fundingOpportunityAudit.prepare;
export const fundingOpportunityAuditReceipt = fundingOpportunityAudit.receipt;
export const readFundingOpportunityAudit = fundingOpportunityAudit.read;
export const anchorFundingOpportunityAudit = fundingOpportunityAudit.anchor;
