import { refreshOpportunityMetrics, syncMetricContribution } from "./opportunityMetrics.js";

const COLLECTIONS = ["problems", "proposals", "funding"];
// One bounded, resumable page. The same idempotent transactions as live events
// make retries safe; no source record or audit history is rewritten.
export async function backfillMetricsPage({ db, now, pageSize = 100 }) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Invalid page size.");
  const checkpoint = db.collection("maintenanceState").doc("metricsV2Backfill");
  const state = (await checkpoint.get()).data() ?? { phase: 0, lastId: "" };
  if (state.phase >= COLLECTIONS.length) return { done: true, scanned: 0 };
  const collectionName = COLLECTIONS[state.phase];
  let query = db.collection(collectionName).orderBy("__name__").limit(pageSize);
  if (state.lastId) query = query.startAfter(state.lastId);
  const page = await query.get();
  for (const row of page.docs) {
    if (collectionName === "problems") await refreshOpportunityMetrics({ db, problemId: row.id, updatedAt: now });
    else await syncMetricContribution({ db, collectionName, recordId: row.id, updatedAt: now });
  }
  const complete = page.docs.length < pageSize;
  const phase = complete ? state.phase + 1 : state.phase;
  await checkpoint.set({ phase, lastId: complete ? "" : page.docs.at(-1).id, updatedAt: now });
  return { done: phase >= COLLECTIONS.length, scanned: page.docs.length, collectionName };
}
