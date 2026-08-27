import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || (process.env.FUNCTIONS_BASE_URL?.split("/")[3]) || "qcdao-a0c7a";

if (getApps().length === 0) {
  initializeApp({ projectId: PROJECT_ID });
}
const db = getFirestore();

const BASE =
  process.env.FUNCTIONS_BASE_URL ??
  `http://127.0.0.1:5001/${PROJECT_ID}/asia-southeast1`;

async function call(fn, data, { token = null } = {}) {
  const headers = { "Content-Type": "application/json", Origin: "http://localhost:5173" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data }),
  });
  return res.json().catch(() => ({}));
}

async function getIdTokenForAccount(account) {
  const address = account.address.toLowerCase();
  const { result: nonceRes } = await call("getSiweNonce", { address });
  const signature = await account.signMessage({ message: nonceRes.message });
  const { result: verifyRes } = await call("verifySiweSignature", { address, signature });
  const customToken = verifyRes.token;

  const authRes = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const authData = await authRes.json();
  return authData.idToken;
}

// Test accounts
const adminKey = generatePrivateKey();
const adminAccount = privateKeyToAccount(adminKey);
const adminAddress = adminAccount.address.toLowerCase();

const user1Key = generatePrivateKey();
const user1Account = privateKeyToAccount(user1Key);
const user1Address = user1Account.address.toLowerCase();

const user2Key = generatePrivateKey();
const user2Account = privateKeyToAccount(user2Key);
const user2Address = user2Account.address.toLowerCase();

let adminToken;
let user1Token;

before(async () => {
  // Seed admin profile
  await db.collection("users").doc(adminAddress).set({
    address: adminAddress,
    fullName: "System Administrator",
    organisation: "SMU Admin Office",
    role: 1,
    chainId: 421614,
    walletVerified: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  // Seed normal users
  await db.collection("users").doc(user1Address).set({
    address: user1Address,
    fullName: "Alice Quantum",
    organisation: "SMU School of Computing",
    role: 0,
    chainId: 421614,
    walletVerified: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  await db.collection("users").doc(user2Address).set({
    address: user2Address,
    fullName: "Bob Physicist",
    organisation: "A*STAR Quantum Lab",
    role: 0,
    chainId: 421614,
    walletVerified: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  adminToken = await getIdTokenForAccount(adminAccount);
  user1Token = await getIdTokenForAccount(user1Account);
});

describe("adminListUsers", () => {
  it("[BIT-AAR-001] returns all users when called by an admin", async () => {
    const res = await call("adminListUsers", {}, { token: adminToken });
    assert.ok(res.result?.users, "expected users array in result");
    assert.ok(res.result.users.length >= 3, "expected at least 3 users");
    const foundAdmin = res.result.users.find((u) => u.address === adminAddress);
    assert.equal(foundAdmin?.role, 1);
  });

  it("[BIT-AAR-002] rejects a non-admin caller with permission-denied", async () => {
    const res = await call("adminListUsers", {}, { token: user1Token });
    assert.equal(res.error?.status, "PERMISSION_DENIED");
  });

  it("[BIT-AAR-003] rejects an unauthenticated caller", async () => {
    const res = await call("adminListUsers", {});
    assert.equal(res.error?.status, "UNAUTHENTICATED");
  });

  it("[BIT-AAR-004] filters by role correctly", async () => {
    const res = await call("adminListUsers", { roleFilter: 1 }, { token: adminToken });
    assert.ok(res.result?.users.length >= 1);
    assert.ok(res.result.users.every((u) => u.role === 1));
  });

  it("[BIT-AAR-005] search matches by name substring", async () => {
    const res = await call("adminListUsers", { search: "Alice" }, { token: adminToken });
    assert.ok(res.result?.users.length >= 1);
    assert.ok(res.result.users.some((u) => u.fullName === "Alice Quantum"));
  });
});

describe("adminChangeRole", () => {
  it("[BIT-AAR-006] promotes a user to admin with a reason", async () => {
    const res = await call(
      "adminChangeRole",
      {
        targetAddress: user1Address,
        newRole: 1,
        reason: "Promoting Alice for pilot demonstration coordinator role",
      },
      { token: adminToken },
    );
    assert.equal(res.result?.success, true);
    assert.equal(res.result?.newRole, 1);

    const updatedDoc = await db.collection("users").doc(user1Address).get();
    assert.equal(updatedDoc.data()?.role, 1);
  });

  it("[BIT-AAR-007] writes an audit entry with correct fields on role change", async () => {
    const auditsSnap = await db
      .collection("audits")
      .where("type", "==", "role_change")
      .where("targetAddress", "==", user1Address)
      .get();
    assert.ok(auditsSnap.docs.length >= 1);
    const audit = auditsSnap.docs[0].data();
    assert.equal(audit.actor, adminAddress);
    assert.equal(audit.newRole, 1);
    assert.ok(audit.reason.includes("pilot demonstration"));
  });

  it("[BIT-AAR-008] rejects a non-admin caller", async () => {
    // Demote user1 back for test isolation first
    await db.collection("users").doc(user1Address).update({ role: 0 });
    const freshUser1Token = await getIdTokenForAccount(user1Account);

    const res = await call(
      "adminChangeRole",
      {
        targetAddress: user2Address,
        newRole: 1,
        reason: "Unauthorized promotion attempt",
      },
      { token: freshUser1Token },
    );
    assert.equal(res.error?.status, "PERMISSION_DENIED");
  });

  it("[BIT-AAR-009] rejects a role change to the same role", async () => {
    const res = await call(
      "adminChangeRole",
      {
        targetAddress: user2Address,
        newRole: 0,
        reason: "Assigning role 0 when already 0",
      },
      { token: adminToken },
    );
    assert.equal(res.error?.status, "FAILED_PRECONDITION");
  });

  it("[BIT-AAR-010] rejects a missing or too-short reason", async () => {
    const res = await call(
      "adminChangeRole",
      {
        targetAddress: user2Address,
        newRole: 1,
        reason: "no",
      },
      { token: adminToken },
    );
    assert.equal(res.error?.status, "INVALID_ARGUMENT");
  });

  it("[BIT-AAR-011] rejects self-targeting (admin modifying own role)", async () => {
    const res = await call(
      "adminChangeRole",
      {
        targetAddress: adminAddress,
        newRole: 0,
        reason: "Self demotion is forbidden",
      },
      { token: adminToken },
    );
    assert.equal(res.error?.status, "FAILED_PRECONDITION");
  });
});

describe("adminSetSuspended", () => {
  it("[BIT-AAR-012] suspends a user and writes an audit entry", async () => {
    const res = await call(
      "adminSetSuspended",
      {
        targetAddress: user2Address,
        suspended: true,
        reason: "Temporarily suspended during cross-org reset demo",
      },
      { token: adminToken },
    );
    assert.equal(res.result?.success, true);
    assert.equal(res.result?.suspended, true);

    const userDoc = await db.collection("users").doc(user2Address).get();
    assert.equal(userDoc.data()?.suspended, true);

    const auditsSnap = await db
      .collection("audits")
      .where("type", "==", "suspension_change")
      .where("targetAddress", "==", user2Address)
      .get();
    assert.ok(auditsSnap.docs.length >= 1);
    const audit = auditsSnap.docs[0].data();
    assert.equal(audit.newState, true);
    assert.equal(audit.action, "USER_SUSPENDED");
  });

  it("[BIT-AAR-013] reinstates a user and writes an audit entry", async () => {
    const res = await call(
      "adminSetSuspended",
      {
        targetAddress: user2Address,
        suspended: false,
        reason: "Reinstating Bob after demo conclusion",
      },
      { token: adminToken },
    );
    assert.equal(res.result?.success, true);
    assert.equal(res.result?.suspended, false);

    const userDoc = await db.collection("users").doc(user2Address).get();
    assert.equal(userDoc.data()?.suspended, false);
  });

  it("[BIT-AAR-014] rejects a non-admin caller attempting to suspend", async () => {
    const freshUser1Token = await getIdTokenForAccount(user1Account);
    const res = await call(
      "adminSetSuspended",
      {
        targetAddress: user2Address,
        suspended: true,
        reason: "Malicious suspension",
      },
      { token: freshUser1Token },
    );
    assert.equal(res.error?.status, "PERMISSION_DENIED");
  });

  it("[BIT-AAR-015] rejects login / signature verification if user account is suspended", async () => {
    // 1. Suspend user2
    await db.collection("users").doc(user2Address).update({ suspended: true });

    // 2. Attempt SIWE login for user2
    const { result: nonceRes } = await call("getSiweNonce", { address: user2Address });
    const signature = await user2Account.signMessage({ message: nonceRes.message });
    const verifyRes = await call("verifySiweSignature", { address: user2Address, signature });

    assert.equal(verifyRes.error?.status, "PERMISSION_DENIED");
    assert.ok(verifyRes.error?.message?.includes("suspended"));

    // Cleanup: reinstate user2
    await db.collection("users").doc(user2Address).update({ suspended: false });
  });

  it("[BIT-AAR-016] rejects admin operations if the calling admin is suspended", async () => {
    // 1. Create a second admin and suspend them
    const admin2Key = generatePrivateKey();
    const admin2Account = privateKeyToAccount(admin2Key);
    const admin2Address = admin2Account.address.toLowerCase();

    await db.collection("users").doc(admin2Address).set({
      address: admin2Address,
      fullName: "Suspended Admin",
      organisation: "SMU",
      role: 1,
      suspended: true,
      chainId: 421614,
      walletVerified: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    // Generate token by bypassing suspension in test setup or temporarily unsuspending to mint
    await db.collection("users").doc(admin2Address).update({ suspended: false });
    const admin2Token = await getIdTokenForAccount(admin2Account);
    await db.collection("users").doc(admin2Address).update({ suspended: true });

    // 2. Call admin functions with suspended admin token
    const listRes = await call("adminListUsers", {}, { token: admin2Token });
    assert.equal(listRes.error?.status, "PERMISSION_DENIED");
    assert.ok(listRes.error?.message?.includes("suspended"));

    const roleRes = await call(
      "adminChangeRole",
      { targetAddress: user1Address, newRole: 1, reason: "Attempt from suspended admin" },
      { token: admin2Token },
    );
    assert.equal(roleRes.error?.status, "PERMISSION_DENIED");

    const suspendRes = await call(
      "adminSetSuspended",
      { targetAddress: user1Address, suspended: true, reason: "Attempt from suspended admin" },
      { token: admin2Token },
    );
    assert.equal(suspendRes.error?.status, "PERMISSION_DENIED");
  });
});
