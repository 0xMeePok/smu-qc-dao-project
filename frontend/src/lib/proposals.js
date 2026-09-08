import { httpsCallable } from "firebase/functions";
import { collection, deleteDoc, deleteField, doc, getDoc, getDocFromServer, getDocs, query, runTransaction, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { db, functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { deleteAttachment, toPostingRecord } from "./attachments.js";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../config/proposal.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { proposalBlockReason, validateProposal } from "./proposalValidation.js";

export const PROPOSAL_STATUS_DRAFT = "draft";
export const PROPOSAL_STATUS_SUBMITTED = "submitted";

/** Statuses the author may still correct. `under_review` is where the lock falls. */
export const EDITABLE_PROPOSAL_STATUSES = [PROPOSAL_STATUS_DRAFT, PROPOSAL_STATUS_SUBMITTED];

export function newProposalId() {
  requireFirebase();
  return doc(collection(db, "proposals")).id;
}
const proposalRef = (id) => doc(db, "proposals", id);
const authorRef = (problemId, uid) => doc(db, "problems", problemId, "proposalAuthors", uid.toLowerCase());
const revisionsRef = (id) => collection(db, "proposals", id, "revisions");

function amountOf(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
}

export function buildProposalDocument({ researcherId, posting, form, attachments = [], status = PROPOSAL_STATUS_SUBMITTED }) {
  const fields = [...PROPOSAL_FIELDS, ...(posting.opportunityType === OPEN_FUNDING_TYPE ? PROBLEM_FRAMING_FIELDS : [])];
  const record = {
    ...Object.fromEntries(fields.map(([key]) => [key, String(form[key] ?? "").trim()])),
    researcherId: researcherId.toLowerCase(),
    problemId: posting.id,
    opportunityType: posting.opportunityType || "business-problem",
    category: String(form.category ?? ""),
    amount: amountOf(form.amount),
    currency: posting.currency,
    attachments: attachments.map(toPostingRecord),
    status,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (status !== PROPOSAL_STATUS_DRAFT) record.postingOwnerId = posting.ownerId;
  return record;
}

export async function findActiveProposal(problemId, uid) {
  requireFirebase();
  const slot = await getDoc(authorRef(problemId, uid));
  if (!slot.exists()) return null;
  const proposal = await findProposal(slot.data().proposalId);
  return proposal?.status !== "withdrawn" ? proposal : null;
}

export async function findProposalDraft(problemId, uid) {
  requireFirebase();
  const snapshot = await getDocs(query(
    collection(db, "proposals"),
    where("researcherId", "==", uid.toLowerCase()),
    where("problemId", "==", problemId),
    where("status", "==", PROPOSAL_STATUS_DRAFT),
  ));
  const [found] = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
  return found ?? null;
}

export async function findProposal(id, { fromServer = false } = {}) {
  requireFirebase();
  const snapshot = await (fromServer ? getDocFromServer : getDoc)(proposalRef(id));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

export async function saveProposalDraft({ proposalId, researcherId, posting, form, attachments = [], exists = false }) {
  requireFirebase();
  const record = buildProposalDocument({
    researcherId, posting, form, attachments, status: PROPOSAL_STATUS_DRAFT,
  });
  if (exists) {
    // createdAt must equal request.time on create and never move afterwards.
    const { createdAt, ...rest } = record;
    await updateDoc(proposalRef(proposalId), rest);
  } else {
    await setDoc(proposalRef(proposalId), record);
  }
  return findProposal(proposalId);
}

/** Deletes an unsubmitted draft and the files it referenced. */
export async function deleteProposalDraft(proposal) {
  requireFirebase();
  // Files first: once the record is gone its attachment paths are unrecoverable
  // and the objects would be orphaned until the sweeper runs.
  await Promise.allSettled((proposal.attachments ?? []).map((attachment) => deleteAttachment({
    attachment, ownerId: proposal.researcherId, problemId: proposal.id, scope: "proposals",
  })));
  await deleteDoc(proposalRef(proposal.id));
}

export async function submitProposal({ proposalId, researcherId, posting, form, attachments = [], fromDraft = false, record: preparedRecord = null, audit = null }) {
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
    if (slot.exists() && slot.data().proposalId !== proposalId) {
      const previous = await transaction.get(proposalRef(slot.data().proposalId));
      if (!previous.exists() || previous.data().status !== "withdrawn") throw new Error("You already have an active proposal for this opportunity. View it in My Proposals.");
    }
    const built = preparedRecord ?? buildProposalDocument({ researcherId: uid, posting: current, form, attachments });
    const record = audit ? { ...built, audit: { ...audit } } : built;
    if (fromDraft) {
      const { createdAt, ...rest } = record;
      transaction.update(proposalRef(proposalId), rest);
    } else {
      transaction.set(proposalRef(proposalId), record);
    }
    transaction.set(authorRef(posting.id, uid), { proposalId });
  });
  // A successful commit is success even if the optional read-back is interrupted.
  return { id: proposalId };
}

export async function updateProposal({ proposalId, researcherId, posting, form, attachments = [], record: preparedRecord = null, audit = null }) {
  requireFirebase();
  const errors = validateProposal(form, posting);
  if (Object.keys(errors).length) throw new Error("Complete all required proposal fields.");
  const blocked = proposalBlockReason(posting);
  if (blocked) throw new Error(blocked);
  const built = preparedRecord ?? buildProposalDocument({ researcherId, posting, form, attachments });
  const { createdAt, ...record } = built;
  // The receipt for the amendment that was just anchored. Without one the stored
  // receipt would still describe the content this edit replaced, so it is cleared
  // rather than left to mislead.
  await updateDoc(proposalRef(proposalId), {
    ...record, audit: audit ? { ...audit } : deleteField(),
  });
  return findProposal(proposalId);
}

export async function withdrawProposal(id, reason) {
  requireFirebase();
  const withdrawalReason = String(reason ?? "").trim();
  if (withdrawalReason.length < 2) throw new Error("Give a reason for withdrawing this proposal.");
  if (withdrawalReason.length > 1000) throw new Error("Use 1,000 characters or fewer.");
  await updateDoc(proposalRef(id), { status: "withdrawn", withdrawalReason, updatedAt: serverTimestamp() });
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

export async function listProposalRevisions(proposalId, { field = "researcherId", uid }) {
  requireFirebase();
  const snapshot = await getDocs(query(revisionsRef(proposalId), where(field, "==", String(uid).toLowerCase())));
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0));
}
