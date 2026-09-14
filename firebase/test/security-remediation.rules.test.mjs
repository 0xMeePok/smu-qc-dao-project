import fs from "node:fs";
import { before, after, describe, it } from "node:test";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, query, where, limit, setDoc, updateDoc, deleteField, serverTimestamp, writeBatch } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";

const OWNER = `0x${"d7".repeat(20)}`;
const AUTHOR = `0x${"e8".repeat(20)}`;
let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "qc-dao-rules-test",
    firestore: { rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") },
    storage: { rules: fs.readFileSync(new URL("../storage.rules", import.meta.url), "utf8") } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const address of [OWNER, AUTHOR]) await setDoc(doc(ctx.firestore(), "users", address), {
      address, role: 0, fullName: "Security Test", organisation: "University", walletVerified: true,
      termsAcceptedAt: new Date(), termsVersion: "2026-08-24", suspended: false,
    });
  });
});
after(async () => env.cleanup());
const problem = (extra = {}) => ({
  ownerId: OWNER, organisation: "University", title: "Cold-chain routing", summary: "Optimise urban delivery routing.",
  businessContext: "Many deliveries", currentApproach: "Classical optimisation", currentLimitations: "Too slow",
  expectedOutcome: "Faster routing", successCriteria: "Ten percent better", dataAvailability: "Anonymised deliveries",
  categories: ["ai", "quantum"], amount: 1000, currency: "USDC", expiresAt: new Date("2099-01-01"),
  status: "submitted", attachments: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra,
});
const publicationAudit = (extra = {}) => ({
  schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`,
  contentHash: `0x${"2".repeat(64)}`, status: "pending", transactionHash: `0x${"3".repeat(64)}`,
  blockNumber: 10, attemptCount: 1, lastError: "", ...extra,
});
async function trusted(scope, id, data, proof = true) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const uid = data.ownerId ?? data.researcherId;
    await setDoc(doc(ctx.firestore(), "recordReservations", `${scope}_${id}`), { uid });
    if (proof) {
      const { createdAt, updatedAt, audit, ...record } = data;
      await setDoc(doc(ctx.firestore(), "publicationProofs", `${scope}_${id}`), { uid, record, transactionHash: audit?.transactionHash ?? "" });
    }
  });
}
describe("QCDAO-131/132/133/134 raw client bypasses", () => {
  it("denies published-to-draft regression with or without simultaneous content edits", async () => {
    const db = env.authenticatedContext(OWNER).firestore();
    for (const status of ["submitted", "open", "in_review", "matched", "funded", "completed", "cancelled"]) {
      const id = `no-regression-${status}`, data = problem({ status });
      await trusted("problems", id, data);
      await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "problems", id), data));
      for (const patch of [{ status: "draft" }, { status: "draft", title: "Unattested edit" }]) {
        await assertFails(updateDoc(doc(db, "problems", id), { ...patch, updatedAt: serverTimestamp() }));
      }
    }
  });
  it("binds published transaction hashes to proof while allowing receipt progress and reattestation", async () => {
    const db = env.authenticatedContext(OWNER).firestore();
    const audit = publicationAudit();
    const id = "bound-publication-audit", data = problem({ audit }), reference = doc(db, "problems", id);
    await trusted("problems", id, data);
    const replacement = { ...audit, transactionHash: `0x${"4".repeat(64)}` };
    await assertFails(setDoc(reference, { ...data, audit: replacement }));
    await assertSucceeds(setDoc(reference, data));
    await assertFails(updateDoc(reference, { audit: replacement, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(reference, { "audit.transactionHash": replacement.transactionHash, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(reference, { audit: { ...audit, status: "queued", transactionHash: "", blockNumber: 0 }, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(reference, { audit: deleteField(), updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(reference, { "audit.status": "failed", "audit.lastError": "RPC unavailable", updatedAt: serverTimestamp() }));
    await trusted("problems", id, { ...data, audit: replacement, title: "Attested correction" });
    await assertSucceeds(updateDoc(reference, { title: "Attested correction", audit: replacement, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(reference, { status: "cancelled", withdrawalReason: "Research priorities changed", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(reference, { "audit.status": "failed", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(reference, { "audit.transactionHash": audit.transactionHash, updatedAt: serverTimestamp() }));
  });
  it("requires the attested hash on draft promotion and when attaching a legacy receipt", async () => {
    const db = env.authenticatedContext(OWNER).firestore(), audit = publicationAudit();
    for (const status of ["draft", "submitted"]) {
      const id = `bind-missing-audit-${status}`, reference = doc(db, "problems", id);
      const data = problem({ audit });
      await trusted("problems", id, data);
      await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "problems", id), problem({ status })));
      await assertFails(updateDoc(reference, { status: "submitted", audit: publicationAudit({ transactionHash: `0x${"4".repeat(64)}` }), updatedAt: serverTimestamp() }));
      await assertSucceeds(updateDoc(reference, { status: "submitted", audit, updatedAt: serverTimestamp() }));
    }
  });
  it("requires a trusted reservation even for a draft", async () => {
    const db = env.authenticatedContext(OWNER).firestore();
    const data = problem({ status: "draft" });
    await assertFails(setDoc(doc(db, "problems", "security-draft"), data));
    await trusted("problems", "security-draft", data, false);
    await assertSucceeds(setDoc(doc(db, "problems", "security-draft"), data));
    await assertFails(updateDoc(doc(db, "problems", "security-draft"), { status: "submitted", updatedAt: serverTimestamp() }));
  });
  it("prevents an old tab recreating a retired record even with its old proof", async () => {
    const db = env.authenticatedContext(OWNER).firestore(), data = problem();
    await trusted("problems", "retired-opportunity", data);
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "recordReservations", "problems_retired-opportunity"), { retired: true }));
    await assertFails(setDoc(doc(db, "problems", "retired-opportunity"), data));
    await assertFails(setDoc(doc(db, "problems", "retired-opportunity"), { ...data, status: "draft" }));
  });
  it("rejects no-proof publication and changed content after an exact attestation", async () => {
    const db = env.authenticatedContext(OWNER).firestore();
    const data = problem();
    await trusted("problems", "security-published", data, false);
    await assertFails(setDoc(doc(db, "problems", "security-published"), data));
    await trusted("problems", "security-published", data);
    await assertFails(setDoc(doc(db, "problems", "security-published"), { ...data, title: "Tampered" }));
    await assertSucceeds(setDoc(doc(db, "problems", "security-published"), data));
    await assertFails(updateDoc(doc(db, "problems", "security-published"), { title: "Tampered correction", updatedAt: serverTimestamp() }));
    await trusted("problems", "security-published", { ...data, title: "Verified correction" });
    await assertSucceeds(updateDoc(doc(db, "problems", "security-published"), { title: "Verified correction", updatedAt: serverTimestamp() }));
  });
  it("cannot fabricate the attestation, reservation, funding evidence or metrics", async () => {
    const db = env.authenticatedContext(OWNER).firestore();
    for (const name of ["publicationProofs", "recordReservations", "uploadReservations", "creationQuotas", "uploadQuotas", "metricContributions", "opportunityMetrics", "registryArchives", "maintenanceState"]) {
      await assertFails(setDoc(doc(db, name, "security-forged"), { uid: OWNER, amount: 99999 }));
    }
    for (const status of ["pledged", "approved", "disbursing", "completed"]) await assertFails(setDoc(doc(db, "funding", `security-${status}`), {
      funderId: OWNER, proposalId: "p", problemId: "security-published", title: "Forged grant", amount: 99999, status,
      verification: { status: "verified" }, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
  });
  it("requires bounded marketplace queries", async () => {
    const db = env.authenticatedContext(OWNER).firestore();
    const records = collection(db, "problems");
    await assertFails(getDocs(query(records, where("status", "in", ["submitted", "open"]))));
    await assertFails(getDocs(query(records, where("status", "in", ["submitted", "open"]), limit(51))));
    await assertSucceeds(getDocs(query(records, where("status", "in", ["submitted", "open"]), limit(25))));
  });
  it("requires proof for an otherwise valid atomic proposal submission", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const data = { researcherId: AUTHOR, postingOwnerId: OWNER, problemId: "security-published", opportunityType: "business-problem",
      title: "Quantum routing", summary: "A measurable study", category: "quantum-annealing", methodology: "Compare baselines",
      suitability: "Combinatorial routing", expectedOutcomes: "Improved routing", successCriteria: "Ten percent", timeline: "12 weeks",
      milestones: "Baseline, prototype, validation", team: "Research team", amount: 500, currency: "USDC", status: "submitted",
      attachments: [], audit: publicationAudit(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    const commit = () => { const batch = writeBatch(db);
      batch.set(doc(db, "proposals", "security-proposal"), data);
      batch.set(doc(db, "problems", data.problemId, "proposalAuthors", AUTHOR), { proposalId: "security-proposal" });
      return batch.commit(); };
    await trusted("proposals", "security-proposal", data, false);
    await assertFails(commit());
    await trusted("proposals", "security-proposal", data);
    await assertSucceeds(commit());
    await assertFails(updateDoc(doc(db, "proposals", "security-proposal"), { title: "Changed without chain", updatedAt: serverTimestamp() }));
    const reference = doc(db, "proposals", "security-proposal");
    const correction = { ...data, title: "Verified proposal correction" };
    await trusted("proposals", "security-proposal", correction);
    const replacement = publicationAudit({ transactionHash: `0x${"4".repeat(64)}` });
    await assertFails(updateDoc(reference, { title: correction.title, audit: replacement, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(reference, { title: correction.title, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(reference, { status: "draft", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(reference, { status: "withdrawn", withdrawalReason: "Research priorities changed", updatedAt: serverTimestamp() }));
  });
  it("rejects unreserved, expired, sealed, wrong-size and retired PDF uploads", async () => {
    const storage = env.authenticatedContext(OWNER).storage();
    const bytes = new TextEncoder().encode("%PDF-1.7\n");
    const sha256 = `0x${"7".repeat(64)}`;
    for (const scope of ["problems", "proposals"]) {
      const recordId = `security-upload-${scope}`;
      const file = "securityfile";
      const object = ref(storage, `${scope}/${OWNER}/${recordId}/${file}.pdf`);
      const metadata = { contentType: "application/pdf", customMetadata: { uploadedBy: OWNER,
        problemId: recordId, originalName: "test.pdf", sha256 } };
      await assertFails(uploadBytes(object, bytes, metadata));
      const path = `${scope}/${OWNER}/${recordId}/${file}.pdf`;
      const good = { uid: OWNER, scope, recordId, attachmentId: file, path,
        state: "reserved", sealed: false, expiresAt: new Date("2099-01-01"), size: bytes.length, sha256 };
      for (const patch of [{ expiresAt: new Date(0) }, { sealed: true }, { size: bytes.length + 1 }, { state: "retired" }]) {
        await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "uploadReservations", `${scope}.${recordId}.${file}`), { ...good, ...patch }));
        await assertFails(uploadBytes(object, bytes, metadata));
      }
      await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "uploadReservations", `${scope}.${recordId}.${file}`), good));
      await assertSucceeds(uploadBytes(object, bytes, metadata));
    }
  });
  it("rejects an underscore alias even when its size and digest match a valid reservation", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n");
    const sha256 = `0x${"8".repeat(64)}`;
    const intendedRecord = "p_a", intendedAttachment = "file0001";
    const intendedPath = `problems/${OWNER}/${intendedRecord}/${intendedAttachment}.pdf`;
    await env.withSecurityRulesDisabled((ctx) => setDoc(
      doc(ctx.firestore(), "uploadReservations", `problems.${intendedRecord}.${intendedAttachment}`),
      { uid: OWNER, scope: "problems", recordId: intendedRecord, attachmentId: intendedAttachment,
        path: intendedPath, state: "reserved", sealed: false, expiresAt: new Date("2099-01-01"),
        size: bytes.length, sha256 },
    ));
    const aliasRecord = "p", aliasAttachment = "a_file0001";
    // Even a corrupt/migrated document at the alias's canonical key cannot
    // authorize a different tuple: authorization is bound to the stored path.
    await env.withSecurityRulesDisabled((ctx) => setDoc(
      doc(ctx.firestore(), "uploadReservations", `problems.${aliasRecord}.${aliasAttachment}`),
      { uid: OWNER, scope: "problems", recordId: intendedRecord, attachmentId: intendedAttachment,
        path: intendedPath, state: "reserved", sealed: false, expiresAt: new Date("2099-01-01"),
        size: bytes.length, sha256 },
    ));
    const metadata = { contentType: "application/pdf", customMetadata: { uploadedBy: OWNER,
      problemId: aliasRecord, originalName: "test.pdf", sha256 } };
    await assertFails(uploadBytes(
      ref(env.authenticatedContext(OWNER).storage(), `problems/${OWNER}/${aliasRecord}/${aliasAttachment}.pdf`),
      bytes,
      metadata,
    ));
  });
});
