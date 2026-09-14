import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { backfillMetricsPage } from "../metricsMigration.js";

const projectId = process.argv.find((arg) => arg.startsWith("--project="))?.slice(10);
if (!process.argv.includes("--apply") || !projectId) {
  console.error("Usage: node scripts/backfill-metrics.mjs --project=PROJECT_ID --apply\nResumes at most 10 pages of 100 records. Re-run until done; use deployment maintenance window.");
  process.exitCode = 1;
} else {
  initializeApp({ projectId });
  const db = getFirestore();
  for (let page = 0; page < 10; page++) {
    const result = await backfillMetricsPage({ db, now: Timestamp.now() });
    console.log(JSON.stringify(result));
    if (result.done) break;
  }
}
