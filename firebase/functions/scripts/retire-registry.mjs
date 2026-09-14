import fs from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore, Timestamp } from "firebase-admin/firestore";
import { RETIREMENT_COLLECTIONS, RETIREMENT_CHILDREN, retireRegistryDocument } from "../registryRetirement.js";

const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const projectId = option("project"), registry = option("registry")?.toLowerCase();
const apply = process.argv.includes("--apply");
const beginMaintenance = process.argv.includes("--begin-maintenance");
if (!projectId || !/^0x[0-9a-f]{40}$/.test(registry ?? "")) {
  throw new Error("Usage: node scripts/retire-registry.mjs --project=PROJECT --registry=OLD_ADDRESS [--apply --maintenance-rules-installed]");
}
if ((apply || beginMaintenance) && !process.argv.includes("--maintenance-rules-installed")) {
  throw new Error("Deploy firestore/storage maintenance rules before --apply. See docs/registry-cutover.md.");
}
initializeApp({ projectId });
const db = getFirestore();
const archive = db.collection("registryArchives").doc(registry);
const maintenanceRef = db.collection("maintenanceState").doc("registryCutover");
if (beginMaintenance) {
  await db.runTransaction(async (tx) => {
    const previous = await tx.get(maintenanceRef);
    if (previous.data()?.active) {
      if (previous.data().registry !== registry) throw new Error("Another registry cutover is active.");
      return;
    }
    tx.set(maintenanceRef, { active: true, registry, startedAt: Timestamp.now() });
  });
  console.log("Maintenance active. Wait at least 540 seconds for in-flight Functions before --apply.");
  await db.terminate();
  process.exit(0);
}
if (apply) {
  const manifestPath = option("manifest");
  if (!manifestPath) throw new Error("Supply --manifest=PATH_TO_ARCHIVED_OLD_REGISTRY_CONFIG.");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  if (manifest.address.toLowerCase() !== registry) throw new Error("Archive before switching the configured registry.");
  const maintenance = (await maintenanceRef.get()).data();
  if (!maintenance?.active || maintenance.registry !== registry || !maintenance.startedAt?.toMillis) {
    throw new Error("Run --begin-maintenance after installing maintenance rules first.");
  }
  if (Date.now() - maintenance.startedAt.toMillis() < 540_000) {
    throw new Error("Wait 540 seconds from the start of maintenance for in-flight Functions to finish.");
  }
  await archive.set({ registry: manifest, projectId, policy: "retire", storagePolicy: "retain-existing-bytes" }, { merge: true });
}
const phases = [...RETIREMENT_COLLECTIONS.map((name) => ({ name, query: db.collection(name) })),
  ...RETIREMENT_CHILDREN.map((name) => ({ name: `children_${name}`, query: db.collectionGroup(name) }))];
// At most 10 pages per invocation. A durable per-phase cursor survives restarts;
// the original typed records are in registryArchives/OLD_ADDRESS/records.
let pages = 0, done = true;
for (const { name, query } of phases) {
  const checkpoint = archive.collection("checkpoints").doc(name);
  const saved = apply ? (await checkpoint.get()).data() : null;
  if (saved?.done) continue;
  let bounded = query.orderBy(FieldPath.documentId()).limit(100);
  if (saved?.lastPath) bounded = bounded.startAfter(db.doc(saved.lastPath));
  const batch = await bounded.get();
  let processed = 0;
  for (const source of batch.docs) {
    // These group names are exclusive to opportunity/proposal audit histories.
    // Refuse unknown topology instead of sweeping unrelated application data.
    if (name.startsWith("children_") && !/^(problems|proposals)\/[^/]+\/(revisions|proposalAuthors)\/[^/]+$/.test(source.ref.path)) {
      throw new Error(`Unexpected child collection: ${source.ref.path}`);
    }
    if (apply) processed += Number(await retireRegistryDocument({ db, sourceRef: source.ref, registry, now: Timestamp.now() }));
  }
  const phaseDone = batch.size < 100;
  if (apply) await checkpoint.set({ lastPath: batch.docs.at(-1)?.ref.path ?? saved?.lastPath ?? "", done: phaseDone });
  console.log(JSON.stringify({ phase: name, scanned: batch.size, archived: processed, phaseDone, apply }));
  pages++;
  if (!phaseDone || pages >= 10) { done = false; break; }
}
if (apply && done) await archive.set({ completedAt: Timestamp.now(), completed: true }, { merge: true });
console.log(JSON.stringify({ done, maintenanceRemainsActive: apply, note: "Keep maintenance rules until the new registry, Functions, and site are deployed." }));
await db.terminate();
