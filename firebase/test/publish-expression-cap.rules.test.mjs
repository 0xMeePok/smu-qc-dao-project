// Publishing a posting with PDFs AND its audit receipt - the exact write the app
// sends - crossed Firestore's 1,000-expression cap and was denied in production.
// Publishes are now validated by attestPublication (functions/publicationValidation.js)
// and bound to its marked proof; these cases pin both the fix and its guards.
import fs from "node:fs";
import { after, before, it } from "node:test";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, serverTimestamp, Timestamp } from "firebase/firestore";
import { PUBLISH_VALIDATION, isPublishableProblem } from "../functions/publicationValidation.js";
const mark = (record) => (isPublishableProblem(record, { uid: A, profileOrganisation: "SMU" }) ? { validation: PUBLISH_VALIDATION } : {});

const A = `0x${"a".repeat(40)}`;
let env;
function emulator() {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");
  return { host, port: Number(port) };
}
const EXP = Timestamp.fromMillis(Date.now() + 90 * 864e5);
const att = (i) => ({ id: `124bfa6b-1dac-4d57-a1de-fa35b736198${i}`, name: "Week 6 Lab – From Generated Tests to a CI Gate.pdf",
  size: 580505, contentType: "application/pdf", sha256: `0x${"ab".repeat(32)}` });
const content = (n) => ({ ownerId: A, organisation: "SMU", title: "Testing funding call proposal", businessContext: "Testng",
  summary: "publishing test summary", currentApproach: "publishing testa", currentLimitations: "publishing testa",
  expectedOutcome: "publishing testa", successCriteria: "publishing testa", dataAvailability: "publishing testa",
  categories: ["ai", "quantum"], amount: 10000, currency: "USDT", expiresAt: EXP,
  attachments: Array.from({ length: n }, (_, i) => att(i)) });
const audit = { schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`,
  status: "pending", transactionHash: `0x${"3".repeat(64)}`, blockNumber: 123, attemptCount: 1, lastError: "" };

before(async () => {
  env = await initializeTestEnvironment({ projectId: "qc-dao-rules-test",
    firestore: { rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), ...emulator() } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users", A), { address: A, fullName: "Ashley", organisation: "SMU", role: 0, chainId: 421614,
      stats: { comments: 0, businessProblems: 0, openFunding: 0, fundingRequests: 0, karma: 0, reputation: 0 },
      walletVerified: true, termsAcceptedAt: new Date(), termsVersion: "2026-08-24", createdAt: new Date(), updatedAt: new Date() });
  });
});
after(async () => { await env?.cleanup(); });

async function scenario(id, n, withAudit) {
  const db = env.authenticatedContext(A).firestore();
  const record = { ...content(n), status: "submitted" };
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "problems", id), { ...content(n), status: "draft", createdAt: new Date(), updatedAt: new Date() });
    await setDoc(doc(d, "recordReservations", `problems_${id}`), { uid: A });
    await setDoc(doc(d, "publicationProofs", `problems_${id}`), { uid: A, record, transactionHash: withAudit ? audit.transactionHash : "", ...mark(record) });
  });
  const update = { ...record, updatedAt: serverTimestamp(), ...(withAudit ? { audit } : {}) };
  await assertSucceeds(updateDoc(doc(db, "problems", id), update));
}

for (const n of [0, 1, 2]) {
  it(`publish draft, ${n} PDF(s), no audit`, () => scenario(`p${n}n`, n, false));
  it(`publish draft, ${n} PDF(s), WITH audit (what the app sends)`, () => scenario(`p${n}a`, n, true));
}

async function directCreate(id, n) {
  const db = env.authenticatedContext(A).firestore();
  const record = { ...content(n), status: "submitted" };
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "recordReservations", `problems_${id}`), { uid: A });
    await setDoc(doc(d, "publicationProofs", `problems_${id}`), { uid: A, record, transactionHash: audit.transactionHash, ...mark(record) });
  });
  await assertSucceeds(setDoc(doc(db, "problems", id), { ...record, audit, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
}
for (const n of [1, 2]) it(`direct submit (no draft), ${n} PDF(s), with audit`, () => directCreate(`c${n}`, n));

const fundingContent = (n) => ({ ownerId: A, organisation: "SMU", opportunityType: "open-funding", title: "Open call",
  fundingThesis: "Fund resilient supply chain research.", eligibilityNotes: "Singapore institutions.",
  categories: ["ai"], tags: ["AI & machine learning"], amount: 10000, currency: "USDT", expiresAt: EXP,
  attachments: Array.from({ length: n }, (_, i) => att(i)) });
async function fundingDraftPublish(id, n) {
  const db = env.authenticatedContext(A).firestore();
  const record = { ...fundingContent(n), status: "submitted" };
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "problems", id), { ...fundingContent(n), status: "draft", createdAt: new Date(), updatedAt: new Date() });
    await setDoc(doc(d, "recordReservations", `problems_${id}`), { uid: A });
    await setDoc(doc(d, "publicationProofs", `problems_${id}`), { uid: A, record, transactionHash: audit.transactionHash, ...mark(record) });
  });
  await assertSucceeds(updateDoc(doc(db, "problems", id), { ...record, audit, updatedAt: serverTimestamp() }));
}
for (const n of [0, 1, 2]) it(`open-funding draft publish, ${n} PDF(s), with audit`, () => fundingDraftPublish(`f${n}`, n));

it("refuses a publish against an unmarked (old) proof", async () => {
  const db = env.authenticatedContext(A).firestore();
  const record = { ...content(1), status: "submitted" };
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "problems", "old1"), { ...content(1), status: "draft", createdAt: new Date(), updatedAt: new Date() });
    await setDoc(doc(d, "recordReservations", "problems_old1"), { uid: A });
    await setDoc(doc(d, "publicationProofs", "problems_old1"), { uid: A, record, transactionHash: audit.transactionHash });
  });
  await assertFails(updateDoc(doc(db, "problems", "old1"), { ...record, audit, updatedAt: serverTimestamp() }));
});
it("refuses a field the proof did not attest (e.g. matching)", async () => {
  const db = env.authenticatedContext(A).firestore();
  const record = { ...content(1), status: "submitted" };
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "recordReservations", "problems_inj1"), { uid: A });
    await setDoc(doc(d, "publicationProofs", "problems_inj1"), { uid: A, record, transactionHash: audit.transactionHash, ...mark(record) });
  });
  await assertFails(setDoc(doc(db, "problems", "inj1"), { ...record, audit, matching: { status: "confirmed" }, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
});
it("refuses content that differs from the attested record", async () => {
  const db = env.authenticatedContext(A).firestore();
  const record = { ...content(1), status: "submitted" };
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "recordReservations", "problems_chg1"), { uid: A });
    await setDoc(doc(d, "publicationProofs", "problems_chg1"), { uid: A, record, transactionHash: audit.transactionHash, ...mark(record) });
  });
  await assertFails(setDoc(doc(db, "problems", "chg1"), { ...record, amount: 999999, audit, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
});
it("refuses a receipt for a different transaction", async () => {
  const db = env.authenticatedContext(A).firestore();
  const record = { ...content(1), status: "submitted" };
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "recordReservations", "problems_tx1"), { uid: A });
    await setDoc(doc(d, "publicationProofs", "problems_tx1"), { uid: A, record, transactionHash: audit.transactionHash, ...mark(record) });
  });
  await assertFails(setDoc(doc(db, "problems", "tx1"), { ...record, audit: { ...audit, transactionHash: `0x${"9".repeat(64)}` }, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
});
