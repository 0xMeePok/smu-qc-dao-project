import registry from "./auditRegistry.contract.json" with { type: "json" };
import { asEscrowProposal, prepareOpportunityCommit, prepareProposalCommit } from "./auditCanonical.js";
import { isEscrowRegistry } from "./escrowAudit.js";
import { fundingAmountText, validateStoredFundingTerms } from "./escrowProposalTerms.js";
import {
  INDEPENDENT_PROPOSAL_HASH_SCHEME,
  INDEPENDENT_PROPOSAL_KIND,
  isIndependentProposal,
} from "./independentProposal.js";

// Frozen v1 field list. Changing a form label or adding a field must not change
// historical hashes. Introduce a new scheme explicitly for future payloads.
const FIELDS = [
  "researcherId", "problemId", "postingOwnerId", "opportunityType", "category", "amount", "currency",
  "title", "summary", "methodology", "suitability", "expectedOutcomes", "successCriteria",
  "timeline", "milestones", "team", "proposedProblem", "relevance", "thesisFit",
];

const trimmed = (value) => String(value ?? "").trim();

export function proposalAuditPayload(record) {
  if (isIndependentProposal(record)) return independentProposalAuditPayload(record);
  return Object.fromEntries(FIELDS.map((key) => [key,
    key === "amount" ? String(record.amount ?? "") : record[key] ?? "",
  ]));
}

/**
 * Scheme 2 payload for a listing that is not filed against a parent posting.
 * `ownerId` mirrors the researcher so commitOpportunity can bind the wallet.
 * Attached v1 hashes are unchanged because they never enter this branch.
 */
export function independentProposalAuditPayload(record) {
  const researcherId = trimmed(record.researcherId).toLowerCase();
  const amount = Number(record.amount) || 0;
  // Scheme 2 historically encoded integer amounts as numbers. Preserve those
  // hashes byte for byte. Fractional numbers were never canonicalizable; encode
  // new cent targets explicitly as decimal text without relaxing the canonicalizer.
  const fractional = !Number.isSafeInteger(amount);
  const amountText = fractional ? fundingAmountText(amount) : null;
  if (fractional && (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000
      || !/^\d+\.\d{1,2}$/.test(amountText))) {
    throw new TypeError("Funding targets support at most 2 decimal places.");
  }
  const attachments = [...(record.attachments ?? [])]
    .map((item) => ({
      id: trimmed(item.id),
      name: trimmed(item.name),
      size: Number(item.size),
      contentType: trimmed(item.contentType || "application/pdf"),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    proposalKind: INDEPENDENT_PROPOSAL_KIND,
    researcherId,
    ownerId: researcherId,
    category: trimmed(record.category),
    amount: fractional ? amountText : amount,
    ...(fractional ? { amountEncoding: "decimal-v1" } : {}),
    currency: trimmed(record.currency),
    title: trimmed(record.title),
    summary: trimmed(record.summary),
    methodology: trimmed(record.methodology),
    addressedProblems: trimmed(record.addressedProblems),
    maturity: trimmed(record.maturity),
    team: trimmed(record.team),
    expiresAt: record.expiresAt,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function prepareStoredProposal(record, { registryConfig = registry } = {}) {
  if (record.fundingPlan !== undefined) throw new Error("Submit a complete escrow payment plan before verification.");
  if (!isEscrowRegistry(registryConfig) && record.fundingTerms !== undefined) {
    throw new Error("Escrow funding terms require the escrow-linked registry deployment.");
  }
  if (isIndependentProposal(record)) {
    return prepareOpportunityCommit({
      recordId: record.id,
      actor: registryConfig.entityIdScheme === 2 ? record.researcherId : undefined,
      payload: independentProposalAuditPayload(record),
      kind: 2,
      expiresAt: record.expiresAt,
      hashScheme: INDEPENDENT_PROPOSAL_HASH_SCHEME,
    });
  }
  const hashScheme = record.audit?.schemaVersion ?? 1;
  if (hashScheme !== 1) {
    throw new TypeError("Attached proposals use canonical audit hash scheme 1.");
  }
  const proposal = proposalAuditPayload(record);
  const prepared = prepareProposalCommit({
    recordId: record.id,
    actor: registryConfig.entityIdScheme === 2 ? record.researcherId : undefined,
    opportunityActor: registryConfig.entityIdScheme === 2 ? record.postingOwnerId : undefined,
    opportunityRecordId: record.problemId,
    expectedOpportunityRevisionIndex: 0,
    hashScheme,
    proposalPayload: proposal,
    // The whole record plus its files, mirroring the opportunity's single
    // contentHash. AuditRegistry records each hash once per proposal, and
    // attachments are frozen after submission - so a narrow
    // {methodology, attachments} slice left this hash unmoved on any other edit
    // and the amendment reverted. Both hashes now move together, and the
    // `solution` document label still keeps them distinct.
    solutionPayload: {
      ...proposal,
      attachments: [...(record.attachments ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    },
  });
  return isEscrowRegistry(registryConfig) ? asEscrowProposal(prepared, validateStoredFundingTerms(record, registryConfig)) : prepared;
}

/**
 * Child proposal under the listing's own funding-request opportunity.
 * `prepareStoredProposal` stays an opportunity commit so publication hashes
 * do not change. The researcher signs this separately to link an escrow.
 */
export function prepareIndependentEscrowCommit(record, { registryConfig = registry } = {}) {
  if (!isIndependentProposal(record)) throw new TypeError("An independent listing is required.");
  if (!record.fundingTerms) throw new TypeError("Escrow funding terms are required.");
  if (!isEscrowRegistry(registryConfig)) {
    throw new Error("Escrow funding terms require the escrow-linked registry deployment.");
  }
  const actor = registryConfig.entityIdScheme === 2 ? record.researcherId : undefined;
  const payload = independentProposalAuditPayload(record);
  const prepared = prepareProposalCommit({
    recordId: record.id,
    opportunityRecordId: record.id,
    actor,
    opportunityActor: actor,
    expectedOpportunityRevisionIndex: 0,
    hashScheme: INDEPENDENT_PROPOSAL_HASH_SCHEME,
    proposalPayload: payload,
    solutionPayload: {
      ...payload,
      attachments: [...(record.attachments ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    },
  });
  return asEscrowProposal(prepared, validateStoredFundingTerms(record, registryConfig));
}
