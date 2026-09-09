import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";

const AUTHOR = `0x${"81".repeat(20)}`;
const SPONSOR = `0x${"91".repeat(20)}`;
const OUTSIDER = `0x${"71".repeat(20)}`;
const ATTACHMENT_DIGEST = `0x${"4".repeat(64)}`;
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
  it("atomically submits with two attachments, then queues the verification receipt", async () => {
    const id = await parent();
    const db = env.authenticatedContext(AUTHOR).firestore();
    const data = record(id, { attachments: ["file0001", "file0002"].map((id) => ({ id, name: "support.pdf", contentType: "application/pdf", size: 200, sha256: ATTACHMENT_DIGEST })) });
    await assertSucceeds(submit(db, "proposal-full", data));
    // Match submitProposal followed by updateProposalReceipt: the wallet audit
    // handoff starts only after the proposal and author slot commit successfully.
    await assertSucceeds(updateDoc(doc(db, "proposals", "proposal-full"), {
      audit: { schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`, status: "queued", transactionHash: "", blockNumber: 0, attemptCount: 0, lastError: "" },
      updatedAt: serverTimestamp(),
    }));
  });
  it("[QCDAO-57] corrects a submitted proposal the way updateProposal writes it", async () => {
    const id = await parent();
    const db = env.authenticatedContext(AUTHOR).firestore();
    const files = ["file0011", "file0012"].map((fid) => ({ id: fid, name: "support.pdf", contentType: "application/pdf", size: 200, sha256: ATTACHMENT_DIGEST }));
    await assertSucceeds(submit(db, "probe-correct", record(id, { attachments: files })));
    // The real client write: updateProposal sends the whole record plus the
    // receipt for the amendment it just anchored, in ONE update.
    await assertSucceeds(updateDoc(doc(db, "proposals", "probe-correct"), {
      ...(({ createdAt, ...rest }) => rest)(record(id, { attachments: files, title: "Annealing routing, corrected" })),
      audit: { schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`, status: "pending", transactionHash: `0x${"3".repeat(64)}`, blockNumber: 0, attemptCount: 0, lastError: "" },
      updatedAt: serverTimestamp(),
    }));
  });

  it("[QCDAO-57] withdraws a submitted proposal carrying two attachments", async () => {
    const id = await parent();
    const db = env.authenticatedContext(AUTHOR).firestore();
    const files = ["file0021", "file0022"].map((fid) => ({ id: fid, name: "support.pdf", contentType: "application/pdf", size: 200, sha256: ATTACHMENT_DIGEST }));
    await assertSucceeds(submit(db, "probe-withdraw", record(id, { attachments: files })));
    await assertSucceeds(updateDoc(doc(db, "proposals", "probe-withdraw"), {
      status: "withdrawn", withdrawalReason: "Team unavailable.", updatedAt: serverTimestamp(),
    }));
  });

  it("[QCDAO-57] corrects an open-funding proposal, the heaviest correction shape", async () => {
    const id = await parent({ opportunityType: "open-funding" });
    const db = env.authenticatedContext(AUTHOR).firestore();
    const files = ["file0031", "file0032"].map((fid) => ({ id: fid, name: "support.pdf", contentType: "application/pdf", size: 200, sha256: ATTACHMENT_DIGEST }));
    await assertSucceeds(submit(db, "probe-of", record(id, {
      opportunityType: "open-funding", attachments: files,
      proposedProblem: "A routing problem worth funding", relevance: "Fits the stated thesis", thesisFit: "Directly on thesis",
    })));
    await assertSucceeds(updateDoc(doc(db, "proposals", "probe-of"), {
      ...(({ createdAt, ...rest }) => rest)(record(id, { opportunityType: "open-funding", attachments: files, title: "Open funding, corrected",
        proposedProblem: "A routing problem worth funding", relevance: "Fits the stated thesis", thesisFit: "Directly on thesis" })),
      audit: { schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`, status: "pending", transactionHash: `0x${"3".repeat(64)}`, blockNumber: 0, attemptCount: 0, lastError: "" },
      updatedAt: serverTimestamp(),
    }));
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
    await assertSucceeds(updateDoc(doc(db, "proposals", "proposal-first"), { status: "withdrawn", withdrawalReason: "Superseded by a stronger approach.", updatedAt: serverTimestamp() }));
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
      attachments: ["file0003", "file0004"].map((id) => ({ id, name: "support.pdf", contentType: "application/pdf", size: 200, sha256: ATTACHMENT_DIGEST })),
    }));
    // Receipt creation is an asynchronous handoff after the proposal is saved.
    await assertSucceeds(updateDoc(doc(db, "proposals", "funding-complete"), {
      audit: { schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`, status: "queued", transactionHash: "", blockNumber: 0, attemptCount: 0, lastError: "" },
      updatedAt: serverTimestamp(),
    }));
  });
  it("requires attachment digests for new submissions", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent();
    const attachment = { id: "digestfile", name: "support.pdf", contentType: "application/pdf", size: 200 };
    await assertFails(submit(db, "proposal-missing-digest", record(id, { attachments: [attachment] })));
    await assertFails(submit(db, "proposal-bad-digest", record(id, { attachments: [{ ...attachment, sha256: "bad" }] })));
    const draft = record(id, { status: "draft", attachments: [attachment] });
    delete draft.postingOwnerId;
    await assertSucceeds(setDoc(doc(db, "proposals", "proposal-draft-digest"), draft));
    const publish = (attachments) => {
      const batch = writeBatch(db);
      batch.update(doc(db, "proposals", "proposal-draft-digest"), { status: "submitted", postingOwnerId: SPONSOR, attachments, updatedAt: serverTimestamp() });
      batch.set(doc(db, "problems", id, "proposalAuthors", AUTHOR), { proposalId: "proposal-draft-digest" });
      return batch.commit();
    };
    await assertFails(publish([attachment]));
    await assertSucceeds(publish([{ ...attachment, sha256: ATTACHMENT_DIGEST }]));
  });
  it("preserves the first known audit transaction hash", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent();
    const proposalId = `proposal-hash-${serial}`;
    const baseAudit = { schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`,
      contentHash: `0x${"2".repeat(64)}`, status: "queued", transactionHash: "", blockNumber: 0,
      attemptCount: 0, lastError: "" };
    await assertSucceeds(submit(db, proposalId, record(id, { audit: baseAudit })));
    const ref = doc(db, "proposals", proposalId);
    const firstHash = `0x${"3".repeat(64)}`;
    const submitted = { ...baseAudit, status: "submitted", transactionHash: firstHash };
    await assertSucceeds(updateDoc(ref, { audit: submitted, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { "audit.transactionHash": `0x${"5".repeat(64)}`, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { audit: baseAudit, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { audit: deleteField(), updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(ref, { audit: { ...submitted, status: "pending", attemptCount: 1 }, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(ref, { "audit.status": "failed", "audit.lastError": "RPC unavailable", updatedAt: serverTimestamp() }));
  });
  it("does not allow a known hash to be erased by deleting a draft", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent();
    const proposalId = `draft-hash-${serial}`;
    const draft = record(id, { status: "draft" });
    delete draft.postingOwnerId;
    await assertSucceeds(setDoc(doc(db, "proposals", proposalId), draft));
    await assertSucceeds(deleteDoc(doc(db, "proposals", proposalId)));
    await assertSucceeds(setDoc(doc(db, "proposals", proposalId), draft));
    await assertSucceeds(updateDoc(doc(db, "proposals", proposalId), {
      audit: { schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`,
        contentHash: `0x${"2".repeat(64)}`, status: "submitted", transactionHash: `0x${"3".repeat(64)}`,
        blockNumber: 0, attemptCount: 1, lastError: "" },
      updatedAt: serverTimestamp(),
    }));
    await assertFails(deleteDoc(doc(db, "proposals", proposalId)));
  });
  it("permits the author's own correction but never self-acceptance or reassignment", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    await assertSucceeds(updateDoc(doc(db, "proposals", "proposal-full"), { methodology: "Changed after submission", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, "proposals", "proposal-full"), { status: "accepted", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, "proposals", "proposal-full"), { researcherId: OUTSIDER, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, "proposals", "proposal-full"), { problemId: "another-problem", updatedAt: serverTimestamp() }));
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

it("protects server-confirmed proposal receipts while allowing withdrawal", async () => {
  const db = env.authenticatedContext(AUTHOR).firestore();
  const id = await parent();
  await assertSucceeds(submit(db, "confirmed-proposal", record(id)));
  const audit = { schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`, status: "confirmed", transactionHash: `0x${"3".repeat(64)}`, blockNumber: 88, attemptCount: 1, lastError: "" };
  await assertFails(updateDoc(doc(db, "proposals", "confirmed-proposal"), { audit, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, "proposals", "confirmed-proposal"), { audit: { ...audit, status: "pending", blockNumber: 0 }, updatedAt: serverTimestamp() }));
  // Preserving a known transaction hash does not grant permission to confirm it.
  await assertFails(updateDoc(doc(db, "proposals", "confirmed-proposal"), { audit, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, "proposals", "confirmed-proposal"), { "audit.status": "confirmed", updatedAt: serverTimestamp() }));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "proposals", "confirmed-proposal"), { audit }));
  await assertFails(updateDoc(doc(db, "proposals", "confirmed-proposal"), { "audit.status": "pending", updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, "proposals", "confirmed-proposal"), { status: "withdrawn", withdrawalReason: "Withdrawing to correct the costing.", updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(db, "proposalAuditJobs", "forged-job"), { status: "confirmed" }));
  await assertFails(getDocs(collection(db, "proposalAuditJobs")));
});

describe("QCDAO-57 draft, edit and withdraw", () => {
  const receipt = (overrides = {}) => ({
    schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`,
    contentHash: `0x${"2".repeat(64)}`, status: "queued", transactionHash: "",
    blockNumber: 0, attemptCount: 0, lastError: "", ...overrides,
  });
  const confirmed = receipt({ status: "confirmed", transactionHash: `0x${"3".repeat(64)}`, blockNumber: 88, attemptCount: 1 });
  const correction = (problemId, overrides = {}) => {
    const { createdAt, ...rest } = record(problemId, overrides);
    return { ...rest, updatedAt: serverTimestamp() };
  };

  it("saves a barely-started draft, hides it from the sponsor, and promotes it in place", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent();
    // A title and nothing else. Saving mid-thought is the entire point of a
    // draft, so none of the submission requirements may apply yet.
    await assertSucceeds(setDoc(doc(db, "proposals", "partial-draft"), {
      researcherId: AUTHOR, problemId: id, title: "Routing, first pass", status: "draft",
      attachments: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(doc(db, "proposals", "empty-draft"), {
      researcherId: AUTHOR, problemId: id, status: "draft",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
    // Bounded even while unfinished, so a draft cannot be used as free storage.
    await assertFails(setDoc(doc(db, "proposals", "oversized-draft"), {
      researcherId: AUTHOR, problemId: id, status: "draft", methodology: "x".repeat(4001),
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
    await assertFails(getDoc(doc(env.authenticatedContext(SPONSOR).firestore(), "proposals", "partial-draft")));
    await assertFails(getDoc(doc(env.authenticatedContext(OUTSIDER).firestore(), "proposals", "partial-draft")));

    // Promotion keeps the id, so the attachments already stored under it and the
    // audit entity derived from it both survive the transition.
    const batch = db.batch ? db.batch() : writeBatch(db);
    batch.update(doc(db, "proposals", "partial-draft"), correction(id));
    batch.set(doc(db, "problems", id, "proposalAuthors", AUTHOR), { proposalId: "partial-draft" });
    await assertSucceeds(batch.commit());
  });

  it("corrects a submitted proposal only with a reset receipt, and never once evaluation begins", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent();
    await assertSucceeds(submit(db, "correctable", record(id)));
    const ref = doc(db, "proposals", "correctable");

    // A correction must stay a complete proposal: it cannot blank a field,
    // retarget the sponsor, or quietly relabel the opportunity.
    await assertFails(updateDoc(ref, correction(id, { methodology: "" })));
    await assertFails(updateDoc(ref, correction(id, { postingOwnerId: OUTSIDER })));
    await assertFails(updateDoc(ref, correction(id, { opportunityType: "open-funding" })));
    await assertSucceeds(updateDoc(ref, correction(id, { methodology: "Rewritten against a classical baseline" })));

    // With a confirmed receipt in place the same edit is refused, because the
    // hash it attests to would no longer describe the record. Resetting the
    // receipt to queued is what makes it acceptable.
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "proposals", "correctable"), { audit: confirmed }));
    await assertFails(updateDoc(ref, correction(id, { timeline: "16 weeks" })));
    await assertFails(updateDoc(ref, { ...correction(id, { timeline: "16 weeks" }), audit: confirmed }));
    await assertSucceeds(updateDoc(ref, { ...correction(id, { timeline: "16 weeks" }), audit: receipt() }));
    // The chain is written first, so a correction normally arrives carrying the
    // receipt for the updateHashes amendment its author has just had mined.
    await assertSucceeds(updateDoc(ref, {
      ...correction(id, { timeline: "18 weeks" }),
      audit: receipt({ status: "pending", transactionHash: `0x${"5".repeat(64)}`, blockNumber: 91, attemptCount: 1 }),
    }));

    // under_review is the lock. Only an evaluator's workflow reaches it, so it
    // is set here the way the platform would.
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "proposals", "correctable"), { status: "under_review" }));
    await assertFails(updateDoc(ref, correction(id, { status: "under_review", team: "A different team" })));
    await assertFails(updateDoc(ref, correction(id, { team: "A different team" })));
  });

  it("accepts a submission that already carries the receipt it was anchored with", async () => {
    // Chain-first: the transaction is mined before the proposal is written, so
    // the record and its receipt arrive in the same create. `confirmed` stays a
    // server attestation and is refused even here.
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent();
    const anchored = receipt({ status: "pending", transactionHash: `0x${"6".repeat(64)}`, blockNumber: 90, attemptCount: 1 });
    await assertFails(submit(db, "anchored-confirmed", record(id, { audit: confirmed })));
    await assertSucceeds(submit(db, "anchored-first", record(id, { audit: anchored })));
  });

  it("stays inside the expression budget for the heaviest SUBMISSION", async () => {
    // Reported from the preview channel: an open-funding proposal with one
    // attachment wrote fine before the receipt moved into the create, and
    // permission-denied afterwards. Chain-first put the audit map on the same
    // write as the full open-funding schema and the attachment entry.
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent({ opportunityType: "open-funding" });
    const framing = { opportunityType: "open-funding", proposedProblem: "Improve emergency routing", relevance: "Faster response", thesisFit: "Resilient public systems" };
    const files = (...ids) => ids.map((id) => ({
      id, name: "proposal.pdf", contentType: "application/pdf", size: 7603202, sha256: ATTACHMENT_DIGEST,
    }));
    await assertSucceeds(submit(db, "heaviest-submit", record(id, {
      ...framing, attachments: files("fileaaa1", "fileaaa2"),
    })));
    // The receipt lands in its own write. Carrying it on the create as well is
    // what crossed the cap, so the client writes it second; see
    // CreateProposalPage. This asserts the write that actually happens.
    await assertSucceeds(updateDoc(doc(db, "proposals", "heaviest-submit"), {
      audit: receipt({ status: "pending", transactionHash: `0x${"8".repeat(64)}`, blockNumber: 306630536, attemptCount: 1 }),
      updatedAt: serverTimestamp(),
    }));
  });

  it("stays inside the expression budget for the heaviest correction", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent({ opportunityType: "open-funding" });
    const framing = { opportunityType: "open-funding", proposedProblem: "Improve emergency routing", relevance: "Faster response", thesisFit: "Resilient public systems" };
    const attachments = ["file0007", "file0008"].map((id) => ({ id, name: "support.pdf", contentType: "application/pdf", size: 200, sha256: ATTACHMENT_DIGEST }));
    await assertSucceeds(submit(db, "heaviest", record(id, { ...framing, attachments })));
    // Every optional field present, two attachments and a receipt on the same
    // write. This is the shape that has repeatedly crossed the 1000-expression
    // cap, so it is asserted rather than assumed.
    await assertSucceeds(updateDoc(doc(db, "proposals", "heaviest"), {
      ...correction(id, { ...framing, attachments, thesisFit: "Resilient public systems, restated" }),
      audit: receipt(),
    }));
  });

  it("requires a reason to withdraw, and freezes it once given", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent();
    await assertSucceeds(submit(db, "withdrawable", record(id)));
    const ref = doc(db, "proposals", "withdrawable");
    await assertFails(updateDoc(ref, { status: "withdrawn", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { status: "withdrawn", withdrawalReason: "", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { status: "withdrawn", withdrawalReason: "x".repeat(1001), updatedAt: serverTimestamp() }));
    // A reason belongs to a withdrawal, not to a live proposal.
    await assertFails(updateDoc(ref, { withdrawalReason: "Planning to pull this later.", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(ref, { status: "withdrawn", withdrawalReason: "The costing was wrong.", updatedAt: serverTimestamp() }));
    // Rewriting the stated reason after the fact is what the audit layer exists
    // to prevent, so it is refused even though the author still owns the record.
    await assertFails(updateDoc(ref, { withdrawalReason: "A more flattering reason.", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { status: "submitted", updatedAt: serverTimestamp() }));
    // Withdrawal frees the author slot, so a replacement can be filed.
    await assertSucceeds(submit(db, "withdrawable-replacement", record(id)));
  });

  it("keeps the edit trail readable by both parties and writable by neither", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    const id = await parent();
    await assertSucceeds(submit(db, "trailed", record(id)));
    const entry = {
      actor: AUTHOR, researcherId: AUTHOR, postingOwnerId: SPONSOR,
      changedFields: ["methodology"], previousStatus: "submitted", status: "submitted",
      contentHashBefore: `0x${"a".repeat(64)}`, contentHashAfter: `0x${"b".repeat(64)}`,
      at: new Date(),
    };
    // Only the Admin SDK can put an entry here; the trigger runs with it.
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "proposals", "trailed", "revisions", "rev1"), entry));
    const trail = (client) => collection(client, "proposals", "trailed", "revisions");
    const sponsor = env.authenticatedContext(SPONSOR).firestore();
    await assertSucceeds(getDocs(query(trail(db), where("researcherId", "==", AUTHOR))));
    await assertSucceeds(getDocs(query(trail(sponsor), where("postingOwnerId", "==", SPONSOR))));
    await assertFails(getDocs(query(trail(env.authenticatedContext(OUTSIDER).firestore()), where("researcherId", "==", AUTHOR))));
    // The author of the edit is exactly who must not be able to shape its record.
    await assertFails(setDoc(doc(trail(db), "forged"), entry));
    await assertFails(updateDoc(doc(trail(db), "rev1"), { changedFields: [] }));
    await assertFails(deleteDoc(doc(trail(db), "rev1")));
    await assertFails(setDoc(doc(trail(sponsor), "forged-by-sponsor"), entry));
  });
});
