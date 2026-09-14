const COUNTED_PROPOSAL_STATUSES = new Set([
  "submitted",
  "under_review",
  "accepted",
  "rejected",
]);

const COUNTED_FUNDING_STATUSES = new Set([
  "pledged",
  "approved",
  "disbursing",
  "completed",
]);

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

/**
 * Public-safe aggregate only. Proposal authors, titles, reviews and funding
 * account details remain in their role-scoped collections.
 */
export function opportunityMetricsFrom({ proposals = [], funding = [], requestedAmount = 0 }) {
  const proposalCount = proposals.reduce(
    (count, proposal) => count + (COUNTED_PROPOSAL_STATUSES.has(proposal?.status) ? 1 : 0),
    0,
  );
  const fundedAmount = funding.reduce(
    (total, record) => total + (
      COUNTED_FUNDING_STATUSES.has(record?.status) && record?.verification?.status === "verified"
        ? finiteNonNegative(record.amount) : 0
    ),
    0,
  );
  const target = finiteNonNegative(requestedAmount);
  const fundingProgressPercent = target > 0
    ? Math.min(100, Math.round((fundedAmount / target) * 100))
    : 0;

  return { proposalCount, fundedAmount, fundingProgressPercent };
}

// A contribution is stored once per source document. Re-read the CURRENT source
// in the transaction; duplicate or out-of-order deliveries then converge without
// an unbounded collection scan or a growing event-deduplication ledger.
export function metricContribution(collectionName, record) {
  if (!record?.problemId) return null;
  const metrics = opportunityMetricsFrom(collectionName === "proposals"
    ? { proposals: [record] } : { funding: [record] });
  if (!metrics.proposalCount && !metrics.fundedAmount) return null;
  return { problemId: record.problemId, proposalCount: metrics.proposalCount, fundedAmount: metrics.fundedAmount };
}

function sameContribution(a, b) {
  return a === null || b === null ? a === b : a.problemId === b.problemId
    && a.proposalCount === b.proposalCount && a.fundedAmount === b.fundedAmount;
}

export function affectsMetrics(collectionName, event) {
  return !sameContribution(metricContribution(collectionName, event.data?.before?.data()),
    metricContribution(collectionName, event.data?.after?.data()));
}

function projection(problemId, counts, amount, updatedAt) {
  const proposalCount = Math.max(0, counts.proposalCount || 0);
  const fundedAmount = Math.max(0, counts.fundedAmount || 0);
  const target = finiteNonNegative(amount);
  return { problemId, proposalCount, fundedAmount,
    fundingProgressPercent: target ? Math.min(100, Math.round(fundedAmount / target * 100)) : 0,
    version: 2, updatedAt };
}

export async function syncMetricContribution({ db, collectionName, recordId, updatedAt }) {
  const sourceRef = db.collection(collectionName).doc(recordId);
  const contributionRef = db.collection("metricContributions").doc(`${collectionName}_${recordId}`);
  return db.runTransaction(async (tx) => {
    const [source, stored] = await Promise.all([tx.get(sourceRef), tx.get(contributionRef)]);
    const before = stored.exists ? stored.data() : null;
    const after = metricContribution(collectionName, source.exists ? source.data() : null);
    if (sameContribution(before, after)) return;
    const ids = [...new Set([before?.problemId, after?.problemId].filter(Boolean))];
    const rows = await Promise.all(ids.map(async (id) => {
      const problemRef = db.collection("problems").doc(id);
      const metricsRef = db.collection("opportunityMetrics").doc(id);
      const [problem, metrics] = await Promise.all([tx.get(problemRef), tx.get(metricsRef)]);
      return { id, problem, metrics, metricsRef };
    }));
    for (const { id, problem, metrics, metricsRef } of rows) {
      if (!problem.exists) { tx.delete(metricsRef); continue; }
      // Legacy totals may contain client-authored funding. Never carry them
      // forward. The bounded backfill uses this same idempotent entrypoint.
      const counts = metrics.data()?.version === 2 ? metrics.data() : {};
      const previous = before?.problemId === id ? before : {};
      const next = after?.problemId === id ? after : {};
      tx.set(metricsRef, projection(id, {
        proposalCount: (counts.proposalCount || 0) - (previous.proposalCount || 0) + (next.proposalCount || 0),
        fundedAmount: (counts.fundedAmount || 0) - (previous.fundedAmount || 0) + (next.fundedAmount || 0),
      }, problem.data().amount, updatedAt));
    }
    if (after) tx.set(contributionRef, after); else tx.delete(contributionRef);
  });
}

export async function refreshOpportunityMetrics({ db, problemId, updatedAt }) {
  if (!problemId) return null;
  return db.runTransaction(async (tx) => {
    const ref = db.collection("opportunityMetrics").doc(problemId);
    const [problem, metrics] = await Promise.all([
      tx.get(db.collection("problems").doc(problemId)), tx.get(ref),
    ]);
    if (!problem.exists) { tx.delete(ref); return null; }
    const result = projection(problemId, metrics.data()?.version === 2 ? metrics.data() : {}, problem.data().amount, updatedAt);
    tx.set(ref, result);
    return result;
  });
}

export function affectedProblemIds(event) {
  return [...new Set([
    event.data?.before?.data()?.problemId,
    event.data?.after?.data()?.problemId,
  ].filter(Boolean))];
}
