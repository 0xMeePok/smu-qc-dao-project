import { AUDIT_REGISTRY_CONFIG, getAuditRegistryAddress } from "../config/auditRegistry.js";
import { prepareOpportunityCommit, readReviewedOpportunity } from "./auditRegistry.js";
import { assertCurrentAuditRecord } from "./opportunityAuditFlow.js";
import { postingAuditPayload, fundingOpportunityAuditPayload } from "../../../firebase/functions/opportunityAuditPayload.js";
import { validReviewedParentAudit } from "../../../firebase/functions/publicationValidation.js";

function prepareParent(posting) {
  const funding = posting.opportunityType === "open-funding";
  return prepareOpportunityCommit({ recordId: posting.id,
    actor: AUDIT_REGISTRY_CONFIG.entityIdScheme === 2 ? posting.ownerId : undefined,
    payload: funding ? fundingOpportunityAuditPayload(posting) : postingAuditPayload(posting),
    kind: funding ? 1 : 0, expiresAt: posting.expiresAt, hashScheme: posting.audit?.schemaVersion ?? 1 });
}

export async function captureReviewedParentAudit(posting, options = {}) {
  await assertCurrentAuditRecord(posting, options);
  const prepared = prepareParent(posting);
  const revision = await readReviewedOpportunity(prepared, options);
  return { chainId: AUDIT_REGISTRY_CONFIG.chainId,
    contractAddress: getAuditRegistryAddress().toLowerCase(), entityId: prepared.entityId,
    contentHash: prepared.contentHash, ...revision };
}

/** Compare the newly fetched document and chain against the version on screen. */
export async function assertReviewedParentAudit(posting, reviewed, options = {}) {
  const prepared = assertReviewedParentDocument(posting, reviewed);
  const current = await readReviewedOpportunity(prepared, options);
  if (current.revisionIndex !== reviewed.revisionIndex || current.revisionDigest !== reviewed.revisionDigest) {
    throw new Error("The opportunity changed since you reviewed it. Reload it and review the new terms before signing.");
  }
}

export function assertReviewedParentDocument(posting, reviewed) {
  const prepared = prepareParent(posting);
  if (!validReviewedParentAudit(reviewed)
      || reviewed.chainId !== AUDIT_REGISTRY_CONFIG.chainId
      || reviewed.contractAddress !== getAuditRegistryAddress().toLowerCase()
      || reviewed.entityId !== prepared.entityId || reviewed.contentHash !== prepared.contentHash) {
    throw new Error("The opportunity changed since you reviewed it. Reload it and review the new terms before signing.");
  }
  return prepared;
}
