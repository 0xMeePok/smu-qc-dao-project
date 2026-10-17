import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { refreshPostingEscrowProgress } from "../postingEscrowProgress.js";
import auditRegistryBaseConfig from "../auditRegistry.contract.json" with { type: "json" };

// Rebuilds every posting's cached Discover escrow progress with the current
// projection (version 2 excludes rejected, cancelled and refunded escrows).
// Until a posting is rebuilt, Discover shows "needs verification" for it
// rather than an older total. Idempotent; safe to re-run.
const projectId = process.argv.find((arg) => arg.startsWith("--project="))?.slice(10);
if (!process.argv.includes("--apply") || !projectId) {
  console.error("Usage: node scripts/backfill-escrow-progress.mjs --project=PROJECT_ID --apply");
  process.exitCode = 1;
} else {
  initializeApp({ projectId });
  const db = getFirestore();
  let last = null, scanned = 0;
  for (;;) {
    let query = db.collection("problems").orderBy("__name__").limit(100);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    for (const row of page.docs) await refreshPostingEscrowProgress({ db, problemId: row.id, config: auditRegistryBaseConfig });
    scanned += page.size;
    if (page.size < 100) break;
    last = page.docs.at(-1).id;
  }
  console.log(JSON.stringify({ scanned }));
}
