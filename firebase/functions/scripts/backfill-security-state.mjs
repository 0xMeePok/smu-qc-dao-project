import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { backfillSecurityStatePage } from "../securityStateMigration.js";

const projectId = process.argv.find(arg => arg.startsWith("--project="))?.slice(10);
const kind = process.argv.find(arg => arg.startsWith("--kind="))?.slice(7);
if (!process.argv.includes("--apply") || !projectId || !["evaluations", "proposal-locks"].includes(kind)) {
  console.error("Usage: node scripts/backfill-security-state.mjs --project=PROJECT_ID --kind=evaluations|proposal-locks --apply\nDeploy new rules first. Uses existing Admin credentials; processes at most ten resumable 100-document pages. Re-run until done before resuming scheduled evaluation expiry or material opportunity edits.");
  process.exitCode = 1;
} else {
  initializeApp({ projectId });
  const db = getFirestore();
  for (let page = 0; page < 10; page++) {
    const result = await backfillSecurityStatePage({ db, now: Timestamp.now(), kind });
    console.log(JSON.stringify(result));
    if (result.done) break;
  }
}
