import assert from "node:assert/strict";
import { it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { hashDeliveryEvidence, persistDeliveryEvidence } from "../deliveryEvidence.js";
import { registerDeliveryEvidenceFunctions } from "../deliveryEvidenceFunctions.js";
import { EVIDENCE_LIMITS, evidenceChargeId, evidenceCounterKeys, evidenceDay } from "../evidenceQuotas.js";

const uid = `0x${"a".repeat(40)}`, other = `0x${"b".repeat(40)}`;
const now = Timestamp.fromDate(new Date("2026-11-05T00:00:00Z"));
const evidence = i => ({ summary: `Delivered results ${i}`, url: "https://example.org/results" });
const fixture = (initial = {}) => memoryDb({ [`users/${uid}`]: { role: 0 },
  "proposals/p": { researcherId: uid, status: "submitted", proposalKind: "independent", fundingTerms: {} },
  "maintenanceState/evidenceQuotasV1": { version: 1, ready: true }, ...initial });
const save = (db, i = 0, extra = {}) => persistDeliveryEvidence({ db, uid, authTime: 100, proposalId: "p",
  evidence: evidence(i), evidenceHash: hashDeliveryEvidence(evidence(i)), now, ...extra });
const counterKeys = (owner = uid, proposal = "p", date = now) => evidenceCounterKeys({ ownerBucket: owner,
  proposalPath: `proposals/${proposal}`, day: evidenceDay(date) });

it("charges canonical immutable evidence atomically and permits exact retries at full quota", async () => {
  const db = fixture();
  const raw = { summary: "  Cafe\u0301 delivered  ", url: " https://example.org/cafe " };
  const hash = hashDeliveryEvidence(raw);
  await save(db, 0, { evidence: raw, evidenceHash: hash });
  const path = `proposals/p/deliveryEvidence/${hash}`;
  assert.deepEqual(db.records.get(path), { summary: "Café delivered", url: "https://example.org/cafe", ownerId: uid, createdAt: now });
  assert.equal(db.records.get(`evidenceCharges/${evidenceChargeId(path)}`).sourcePath, path);
  db.records.set("evidenceQuotas/global", { count: EVIDENCE_LIMITS.globalLifetime });
  const before = new Map(db.records);
  await save(db, 0, { evidence: raw, evidenceHash: hash, now: Timestamp.fromMillis(now.toMillis() + 1000) });
  assert.deepEqual(db.records, before);
  await assert.rejects(save(db, 1), error => error.code === "resource-exhausted");
  db.records.set(path, { ...db.records.get(path), summary: "Conflicting immutable legacy content" });
  await assert.rejects(save(db, 0, { evidence: raw, evidenceHash: hash }), /differs from this hash/);
});

it("racing main and independent writers share daily limits and duplicate retries charge once", async () => {
  const db = fixture();
  const outcomes = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => save(db, i,
    { collection: i % 2 ? "independentFundingEvidence" : "deliveryEvidence" })));
  assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 30);
  assert(outcomes.filter(row => row.status === "rejected").every(row => row.reason.code === "resource-exhausted"));
  assert.equal(db.records.get("evidenceQuotas/global").count, 30);
  const duplicateDb = fixture();
  await Promise.all(Array.from({ length: 20 }, () => save(duplicateDb)));
  for (const key of counterKeys()) assert.equal(duplicateDb.records.get(`evidenceQuotas/${key}`).count, 1);
});

it("enforces each lifetime and daily boundary independently with no partial writes", async () => {
  const limits = [EVIDENCE_LIMITS.globalLifetime, EVIDENCE_LIMITS.memberLifetime,
    EVIDENCE_LIMITS.proposalLifetime, EVIDENCE_LIMITS.globalDaily, EVIDENCE_LIMITS.memberDaily];
  for (let index = 0; index < limits.length; index++) {
    const db = fixture({ [`evidenceQuotas/${counterKeys()[index]}`]: { count: limits[index] - 1 } });
    await save(db, 0);
    const before = new Map(db.records);
    await assert.rejects(save(db, 1), error => error.code === "resource-exhausted");
    assert.deepEqual(db.records, before, `limit ${index} must commit neither evidence nor counters`);
  }
});

it("UTC rollover resets daily allowances but retains proposal/member/global lifetime limits", async () => {
  const db = fixture();
  await save(db);
  const tomorrow = Timestamp.fromMillis(now.toMillis() + 86400_000);
  await save(db, 1, { now: tomorrow });
  assert.equal(db.records.get(`evidenceQuotas/${counterKeys()[3]}`).count, 1);
  assert.equal(db.records.get(`evidenceQuotas/${counterKeys(uid, "p", tomorrow)[3]}`).count, 1);
  assert.equal(db.records.get("evidenceQuotas/global").count, 2);
});

it("rechecks active authorization, parent, maintenance and retirement inside the transaction", async () => {
  const cases = [
    { [`users/${uid}`]: undefined }, { [`users/${uid}`]: { suspended: true } },
    { [`users/${uid}`]: { sessionsValidAfterEpoch: 100 } }, { [`sessionRevocations/${uid}`]: { sessionsValidAfterEpoch: 101 } },
    { "proposals/p": undefined }, { "proposals/p": { researcherId: other, status: "submitted", fundingTerms: {} } },
    { "proposals/p": { researcherId: uid, status: "draft", fundingTerms: {} } },
    { "proposals/p": { researcherId: uid, status: "submitted" } },
    { "maintenanceState/registryCutover": { active: true } }, { "recordReservations/proposals_p": { retired: true } },
  ];
  for (const patch of cases) {
    const db = fixture();
    for (const [path, value] of Object.entries(patch)) if (value === undefined) db.records.delete(path); else db.records.set(path, value);
    const before = new Map(db.records);
    await assert.rejects(save(db));
    assert.deepEqual(db.records, before);
  }
  const db = fixture();
  await save(db);
  db.records.set(`users/${uid}`, { suspended: true });
  await assert.rejects(save(db), /active member/);
});

it("fails closed until backfill is complete while authorized retained retries remain usable", async () => {
  for (const marker of [undefined, { ready: false, version: 1 }, { ready: true, version: 2 }]) {
    const db = fixture();
    if (marker === undefined) db.records.delete("maintenanceState/evidenceQuotasV1"); else db.records.set("maintenanceState/evidenceQuotasV1", marker);
    await assert.rejects(save(db), error => error.code === "unavailable");
    db.records.set(`proposals/p/deliveryEvidence/${hashDeliveryEvidence(evidence(0))}`, { ...evidence(0), ownerId: uid, createdAt: now });
    const before = new Map(db.records);
    await save(db);
    assert.deepEqual(db.records, before);
  }
});

it("passes fresh authentication through the callable, ignores client namespace/owner, and rechecks raced revocation", async () => {
  const db = fixture({ [`users/${uid}`]: { sessionsValidAfterEpoch: 100 },
    [`sessionRevocations/${uid}`]: { sessionsValidAfterEpoch: 100 } });
  const { saveDeliveryEvidence } = registerDeliveryEvidenceFunctions({ db, options: {}, requireMember: async request => request.auth.uid });
  const request = authTime => ({ auth: { uid, token: { auth_time: authTime } },
    data: { proposalId: "p", evidence: evidence(0), evidenceHash: hashDeliveryEvidence(evidence(0)),
      collection: "independentFundingEvidence", ownerId: other } });
  await assert.rejects(saveDeliveryEvidence.run(request(100)), error => error.code === "permission-denied");
  await saveDeliveryEvidence.run(request(101));
  const saved = [...db.records.keys()].find(path => path.includes("/deliveryEvidence/"));
  assert.equal(db.records.get(saved).ownerId, uid);
  assert.equal([...db.records.keys()].some(path => path.includes("/independentFundingEvidence/")), false);
  const transaction = db.runTransaction.bind(db);
  db.runTransaction = callback => {
    db.records.set(`sessionRevocations/${uid}`, { sessionsValidAfterEpoch: 101 });
    return transaction(callback);
  };
  await assert.rejects(saveDeliveryEvidence.run(request(101)), error => error.code === "permission-denied");
});

it("rejects forged hashes, unsupported stores and invalid content; retains legacy 128-character IDs", async () => {
  const db = fixture();
  for (const patch of [{ evidenceHash: `0x${"0".repeat(64)}` }, { collection: "revisions" }, { uid: other },
    { evidence: { summary: "x", url: "https://example.org" } }, { evidence: { summary: "xx", url: "http://example.org" } },
    { evidence: { summary: "x".repeat(4001), url: "https://example.org" } }, { proposalId: "../p" }, { proposalId: 1 }]) {
    await assert.rejects(save(db, 0, patch));
  }
  const id = "p".repeat(128);
  db.records.set(`proposals/${id}`, db.records.get("proposals/p"));
  await save(db, 0, { proposalId: id });
  assert.equal(db.records.get("evidenceQuotas/global").count, 1);
});

it("preserves main URL whitespace rejection without changing independent legacy hash/read normalization", async () => {
  const db = fixture();
  for (const url of ["https://example.org/path with space", "https://example.org/path\nline"]) {
    const content = { summary: "Whitespace URL compatibility", url }, evidenceHash = hashDeliveryEvidence(content);
    await assert.rejects(save(db, 0, { evidence: content, evidenceHash }), /without spaces or line breaks/);
    await save(db, 0, { evidence: content, evidenceHash, collection: "independentFundingEvidence" });
  }
});
