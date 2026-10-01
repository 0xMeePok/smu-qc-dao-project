import { requireHalfUpfrontFundingTerms } from "./escrowProposalTerms.js";
import { isEscrowRegistry, normalizeFundingTerms } from "./escrowAudit.js";
import { isIndependentProposal } from "./independentProposal.js";
import registry from "./auditRegistry.contract.json" with { type: "json" };

/** Escrow publications and corrections always use the fixed 50/50 policy. */
export function requireProposalPublicationFundingPolicy(record, { registryConfig = registry } = {}) {
  if (!isEscrowRegistry(registryConfig)) return;
  // Independent listings pin only the 50/50 split in firestore.rules. Content
  // edits do not rebuild the six-field canonical map, and a missing map must
  // not block them — the on-chain opportunity hash does not include escrow terms.
  if (isIndependentProposal(record)) {
    const terms = record.fundingTerms;
    if (terms == null) return;
    requireHalfUpfrontFundingTerms({
      trancheBps: Array.isArray(terms.trancheBps) ? terms.trancheBps : [],
    });
    return;
  }
  requireHalfUpfrontFundingTerms(normalizeFundingTerms(record.fundingTerms));
}
