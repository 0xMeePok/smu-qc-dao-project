export const EVALUATION_EXPIRY_MIGRATION = "evaluationExpiryV1";

// Preserve the legacy expiry assessment exactly, including missing statuses.
export function evaluationExpiryAccepted(record) {
  return String(record?.status ?? "").trim().toLowerCase() === "accepted";
}

export function evaluationSlotId(proposalId, evaluatorId) {
  if (typeof proposalId !== "string" || !proposalId.length || proposalId.length > 128 || proposalId.includes("/")
      || !/^0x[0-9a-f]{40}$/.test(evaluatorId ?? "")) {
    throw new TypeError("A proposal id and lowercase wallet address are required.");
  }
  return `${proposalId}_${evaluatorId}`;
}
