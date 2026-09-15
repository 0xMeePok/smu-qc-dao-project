import test from "node:test";
import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { submitContentReport, moderateContent, getModerationContext } from "../moderation.js";
import { fundMockProposal, selectMockProposal, prepareModerationMatching } from "../matching.js";

test("real Firestore moderation atomically hides selected content, refunds escrow and restores the original ACL", { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  const app = initializeApp({ projectId: "qcdao-moderation-test" }, `moderation-${Date.now()}`);
  const db = getFirestore(app), now = Timestamp.now(), id = `test-${Date.now()}`;
  const owner = `${id}-owner`, author = `${id}-author`, admin = `${id}-admin`, funder = `${id}-funder`;
  const batch = db.batch();
  for (const uid of [owner, author, admin, funder]) batch.set(db.collection("users").doc(uid), { role: uid === admin ? 1 : 0, fullName: uid, organisation: "University" });
  batch.set(db.collection("problems").doc(id), { ownerId: owner, title: "Moderation transaction problem", status: "submitted", currency: "USDC", amount: 100, expiresAt: Timestamp.fromMillis(now.toMillis() + 30 * 86400000), createdAt: now });
  batch.set(db.collection("proposals").doc(id), { researcherId: author, postingOwnerId: owner, problemId: id, title: "Moderation transaction proposal", summary: "A measurable study", status: "submitted", amount: 100, currency: "USDC", createdAt: now, matching: { evaluationComplete: true } });
  await batch.commit();
  try {
    await fundMockProposal({ db, uid: funder, problemId: id, proposalId: id, amount: 100, requestId: `${id}-funding-request`, now });
    await selectMockProposal({ db, uid: owner, problemId: id, proposalId: id, rationale: "Best evaluated proposal", now });
    const reports = await Promise.all([1, 2].map(() => submitContentReport({ db, uid: owner, contentType: "proposal", contentId: id, reason: "misleading", now })));
    assert.equal(reports.filter((report) => report.alreadyReported).length, 1);
    const args = { db, uid: admin, queueId: `proposal_${id}`, reason: "misleading", prepareMatching: prepareModerationMatching, now };
    await moderateContent({ ...args, action: "hide" });
    const hidden = (await db.collection("proposals").doc(id).get()).data();
    const parent = (await db.collection("problems").doc(id).get()).data();
    assert.equal(hidden.status, "moderated_hidden");
    assert.equal(hidden.postingOwnerId, "");
    assert.equal(parent.matching.status, "open");
    assert.equal(parent.matching.totalFundedMinor, 0);
    const ledger = await db.collection("mockFunding").where("problemId", "==", id).get();
    assert.equal(ledger.docs[0].data().status, "refunded");
    await moderateContent({ ...args, action: "restore", reason: "appeal_accepted" });
    const restored = (await db.collection("proposals").doc(id).get()).data();
    assert.equal(restored.status, "submitted");
    assert.equal(restored.postingOwnerId, owner);
    assert.equal(restored.matching.status, "funding");
    assert.equal(restored.matching.fundedMinor, 0);
    assert.equal(restored.matching.evaluationComplete, true);
    const context = await getModerationContext({ db, uid: admin, queueId: `proposal_${id}` });
    assert.equal(context.reports.length, 1);
    assert.equal(context.history.length, 2);
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});
