import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const projectId = process.env.GCLOUD_PROJECT || "qc-dao-demo";
initializeApp({ projectId });
const db = getFirestore();
const account = privateKeyToAccount(generatePrivateKey()), uid = account.address.toLowerCase();
const base = `http://127.0.0.1:5001/${projectId}/asia-southeast1`;
let token;
async function call(name, data, auth = token) {
  const response = await fetch(`${base}/${name}`, { method: "POST", headers: {
    "Content-Type": "application/json", Origin: "http://localhost:5173", "X-Emulator-Test-Source": uid,
    ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
  }, body: JSON.stringify({ data }) });
  return response.json();
}
before(async () => {
  const nonce = await call("getSiweNonce", { address: uid });
  const signed = await call("verifySiweSignature", { address: uid, signature: await account.signMessage({ message: nonce.result.message }) });
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: signed.result.token, returnSecureToken: true }),
  });
  token = (await response.json()).idToken;
  assert.ok(token);
  await db.collection("users").doc(uid).set({ address: uid, role: 0, fullName: "Resource test", organisation: "University", suspended: false });
});
describe("QCDAO-131/132/134 callable integration", () => {
  it("requires authentication and creates one durable reservation on retry", async () => {
    assert.equal((await call("reserveResource", { scope: "problems", recordId: "boundary-record" }, null)).error.status, "UNAUTHENTICATED");
    for (let i = 0; i < 2; i++) assert.equal((await call("reserveResource", { scope: "problems", recordId: "boundary-record" })).result.reserved, true);
    assert.equal((await db.collection("recordReservations").doc("problems_boundary-record").get()).data().uid, uid);
  });
  it("does not create permanent tombstones for nonexistent attachments", async () => {
    for (let i = 0; i < 5; i++) {
      const result = await call("removeAttachment", { scope: "proposals", recordId: "boundary-absent", attachmentId: `absent00${i}` });
      assert.equal(result.result?.removed, true, JSON.stringify(result));
      assert.equal((await db.collection("uploadReservations").doc(`proposals.boundary-absent.absent00${i}`).get()).exists, false);
    }
  });
  it("does not retire or refund a reservation through an underscore alias", async () => {
    const digest = `0x${"6".repeat(64)}`;
    const reserved = await call("reserveAttachment", {
      scope: "problems", recordId: "p_a", attachmentId: "file0001", size: 10, sha256: digest,
    });
    assert.equal(reserved.result?.reservationId, "problems.p_a.file0001", JSON.stringify(reserved));
    const alias = await call("removeAttachment", {
      scope: "problems", recordId: "p", attachmentId: "a_file0001",
    });
    assert.equal(alias.result?.removed, true, JSON.stringify(alias));
    assert.equal((await db.collection("uploadReservations").doc("problems.p_a.file0001").get()).data().state, "reserved");
    assert.equal((await db.collection("uploadQuotas").doc(uid).get()).data().bytes, 10);

    await db.collection("uploadReservations").doc("problems.p.a_file0001").set({
      uid, scope: "problems", recordId: "p_a", attachmentId: "file0001",
      path: `problems/${uid}/p_a/file0001.pdf`, state: "reserved", sealed: false,
      size: 10, sha256: digest,
    });
    const mismatched = await call("removeAttachment", {
      scope: "problems", recordId: "p", attachmentId: "a_file0001",
    });
    assert.equal(mismatched.error?.status, "PERMISSION_DENIED", JSON.stringify(mismatched));
    assert.equal((await db.collection("uploadQuotas").doc(uid).get()).data().bytes, 10);
  });
  it("will not attest a publication with no mined transaction", async () => {
    const result = await call("attestPublication", { scope: "problems", recordId: "boundary-unverified", record: {
      ownerId: uid, expiresAt: "2099-01-01", amount: 1000, status: "submitted", title: "No transaction", attachments: [],
    } });
    assert.equal(result.error?.status, "FAILED_PRECONDITION");
    assert.equal((await db.collection("publicationProofs").doc("problems_boundary-unverified").get()).exists, false);
  });
  it("honours sealed evidence and suspended members at the callable boundary", async () => {
    await db.collection("uploadReservations").doc("problems.boundary-record.sealed01").set({
      uid, scope: "problems", recordId: "boundary-record", attachmentId: "sealed01",
      path: `problems/${uid}/boundary-record/sealed01.pdf`, sealed: true, state: "reserved",
    });
    const denied = await call("removeAttachment", { scope: "problems", recordId: "boundary-record", attachmentId: "sealed01" });
    assert.equal(denied.error?.status, "PERMISSION_DENIED");
    await db.collection("users").doc(uid).update({ suspended: true });
    assert.equal((await call("reserveResource", { scope: "problems", recordId: "boundary-suspended" })).error?.status, "PERMISSION_DENIED");
  });
});
