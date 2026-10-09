import { configuredFundingToken, fundingAmountUnits, requireHalfUpfrontFundingTerms } from "./escrowProposalTerms.js";
import { fundingTargetError } from "./fundingAmountPolicy.js";
import { isEscrowRegistry, normalizeFundingTerms } from "./escrowAudit.js";
import { isIndependentProposal } from "./independentProposal.js";
import registry from "./auditRegistry.contract.json" with { type: "json" };

/** Validate new publications, without preventing corrections to a legacy target. */
export function requireNewProposalTargetPolicy(record, { registryConfig = registry, existingRecord } = {}) {
  if (!isEscrowRegistry(registryConfig)) return;
  if (existingRecord && existingRecord.status !== "draft"
      && existingRecord.amount === record.amount && existingRecord.currency === record.currency) return;
  const token = configuredFundingToken(registryConfig, record.currency);
  const error = fundingTargetError({ targetBaseUnits: fundingAmountUnits(record.amount, token.decimals),
    decimals: token.decimals, symbol: token.symbol });
  if (error) throw new TypeError(error);
}

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
