import { isIndependentProposal } from "./independentProposal.js";

const STATUS = Object.freeze({ Open: "submitted", Accepted: "accepted", Released: "completed",
  Declined: "declined", Expired: "expired", Cancelled: "cancelled", Refunded: "refunded" });
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const amount = value => { try { return BigInt(value || 0); } catch { return 0n; } };

const ZERO_EVIDENCE = /^0x0+$/;
const hasEvidence = (summary) => Boolean(summary?.evidenceHash) && !ZERO_EVIDENCE.test(summary.evidenceHash);
/** A cached vote counts only for the evidence version it was recorded against. */
function votedOnCurrentEvidence(position, summary) {
  if (position?.hasVoted !== true) return false;
  if (position.evidenceVersion != null) return String(position.evidenceVersion) === String(summary.evidenceVersion);
  return Number(position.blockNumber) >= Number(summary.blockNumber);
}

/** Dashboard projections are cached hints. Every wallet action rechecks the chain. */
export async function readIndependentFundingQueueMetadata({ db, config, uid, docs, now = Date.now() }) {
  const states = new Map(), actions = [];
  const deployment = config?.independentFunding;
  if (!deployment?.enabled || !deployment.factoryAddress) return { states, actions, truncated: false };
  const candidates = docs.filter(doc => isIndependentProposal(doc.data()) && doc.data().independentFunding?.activated
    && doc.data().researcherId === uid);
  const snapshots = candidates.length ? await db.getAll(...candidates.map(doc => db.collection("independentFundingSummaries")
    .doc(`${config.chainId}_${config.address.toLowerCase()}_${doc.id}`))) : [];
  const seconds = BigInt(Math.floor(Number(now?.toMillis?.() ?? now) / 1000));
  candidates.forEach((doc, index) => {
    const record = doc.data(), projection = record.independentFunding;
    const cached = snapshots[index].exists ? snapshots[index].data() : projection;
    if (cached.chainId !== config.chainId || !same(cached.registryAddress, config.address)
      || !same(cached.factoryAddress, deployment.factoryAddress)) return;
    const workflowStatus = STATUS[cached.state];
    if (!workflowStatus) return;
    states.set(doc.id, { ...cached, exists: true, activated: true, locked: true, workflowStatus,
      cached: true, updatedAt: cached.updatedAt?.toDate?.().toISOString?.() ?? null });
    if (record.moderated || ["hidden", "removed"].includes(record.moderationStatus)
      || ["draft", "withdrawn", "cancelled", "moderated_removed"].includes(record.status)) return;
    let action = null;
    const deadline = amount(cached.state === "Open" ? cached.expiresAt : cached.completionDeadline);
    if (deadline <= seconds) return;
    if (cached.state === "Open" && amount(cached.fundingTarget) > 0n
      && amount(cached.totalDeposited) === amount(cached.fundingTarget)) action = "accept_funding";
    else if (cached.state === "Accepted" && (!cached.evidenceHash || /^0x0+$/.test(cached.evidenceHash))) action = "submit_completion";
    else if (cached.state === "Accepted" && amount(cached.yesWeight) > amount(cached.totalDeposited) / 2n) action = "release_completion";
    if (action) actions.push({ id: doc.id, title: record.title || "Independent listing", action, workflowStatus,
      deadlineAt: new Date(Number(deadline) * 1000).toISOString(), proposalKind: "independent" });
  });
  const reviews = await funderEvidenceReviews({ db, config, uid, seconds });
  return { states, actions: [...actions, ...reviews.actions], truncated: reviews.truncated };
}

/** Funders who still owe a vote on the current completion evidence. */
async function funderEvidenceReviews({ db, config, uid, seconds }) {
  const rows = await db.collection("independentFundingPositions").where("walletId", "==", uid).limit(51).get();
  const positions = rows.docs.map(doc => doc.data()).filter(position => same(position.walletId, uid)
    && position.chainId === config.chainId && same(position.registryAddress, config.address)
    && same(position.factoryAddress, config.independentFunding.factoryAddress)
    && amount(position.deposited) > 0n && position.proposalId && position.summaryKey);
  if (!positions.length) return { actions: [], truncated: rows.size > 50 };
  const [summaries, proposals] = await Promise.all([
    db.getAll(...positions.map(position => db.collection("independentFundingSummaries").doc(position.summaryKey))),
    db.getAll(...positions.map(position => db.collection("proposals").doc(position.proposalId))),
  ]);
  const actions = [];
  positions.forEach((position, index) => {
    const summary = summaries[index].exists ? summaries[index].data() : null;
    const proposal = proposals[index].exists ? proposals[index].data() : null;
    if (!summary || !proposal || !isIndependentProposal(proposal) || same(proposal.researcherId, uid)) return;
    if (summary.chainId !== config.chainId || !same(summary.registryAddress, config.address)
      || !same(summary.factoryAddress, config.independentFunding.factoryAddress)) return;
    if (proposal.moderated || ["hidden", "removed"].includes(proposal.moderationStatus)
      || ["draft", "withdrawn", "cancelled", "moderated_removed"].includes(proposal.status)) return;
    if (summary.state !== "Accepted" || !hasEvidence(summary)) return;
    const deadline = amount(summary.completionDeadline);
    if (deadline <= seconds || votedOnCurrentEvidence(position, summary)) return;
    actions.push({ id: position.proposalId, title: proposal.title || "Independent listing", action: "review_evidence",
      workflowStatus: STATUS.Accepted, deadlineAt: new Date(Number(deadline) * 1000).toISOString(), proposalKind: "independent" });
  });
  return { actions, truncated: rows.size > 50 };
}
