import { isIndependentProposal } from "./independentProposal.js";

const STATUS = Object.freeze({ Open: "submitted", Accepted: "accepted", Released: "completed",
  Declined: "declined", Expired: "expired", Cancelled: "cancelled", Refunded: "refunded" });
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const amount = value => { try { return BigInt(value || 0); } catch { return 0n; } };

/** Dashboard projections are cached hints. Every wallet action rechecks the chain. */
export async function readIndependentFundingQueueMetadata({ db, config, uid, docs, now = Date.now() }) {
  const states = new Map(), actions = [];
  const deployment = config?.independentFunding;
  if (!deployment?.enabled || !deployment.factoryAddress) return { states, actions };
  const candidates = docs.filter(doc => isIndependentProposal(doc.data()) && doc.data().independentFunding?.activated
    && doc.data().researcherId === uid);
  if (!candidates.length) return { states, actions };
  const snapshots = await db.getAll(...candidates.map(doc => db.collection("independentFundingSummaries")
    .doc(`${config.chainId}_${config.address.toLowerCase()}_${doc.id}`)));
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
  return { states, actions };
}
