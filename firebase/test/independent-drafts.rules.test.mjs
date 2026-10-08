import fs from "node:fs";
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteField, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where } from "firebase/firestore";
import { INDEPENDENT_PUBLISH_VALIDATION, isPublishableIndependentProposal } from "../functions/publicationValidation.js";

const AUTHOR = `0x${"63".repeat(20)}`;
let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "qc-dao-rules-test", firestore: {
    rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
  } });
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), "users", AUTHOR), {
    address: AUTHOR, role: 0, suspended: false, fullName: "Draft researcher", organisation: "University",
    walletVerified: true, termsAcceptedAt: new Date(), termsVersion: "2026-08-24",
  }));
});
after(async () => { await env?.cleanup(); });

it("keeps activated crowdfunding immutable while allowing receipt progress", async () => {
  const id = "independent-activated-lock";
  const audit = { schemaVersion: 2, chainId: 421614, entityId: `0x${"1".repeat(64)}`,
    contentHash: `0x${"2".repeat(64)}`, transactionHash: `0x${"3".repeat(64)}`,
    status: "pending", blockNumber: 123, attemptCount: 1, lastError: "" };
  const funding = { activated: true, locked: true, state: "Open", totalDeposited: "0" };
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), "proposals", id), {
    ...draft(0), status: "submitted", audit, independentFunding: funding,
  }));
  const ref = doc(env.authenticatedContext(AUTHOR).firestore(), "proposals", id);
  await assertSucceeds(updateDoc(ref, { updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { status: "withdrawn", withdrawalReason: "Cancel this research", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { amount: 3, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { independentFunding: { ...funding, locked: false }, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { independentFunding: deleteField(), updatedAt: serverTimestamp() }));
});

// The independent form intentionally has no parent problem or posting owner.
// Include every draft field the client sends: sparse fixtures missed the cap.
function draft(pdfCount, empty = false) {
  return {
    researcherId: AUTHOR, proposalKind: "independent", status: "draft",
    title: empty ? "" : "Independent routing study",
    summary: empty ? "" : "Compare routing methods on synthetic data.",
    methodology: empty ? "" : "Compare quantum-inspired and classical baselines.",
    addressedProblems: empty ? "" : "Routing and resource allocation.",
    team: empty ? "" : "Operations research team",
    category: empty ? "" : "quantum-inspired", maturity: empty ? "" : "laboratory",
    amount: empty ? 0 : 2, currency: "USDC",
    expiresAt: Timestamp.fromMillis(Date.now() + 90 * 864e5),
    fundingPlan: { tranchePercentages: "50, 50", reviewDays: "7", funderVoting: false },
    attachments: Array.from({ length: pdfCount }, (_, i) => ({
      id: `draft-support-00${i}`, name: "support.pdf", size: 2048,
      contentType: "application/pdf", sha256: `0x${"4".repeat(64)}`,
    })),
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  };
}

async function reserve(id) {
  // Reservation is normally issued by the callable; all proposal writes below
  // use the ordinary authenticated researcher, with the real rules enabled.
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), "recordReservations", `proposals_${id}`), { uid: AUTHOR }));
}

for (const [label, pdfCount, empty] of [["empty", 0, true], ["complete-0", 0, false], ["complete-1", 1, false], ["complete-2", 2, false]]) {
  it(`saves, reopens and edits an independent draft: ${label}`, async () => {
    const id = `independent-draft-${label}`;
    const db = env.authenticatedContext(AUTHOR).firestore();
    const ref = doc(db, "proposals", id);
    await reserve(id);
    await assertSucceeds(setDoc(ref, draft(pdfCount, empty)));
    const saved = await assertSucceeds(getDoc(ref));
    assert.equal(saved.data().attachments.length, pdfCount);
    assert.equal(saved.data().status, "draft");
    assert.equal("problemId" in saved.data(), false);
    const rows = await assertSucceeds(getDocs(query(collection(db, "proposals"), where("researcherId", "==", AUTHOR), where("status", "==", "draft"))));
    assert.ok(rows.docs.some(row => row.id === id));

    // Resaving sends all editable fields, while retaining the original creation time.
    const { createdAt, ...edited } = draft(pdfCount);
    edited.title = "Updated independent routing study";
    await assertSucceeds(updateDoc(ref, edited));
    const reopened = await assertSucceeds(getDoc(ref));
    assert.equal(reopened.data().title, edited.title);
    assert.ok(reopened.data().createdAt.isEqual(saved.data().createdAt));
    assert.equal(reopened.data().attachments.length, pdfCount);
  });
}

for (const pdfCount of [0, 1, 2]) {
  it(`publishes a saved independent draft with ${pdfCount} PDFs and its attested receipt`, async () => {
    const id = `independent-draft-publish-${pdfCount}`;
    const db = env.authenticatedContext(AUTHOR).firestore();
    const ref = doc(db, "proposals", id);
    await reserve(id);
    await assertSucceeds(setDoc(ref, draft(pdfCount)));
    const { createdAt, updatedAt, fundingPlan, ...record } = (await getDoc(ref)).data();
    record.status = "submitted";
    record.fundingTerms = { token: `0x${"c".repeat(40)}`, target: "2000000", funderVoting: false,
      trancheBps: [5000, 5000], reviewWindows: [604800, 604800],
      milestoneHashes: [1, 2].map(value => `0x${String(value).repeat(64)}`) };
    assert.ok(isPublishableIndependentProposal(record, { uid: AUTHOR }));
    const audit = { schemaVersion: 2, chainId: 421614,
      entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`, status: "pending",
      transactionHash: `0x${"3".repeat(64)}`, blockNumber: 123, attemptCount: 1, lastError: "" };
    await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), "publicationProofs", `proposals_${id}`), {
      uid: AUTHOR, record, transactionHash: audit.transactionHash, validation: INDEPENDENT_PUBLISH_VALIDATION,
    }));
    await assertSucceeds(updateDoc(ref, { ...record, fundingPlan: deleteField(), audit, updatedAt: serverTimestamp() }));
    const published = (await assertSucceeds(getDoc(ref))).data();
    assert.equal(published.status, "submitted");
    assert.equal("fundingPlan" in published, false);
    assert.equal(published.audit.transactionHash, audit.transactionHash);
  });
}
