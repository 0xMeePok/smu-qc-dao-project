import { httpsCallable } from "firebase/functions";
import { collection, doc, getDoc, getDocFromServer, getDocs, query, runTransaction, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { db, functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { toPostingRecord } from "./attachments.js";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../config/proposal.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { proposalBlockReason, validateProposal } from "./proposalValidation.js";

export function newProposalId() {
  requireFirebase();
  return doc(collection(db, "proposals")).id;
}
const proposalRef = (id) => doc(db, "proposals", id);
const authorRef = (problemId, uid) => doc(db, "problems", problemId, "proposalAuthors", uid.toLowerCase());

export function buildProposalDocument({ researcherId, posting, form, attachments = [] }) {
  const fields = [...PROPOSAL_FIELDS, ...(posting.opportunityType === OPEN_FUNDING_TYPE ? PROBLEM_FRAMING_FIELDS : [])];
  return {
    ...Object.fromEntries(fields.map(([key]) => [key, String(form[key] ?? "").trim()])),
    researcherId: researcherId.toLowerCase(),
    problemId: posting.id,
    postingOwnerId: posting.ownerId,
    opportunityType: posting.opportunityType || "business-problem",
    category: form.category,
    amount: Number(form.amount),
    currency: posting.currency,
    attachments: attachments.map(toPostingRecord),
    status: "submitted",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export async function findActiveProposal(problemId, uid) {
  requireFirebase();
  const slot = await getDoc(authorRef(problemId, uid));
  if (!slot.exists()) return null;
  const proposal = await findProposal(slot.data().proposalId);
  return proposal?.status !== "withdrawn" ? proposal : null;
}

export async function findProposal(id, { fromServer = false } = {}) {
  requireFirebase();
  const snapshot = await (fromServer ? getDocFromServer : getDoc)(proposalRef(id));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

// A per-author slot serializes concurrent tabs. A withdrawn submission remains
// in the history; its successor has a new id and a separate audit anchor.
export async function submitProposal({ proposalId, researcherId, posting, form, attachments = [] }) {
  requireFirebase();
  const uid = researcherId.toLowerCase();
  await runTransaction(db, async (transaction) => {
    const parent = await transaction.get(doc(db, "problems", posting.id));
    const current = parent.exists() ? { id: parent.id, ...parent.data() } : null;
    const reason = proposalBlockReason(current);
    if (reason) throw new Error(reason);
    if (current.currency !== posting.currency) throw new Error("The funding currency changed. Reload the opportunity before submitting.");
    if (Object.keys(validateProposal(form, current)).length) throw new Error("Complete all required proposal fields.");
    const slot = await transaction.get(authorRef(posting.id, uid));
    if (slot.exists()) {
      const previous = await transaction.get(proposalRef(slot.data().proposalId));
      if (!previous.exists() || previous.data().status !== "withdrawn") throw new Error("You already have an active proposal for this opportunity. View it in My Proposals.");
    }
    const record = buildProposalDocument({ researcherId: uid, posting: current, form, attachments });
    // The audit handoff persists its receipt after submission. In addition to
    // keeping wallet/serialization errors out of this transaction, this leaves
    // room for the full open-funding schema within the rules expression budget.
    transaction.set(proposalRef(proposalId), record);
    transaction.set(authorRef(posting.id, uid), { proposalId });
  });
  // A successful commit is success even if the optional read-back is interrupted.
  return { id: proposalId };
}

export async function withdrawProposal(id) {
  requireFirebase();
  await updateDoc(proposalRef(id), { status: "withdrawn", updatedAt: serverTimestamp() });
}
export async function updateProposalReceipt({ recordId, audit }) {
  requireFirebase();
  if (audit.status === "confirmed") {
    const { data } = await httpsCallable(functions, "confirmProposalAudit")({ proposalId: recordId });
    if (data?.status !== "confirmed" && data?.audit?.status !== "confirmed") {
      throw new Error("Server confirmation is queued. Refresh the receipt after its next verification check.");
    }
    return;
  }
  await updateDoc(proposalRef(recordId), { audit, updatedAt: serverTimestamp() });
}
export async function listProposals(field, uid) {
  requireFirebase();
  const snapshot = await getDocs(query(collection(db, "proposals"), where(field, "==", uid.toLowerCase())));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
}
