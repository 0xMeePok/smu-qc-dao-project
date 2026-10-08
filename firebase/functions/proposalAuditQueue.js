import { prepareStoredProposal } from "./proposalAuditPayload.js";
import { isIndependentProposal } from "./independentProposal.js";

/** Receipt context comes from the current record, not the recovery job's title. */
export function proposalAuditQueueMetadata(id, data) {
  let audit = data?.audit || null;
  if (data) {
    try {
      const prepared = prepareStoredProposal({ ...data, id });
      audit = { chainId: 421614, status: "queued", attemptCount: 0, ...audit,
        schemaVersion: prepared.hashScheme, entityId: prepared.entityId,
        contentHash: prepared.contentHash, solutionHash: prepared.solutionHash };
    } catch { audit = null; }
  }
  return {
    audit,
    proposalKind: data?.proposalKind ?? null,
    problemId: !isIndependentProposal(data) && typeof data?.problemId === "string" ? data.problemId : null,
  };
}
