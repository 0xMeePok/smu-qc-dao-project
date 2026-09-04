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
      COUNTED_FUNDING_STATUSES.has(record?.status) ? finiteNonNegative(record.amount) : 0
    ),
    0,
  );
  const target = finiteNonNegative(requestedAmount);
  const fundingProgressPercent = target > 0
    ? Math.min(100, Math.round((fundedAmount / target) * 100))
    : 0;

  return { proposalCount, fundedAmount, fundingProgressPercent };
}

async function recordsForProblem(db, collectionName, problemId) {
  const snapshot = await db.collection(collectionName).where("problemId", "==", problemId).get();
  return snapshot.docs.map((document) => document.data());
}

/** Rebuild instead of incrementing so retried Firestore events stay idempotent. */
export async function refreshOpportunityMetrics({ db, problemId, updatedAt }) {
  if (!problemId) return null;

  const problemRef = db.collection("problems").doc(problemId);
  const [problem, proposals, funding] = await Promise.all([
    problemRef.get(),
    recordsForProblem(db, "proposals", problemId),
    recordsForProblem(db, "funding", problemId),
  ]);

  const metricsRef = db.collection("opportunityMetrics").doc(problemId);
  if (!problem.exists) {
    await metricsRef.delete().catch((error) => {
      // Deleting a missing document is normally fine. Preserve real backend errors
      // so Functions retries rather than silently leaving stale marketplace data.
      if (error?.code !== 5 && error?.code !== "not-found") throw error;
    });
    return null;
  }

  const metrics = opportunityMetricsFrom({
    proposals,
    funding,
    requestedAmount: problem.data()?.amount,
  });

  await metricsRef.set({
    problemId,
    ...metrics,
    updatedAt,
  });

  return metrics;
}

export function affectedProblemIds(event) {
  return [...new Set([
    event.data?.before?.data()?.problemId,
    event.data?.after?.data()?.problemId,
  ].filter(Boolean))];
}
