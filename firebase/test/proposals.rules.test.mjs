import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";

const AUTHOR = `0x${"81".repeat(20)}`;
const SPONSOR = `0x${"91".repeat(20)}`;
const OUTSIDER = `0x${"71".repeat(20)}`;
let env;
let serial = 0;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "qc-dao-rules-test", firestore: { rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const id of [AUTHOR, SPONSOR, OUTSIDER]) await setDoc(doc(ctx.firestore(), "users", id), { address: id, role: 0, suspended: false, fullName: "Research User", organisation: "University", walletVerified: true, termsAcceptedAt: new Date(), termsVersion: "2026-08-24" });
  });
});
after(async () => { await env?.cleanup(); });
async function parent(overrides = {}) {
  const id = `proposal-parent-${++serial}`;
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "problems", id), { ownerId: SPONSOR, status: "submitted", currency: "USDC", expiresAt: new Date("2099-01-01"), ...overrides }));
  return id;
}
function record(problemId, overrides = {}) {
  return { researcherId: AUTHOR, postingOwnerId: SPONSOR, problemId, opportunityType: "business-problem", title: "Annealing routing", summary: "A measurable routing study", category: "quantum-annealing", methodology: "Compare annealing against a classical baseline", suitability: "A combinatorial routing problem", expectedOutcomes: "Improved routing", successCriteria: "10 percent less travel", timeline: "12 weeks", milestones: "Baseline, prototype, validation", team: "Operations research team", amount: 1500, currency: "USDC", status: "submitted", attachments: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...overrides };
}
function submit(db, id, data, withSlot = true) {
  const batch = writeBatch(db);
  batch.set(doc(db, "proposals", id), data);
  if (withSlot) batch.set(doc(db, "problems", data.problemId, "proposalAuthors", AUTHOR), { proposalId: id });
  return batch.commit();
}
describe("QCDAO-59/60 submitted proposals", () => {
  it("atomically submits with two attachments and a queued verification receipt", async () => {
    const id = await parent();
    const data = record(id, { attachments: ["file0001", "file0002"].map((id) => ({ id, name: "support.pdf", contentType: "application/pdf", size: 200 })), audit: { schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`, status: "queued", transactionHash: "", blockNumber: 0, attemptCount: 0, lastError: "" } });
    await assertSucceeds(submit(env.authenticatedContext(AUTHOR).firestore(), "proposal-full", data));
  });
  it("allows sponsor dashboard reads and denies unrelated wallets", async () => {
    const sponsor = env.authenticatedContext(SPONSOR).firestore();
    await assertSucceeds(getDoc(doc(sponsor, "proposals", "proposal-full")));
    await assertSucceeds(getDocs(query(collection(sponsor, "proposals"), where("postingOwnerId", "==", SPONSOR))));
    await assertFails(getDoc(doc(env.authenticatedContext(OUTSIDER).firestore(), "proposals", "proposal-full")));
  });
  it("blocks concurrent duplicate submissions and permits a replacement after withdrawal", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent();
    await assertSucceeds(submit(db, "proposal-first", record(id)));
    await assertFails(submit(db, "proposal-duplicate", record(id)));
    await assertFails(submit(db, "proposal-no-slot", record(id), false));
    await assertSucceeds(updateDoc(doc(db, "proposals", "proposal-first"), { status: "withdrawn", updatedAt: serverTimestamp() }));
    await assertSucceeds(submit(db, "proposal-replacement", record(id)));
  });
  it("blocks expired, withdrawn, moderated and accepted parents", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    for (const patch of [{ expiresAt: new Date(0) }, { status: "withdrawn" }, { status: "moderated" }, { moderated: true }, { acceptedProposalId: "winner" }, { acceptedSolutionId: "winner" }, { hasAcceptedSolution: true }]) {
      const id = await parent(patch);
      await assertFails(submit(db, `closed-${serial}`, record(id)));
    }
  });
  it("requires open-funding problem framing and authentic sponsor linkage", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent({ opportunityType: "open-funding" });
    await assertFails(submit(db, "funding-no-framing", record(id, { opportunityType: "open-funding" })));
    const data = record(id, { opportunityType: "open-funding", proposedProblem: "Improve emergency routing", relevance: "Faster response", thesisFit: "Resilient public systems" });
    await assertFails(submit(db, "funding-forged-owner", { ...data, postingOwnerId: OUTSIDER }));
    await assertSucceeds(submit(db, "funding-complete", { ...data,
      amount: 1500.25,
      attachments: ["file0003", "file0004"].map((id) => ({ id, name: "support.pdf", contentType: "application/pdf", size: 200 })),
    }));
    // Receipt creation is an asynchronous handoff after the proposal is saved.
    await assertSucceeds(updateDoc(doc(db, "proposals", "funding-complete"), {
      audit: { schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`, status: "queued", transactionHash: "", blockNumber: 0, attemptCount: 0, lastError: "" },
      updatedAt: serverTimestamp(),
    }));
  });
  it("prevents editing submitted content and self-acceptance, while allowing audit retries", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    await assertFails(updateDoc(doc(db, "proposals", "proposal-full"), { methodology: "Changed after submission", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, "proposals", "proposal-full"), { status: "accepted", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(db, "proposals", "proposal-full"), { "audit.status": "failed", "audit.attemptCount": 1, "audit.lastError": "Network unavailable", updatedAt: serverTimestamp() }));
  });
  it("rejects a draft that forges sponsor linkage or grants inbox / attachment ACL", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent();
    const privateDraft = record(id, { status: "draft" });
    delete privateDraft.postingOwnerId;
    await assertFails(setDoc(doc(db, "proposals", "forged-draft"), record(id, { status: "draft" })));
    await assertFails(setDoc(doc(db, "proposals", "forged-draft-outsider"), record(id, { status: "draft", postingOwnerId: OUTSIDER })));
    await assertSucceeds(setDoc(doc(db, "proposals", "private-draft"), privateDraft));
    await assertSucceeds(getDoc(doc(db, "proposals", "private-draft")));
    await assertFails(updateDoc(doc(db, "proposals", "private-draft"), { postingOwnerId: SPONSOR, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, "proposals", "private-draft"), { status: "withdrawn", postingOwnerId: SPONSOR, updatedAt: serverTimestamp() }));
    const sponsor = env.authenticatedContext(SPONSOR).firestore();
    await assertFails(getDoc(doc(sponsor, "proposals", "private-draft")));
    await assertSucceeds(getDoc(doc(sponsor, "proposals", "proposal-full")));
  });
});
