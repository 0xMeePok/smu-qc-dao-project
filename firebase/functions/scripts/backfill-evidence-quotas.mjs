import "../securityDependencies/verify-installed.mjs";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { backfillEvidenceQuotaPage } from "../evidenceQuotaMigration.js";

const projectId = process.argv.find(arg => arg.startsWith("--project="))?.slice(10);
if (!process.argv.includes("--apply") || !projectId) {
  console.error("Usage: node scripts/backfill-evidence-quotas.mjs --project=PROJECT_ID --apply\nDeploy closed evidence rules and new Functions, drain old prepares first. Uses existing Admin credentials; processes at most ten resumable 100-document pages. Re-run until done. Never deletes or changes retained evidence.");
  process.exitCode = 1;
} else {
  initializeApp({ projectId });
  const db = getFirestore();
  for (let page = 0; page < 10; page++) {
    const result = await backfillEvidenceQuotaPage({ db, now: Timestamp.now() });
    console.log(JSON.stringify(result));
    if (result.done) break;
  }
}
