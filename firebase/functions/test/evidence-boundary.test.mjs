import assert from "node:assert/strict";
import { it } from "node:test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { persistDeliveryEvidence, hashDeliveryEvidence } from "../deliveryEvidence.js";
import { backfillEvidenceQuotaPage } from "../evidenceQuotaMigration.js";
import { evidenceCounterKeys, evidenceDay } from "../evidenceQuotas.js";

it("real Firestore transactions backfill orphaned groups and enforce cross-store racing quotas", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = initializeApp({ projectId: `demo-evidence-${process.pid}` }, `evidence-${process.pid}`), db = getFirestore(app);
  const uid = `0x${"ab".repeat(20)}`, now = Timestamp.now();
  const parent = { researcherId: uid, status: "submitted", proposalKind: "independent", fundingTerms: {} };
  const evidence = i => ({ summary: `Actual Firestore results ${i}`, url: "https://example.org/results" });
  const save = (i, collection = "deliveryEvidence") => persistDeliveryEvidence({ db, uid, proposalId: "p",
    evidence: evidence(i), evidenceHash: hashDeliveryEvidence(evidence(i)), now, collection });
  try {
    await db.collection("users").doc(uid).set({ role: 0 });
    await db.collection("proposals").doc("p").set(parent);
    await db.collection("proposals/orphan/deliveryEvidence").doc("legacy.one").set({ ownerId: "bad", createdAt: now });
    await db.collection("proposals/orphan/deliveryEvidence").doc("legacy.two").set({ ownerId: uid, createdAt: now });
    await db.collection("proposals/retired/independentFundingEvidence").doc("retained").set({ ownerId: uid });
    await assert.rejects(save(0), error => error.code === "unavailable");
    for (let page = 0; page < 10; page++) if ((await backfillEvidenceQuotaPage({ db, now, pageSize: 1 })).done) break;
    assert.equal((await db.collection("maintenanceState").doc("evidenceQuotasV1").get()).data().ready, true);
    assert.equal((await db.collection("evidenceQuotas").doc("global").get()).data().count, 3);
    assert.equal((await db.collection("proposals/orphan/deliveryEvidence").doc("legacy.one").get()).data().ownerId, "bad");
    // Advance the member's shared daily counter to two slots below its limit.
    const keys = evidenceCounterKeys({ proposalPath: "proposals/p", ownerBucket: uid, day: evidenceDay(now) });
    await db.collection("evidenceQuotas").doc(keys[4]).set({ count: 28 });
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => save(i,
      i % 2 ? "independentFundingEvidence" : "deliveryEvidence")));
    assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 2);
    assert(outcomes.filter(row => row.status === "rejected").every(row => row.reason.code === "resource-exhausted"));
    const index = outcomes.findIndex(row => row.status === "fulfilled");
    const path = `proposals/p/${index % 2 ? "independentFundingEvidence" : "deliveryEvidence"}/${hashDeliveryEvidence(evidence(index))}`;
    const old = (await db.doc(path).get()).data();
    await save(index, index % 2 ? "independentFundingEvidence" : "deliveryEvidence");
    assert.deepEqual((await db.doc(path).get()).data(), old);
    assert.equal((await db.collection("evidenceQuotas").doc("global").get()).data().count, 5);
  } finally { await db.terminate(); await deleteApp(app); }
});
