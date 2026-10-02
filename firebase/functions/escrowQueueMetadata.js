import { readOpenFunding, supportsOpenFunding } from "./openFunding.js";
import { fundingBlockReason, loadFundingContext, readVerifiedFunding } from "./escrowFunding.js";
import { same } from "./escrowFundingEvents.js";

const at = (row, name, index) => row?.[name] ?? row?.[index];
const blocked = row => row?.moderated || ["hidden", "removed"].includes(row?.moderationStatus);
const isoDeadline = seconds => new Date(Number(seconds) * 1000).toISOString();
const ZERO = `0x${"0".repeat(64)}`;
const ESCROW_WORKFLOW = Object.freeze({ Open: "submitted", Locked: "pending_approval", Active: "accepted",
  Released: "completed", Cancelled: "cancelled", Refunded: "refunded", Expired: "expired", Voided: "invalidated" });

/** Grant queue state is read-only and scoped to proposals authored by this uid.
 * Stored proposal status remains a delivery projection, not proof of an offer. */
export async function readGrantQueueMetadata({ db, client, config, uid, docs, parents }) {
  const grants = new Map(), unavailable = new Set();
  if (!client || !supportsOpenFunding(config)) return { grants, unavailable };
  const candidates = docs.filter(doc => doc.data().researcherId === uid && doc.data().status !== "draft"
    && doc.data().fundingTerms && doc.data().audit?.status === "confirmed"
    && parents.get(doc.data().problemId)?.opportunityType === "open-funding");
  if (!candidates.length) return { grants, unavailable };
  let blockNumber;
  try {
    if (await client.getChainId() !== config.chainId) throw new Error("Incorrect chain");
    blockNumber = await client.getBlockNumber({ cacheTime: 0 }) - 1n;
    if (blockNumber < 0n) throw new Error("No confirmed block");
  } catch { return { grants, unavailable: new Set(candidates.map(doc => doc.id)) }; }
  const pools = new Map();
  for (const doc of candidates) {
    const data = doc.data();
    try {
      if (!pools.has(data.problemId)) {
        pools.set(data.problemId, readOpenFunding({ db, client, config, uid, problemId: data.problemId,
          blockNumber, includeSelections: false }).catch(() => null));
      }
      const pool = await pools.get(data.problemId);
      if (!pool) throw new Error("Grant pool unavailable");
      if (!pool.exists) {
        grants.set(doc.id, { status: "none", canAccept: false, poolAddress: null, tokenAddress: pool.tokenAddress,
          tokenSymbol: pool.tokenSymbol, tokenDecimals: pool.tokenDecimals, amountBaseUnits: String(data.fundingTerms.target),
          acceptanceDeadline: "0", deadlineAt: null, blockNumber: Number(blockNumber) });
        continue;
      }
      const context = await loadFundingContext({ db, uid, proposalId: doc.id });
      const verified = await readVerifiedFunding({ client, config, ...context, blockNumber });
      const [offer, linkedPool] = await Promise.all([
        client.readContract({ address: pool.poolAddress, abi: config.escrow.openFundingPoolAbi,
          functionName: "getOffer", args: [verified.expected.entityId], blockNumber }),
        client.readContract({ address: verified.escrow.address, abi: config.escrow.escrowAbi,
          functionName: "openFundingPool", blockNumber }),
      ]);
      if (!same(linkedPool, pool.poolAddress) || !same(verified.summary.tokenAddress, pool.tokenAddress)) throw new Error("Grant custody mismatch");
      const state = Number(at(offer, "state", 2)), deadline = BigInt(at(offer, "acceptanceDeadline", 1));
      if (![0, 1, 2, 3].includes(state)) throw new Error("Unknown grant offer state");
      const expired = state === 1 && deadline <= BigInt(pool.timestamp);
      grants.set(doc.id, { status: expired ? "expired" : ["none", "pending", "accepted", "voided"][state],
        canAccept: state === 1 && !expired && verified.summary.active && !pool.withdrawn && !pool.paused
          && !blocked(context.record) && !blocked(context.parent),
        amountBaseUnits: state === 0 ? verified.summary.fundingTarget : String(at(offer, "amount", 0)),
        acceptanceDeadline: deadline.toString(), deadlineAt: deadline > 0n ? isoDeadline(deadline) : null,
        poolAddress: pool.poolAddress, tokenAddress: pool.tokenAddress, tokenSymbol: pool.tokenSymbol,
        tokenDecimals: pool.tokenDecimals, blockNumber: Number(blockNumber) });
    } catch { unavailable.add(doc.id); }
  }
  return { grants, unavailable, blockNumber };
}

/** A member's required escrow actions. No keeper/signing path is called here. */
export async function readEscrowQueueActions({ db, client, config, uid, docs, blockNumber }) {
  const actions = [], unavailable = new Set(), states = new Map();
  if (!client || config?.contractName !== "EscrowAuditRegistry" || !config.escrow?.escrowAbi?.length) return { actions, unavailable, states };
  const candidates = docs.filter(doc => doc.data().fundingTerms && doc.data().status !== "draft"
    && doc.data().audit?.status === "confirmed" && (doc.data().researcherId === uid || doc.data().postingOwnerId === uid));
  if (!candidates.length) return { actions, unavailable, states };
  try {
    if (await client.getChainId() !== config.chainId) throw new Error("Incorrect chain");
    blockNumber ??= await client.getBlockNumber({ cacheTime: 0 }) - 1n;
    if (blockNumber < 0n) throw new Error("No confirmed block");
  } catch { return { actions, unavailable: new Set(candidates.map(doc => doc.id)), states }; }
  for (const doc of candidates) {
    try {
      const context = await loadFundingContext({ db, uid, proposalId: doc.id });
      const receipt = await client.getTransactionReceipt({ hash: context.record.audit.transactionHash });
      // Historical deployments retain their own read/refund screens and must
      // never yield new active-deployment actions in this queue.
      if (!same(receipt.to, config.address)) continue;
      if (receipt.status !== "success" || typeof receipt.blockNumber !== "bigint" || receipt.blockNumber > blockNumber
          || !same(receipt.transactionHash, context.record.audit.transactionHash)) throw new Error("Unconfirmed publication");
      const { summary, data, milestones } = await readVerifiedFunding({ client, config, ...context, blockNumber });
      const owner = same(context.parent.ownerId, uid), researcher = same(context.record.researcherId, uid);
      const validContent = !blocked(context.record) && !blocked(context.parent);
      const timestamp = BigInt(summary.timestamp), deadline = BigInt(data.approvalDeadline);
      const reviewOpen = summary.active && validContent && timestamp < deadline;
      const needsApproval = (owner && !data.ownerApproved) || (researcher && !data.solutionApproved);
      const grant = context.parent.opportunityType === "open-funding";
      const workflowStatus = ESCROW_WORKFLOW[summary.state];
      if (!workflowStatus) throw new Error("Unknown escrow state");
      let action = null;
      if (!grant && owner && summary.state === "Open" && summary.active && validContent
          && ["submitted", "under_review"].includes(context.record.status) && ["submitted", "open"].includes(context.parent.status)
          && timestamp < BigInt(summary.expiresAt) && BigInt(summary.totalDeposited) === BigInt(summary.fundingTarget)
          && !context.parent.escrowSelection
          && !fundingBlockReason(context.record, context.parent, summary, summary.timestamp * 1000)) action = "select";
      else if (summary.state === "Locked" && summary.currentTranche === 0 && reviewOpen && needsApproval) action = "approve_upfront";
      else if (summary.state === "Active" && summary.currentTranche === 1 && reviewOpen) {
        const evidence = at(milestones[1], "evidenceHash", 4);
        if (researcher && (!evidence || same(evidence, ZERO))) action = "submit_delivery";
        else if (evidence && !same(evidence, ZERO) && needsApproval) action = "approve_delivery";
      }
      const relevantDeadline = summary.state === "Open" ? BigInt(summary.expiresAt)
        : ["Locked", "Active"].includes(summary.state) ? deadline : null;
      states.set(doc.id, { state: summary.state, workflowStatus, action, approvalDeadline: deadline.toString(),
        deadlineAt: relevantDeadline !== null && relevantDeadline > 0n ? isoDeadline(relevantDeadline) : null,
        blockNumber: Number(blockNumber) });
      if (action) actions.push({ id: doc.id, problemId: context.record.problemId, title: context.record.title || "Proposal",
        posting: { id: context.parent.id, title: context.parent.title || "Posting", status: context.parent.status },
        action, escrowState: summary.state, approvalDeadline: action === "select" ? summary.expiresAt : deadline.toString(),
        deadlineAt: isoDeadline(action === "select" ? summary.expiresAt : deadline),
        workflowStatus: action === "select" ? "submitted" : action === "approve_upfront" ? "pending_approval" : "accepted",
        blockNumber: Number(blockNumber) });
    } catch { unavailable.add(doc.id); }
  }
  return { actions, unavailable, states };
}
