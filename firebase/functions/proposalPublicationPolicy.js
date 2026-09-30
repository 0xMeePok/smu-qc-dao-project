import { requireHalfUpfrontFundingTerms } from "./escrowProposalTerms.js";
import { isEscrowRegistry, normalizeFundingTerms } from "./escrowAudit.js";
import registry from "./auditRegistry.contract.json" with { type: "json" };

/** Escrow publications and corrections always use the fixed 50/50 policy. */
export function requireProposalPublicationFundingPolicy(record, { registryConfig = registry } = {}) {
  if (!isEscrowRegistry(registryConfig)) return;
  requireHalfUpfrontFundingTerms(normalizeFundingTerms(record.fundingTerms));
}
