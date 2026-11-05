import { doc, runTransaction, serverTimestamp } from "firebase/firestore";

/** Create once per evaluator/proposal, retaining arbitrary evaluation document
 * ids. Slots are permanent even after a draft is deleted. Legacy records keep
 * their ids and can be updated directly with the normalized expiry boolean.
 */
export async function createEvaluation(db, evaluationId, record) {
  const { evaluatorId, proposalId } = record;
  if (!/^0x[0-9a-f]{40}$/.test(evaluatorId ?? "") || typeof proposalId !== "string"
      || !proposalId.length || proposalId.length > 128 || proposalId.includes("/")) {
    throw new TypeError("A proposal and evaluator wallet are required.");
  }
  const ref = doc(db, "evaluations", evaluationId);
  const slotRef = doc(db, "evaluationSlots", `${proposalId}_${evaluatorId}`);
  await runTransaction(db, async tx => {
    const slot = await tx.get(slotRef);
    if (slot.exists()) throw new Error("This evaluator already has an evaluation for the proposal.");
    tx.set(ref, { ...record, status: "draft", expiryAccepted: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    tx.set(slotRef, { evaluatorId, proposalId, evaluationId, createdAt: serverTimestamp() });
  });
  return evaluationId;
}

export function evaluationStatusUpdate(status) {
  if (!["draft", "submitted", "accepted"].includes(status)) throw new TypeError("Invalid evaluation status.");
  return { status, expiryAccepted: status === "accepted", updatedAt: serverTimestamp() };
}
