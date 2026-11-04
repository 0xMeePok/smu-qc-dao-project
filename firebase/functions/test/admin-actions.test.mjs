import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpsError } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { revokeOwnSessions } from "../index.js";
import { memoryDb } from "./memoryDb.mjs";
import {
  applyRoleChangeTransaction,
  applySuspensionChangeTransaction,
  finalizeSuspensionRevocation,
  isAuthTimeRevoked,
} from "../adminActions.js";

function memoryStore(entries = []) {
  const store = new Map(entries);
  return {
    store,
    ref(path) {
      return { path };
    },
    snapshot(path) {
      return {
        exists: store.has(path),
        data: () => (store.has(path) ? { ...store.get(path) } : undefined),
      };
    },
  };
}

describe("QCDAO-128 admin audit atomicity", () => {
  it("does not keep a role change when the audit write fails", async () => {
    const db = memoryStore([
      ["users/0xabc", { role: 0, fullName: "Alice" }],
    ]);
    const targetRef = db.ref("users/0xabc");
    const auditRef = db.ref("audits/a1");
    const attempted = [];
    const tx = {
      get: async (ref) => db.snapshot(ref.path),
      update: (ref) => {
        attempted.push(["update", ref.path]);
      },
      set: (ref) => {
        attempted.push(["set", ref.path]);
        if (ref.path.startsWith("audits/")) throw new Error("injected audit failure");
      },
    };

    await assert.rejects(
      () => applyRoleChangeTransaction(tx, {
        targetRef,
        auditRef,
        actorUid: "0xadmin",
        adminUser: { fullName: "Admin" },
        targetAddress: "0xabc",
        newRole: 1,
        reason: "Failure injection for audit consistency",
        timestamp: { seconds: 1 },
      }),
      /injected audit failure/,
    );

    assert.deepEqual(attempted, [["update", "users/0xabc"], ["set", "audits/a1"]]);
    assert.equal(db.store.get("users/0xabc").role, 0);
    assert.equal(db.store.has("audits/a1"), false);
  });

  it("[BUT-OPD-187] writes the evaluator role and the audit together", async () => {
    const db = memoryStore([
      ["users/0xabc", { role: 0, fullName: "Alice" }],
    ]);
    const targetRef = db.ref("users/0xabc");
    const auditRef = db.ref("audits/a1");
    const timestamp = { seconds: 1 };
    const tx = {
      get: async (ref) => db.snapshot(ref.path),
      update: (ref, data) => {
        db.store.set(ref.path, { ...db.store.get(ref.path), ...data });
      },
      set: (ref, data) => {
        db.store.set(ref.path, data);
      },
    };

    const previousRole = await applyRoleChangeTransaction(tx, {
      targetRef,
      auditRef,
      actorUid: "0xadmin",
      adminUser: { fullName: "Admin" },
      targetAddress: "0xabc",
      newRole: 2,
      reason: "Assigning evaluator for the review queue",
      timestamp,
    });

    assert.equal(previousRole, 0);
    assert.equal(db.store.get("users/0xabc").role, 2);
    assert.equal(db.store.get("users/0xabc").updatedAt, timestamp);
    const audit = db.store.get("audits/a1");
    assert.equal(audit.type, "role_change");
    assert.equal(audit.action, "ROLE_CHANGE");
    assert.equal(audit.actor, "0xadmin");
    assert.equal(audit.actorName, "Admin");
    assert.equal(audit.targetAddress, "0xabc");
    assert.equal(audit.targetName, "Alice");
    assert.equal(audit.previousRole, 0);
    assert.equal(audit.newRole, 2);
    assert.equal(audit.reason, "Assigning evaluator for the review queue");
    assert.equal(audit.timestamp, timestamp);
  });
});

describe("QCDAO-129 credential revocation failures", () => {
  it("marks revocation failed and throws instead of returning success", async () => {
    const store = new Map([
      ["users/0xabc", { suspended: true, tokenRevocationStatus: "pending" }],
      ["audits/a1", { revocationStatus: "pending" }],
    ]);
    const targetRef = { path: "users/0xabc" };
    const auditRef = { path: "audits/a1" };
    const db = {
      batch() {
        const ops = [];
        return {
          update(ref, data) {
            ops.push(() => Object.assign(store.get(ref.path), data));
          },
          async commit() {
            ops.forEach((apply) => apply());
          },
        };
      },
    };
    const error = new Error("auth backend unavailable");
    error.code = "auth/internal-error";

    await assert.rejects(
      () => finalizeSuspensionRevocation({
        db,
        Timestamp: { now: () => ({ seconds: 2 }) },
        targetRef,
        auditRef,
        targetAddress: "0xabc",
        revokeRefreshTokens: async () => {
          throw error;
        },
      }),
      (caught) => caught instanceof HttpsError && caught.code === "unavailable",
    );

    assert.equal(store.get("users/0xabc").tokenRevocationStatus, "failed");
    assert.equal(store.get("users/0xabc").suspended, true);
    assert.equal(store.get("audits/a1").revocationStatus, "failed");
  });
});

describe("QCDAO-129 auth_time cutoff", () => {
  it("treats an ID token issued in the same second as revoked", () => {
    assert.equal(isAuthTimeRevoked(101, 101), true);
    assert.equal(isAuthTimeRevoked(101, null, 101), true);
  });

  it("treats an ID token older than the cutoff as revoked", () => {
    assert.equal(isAuthTimeRevoked(100, 101), true);
  });

  it("treats an ID token newer than the cutoff as valid", () => {
    assert.equal(isAuthTimeRevoked(102, 101), false);
  });

  it("does not revoke when no cutoff has been written", () => {
    assert.equal(isAuthTimeRevoked(101, undefined, null), false);
  });
});

describe("revokeOwnSessions replay protection", () => {
  const uid = `0x${"a".repeat(40)}`;
  const userPath = `users/${uid}`;
  const cutoffPath = `sessionRevocations/${uid}`;
  const request = (authTime) => ({ auth: { uid, token: { auth_time: authTime } } });
  const audits = (db) => [...db.records].filter(([path]) => path.startsWith("audits/"));

  function mockServices(t, initial, revoke = async () => {}) {
    const db = memoryDb(initial);
    t.mock.method(getFirestore(), "collection", db.collection.bind(db));
    t.mock.method(getFirestore(), "runTransaction", db.runTransaction.bind(db));
    const auth = t.mock.method(getAuth(), "revokeRefreshTokens", revoke);
    t.mock.method(Date, "now", () => 200_000);
    return { db, auth };
  }

  for (const source of ["profile", "marker"]) {
    for (const authTime of [100, 101]) {
      it(`leaves a newer session intact when a ${source}-revoked token has auth_time ${authTime}`, async (t) => {
        const initial = { [userPath]: { fullName: "Member" } };
        if (source === "profile") initial[userPath].sessionsValidAfterEpoch = 101;
        else initial[cutoffPath] = { sessionsValidAfterEpoch: 101 };
        const { db, auth } = mockServices(t, initial);
        const before = [...db.records];

        assert.deepEqual(await revokeOwnSessions.run(request(authTime)), {
          success: true, scope: "all-devices", revokedAfterEpoch: 101,
        });
        assert.deepEqual([...db.records], before, "replay must not write cutoffs, profile timestamps, or audits");
        assert.equal(auth.mock.callCount(), 0, "replay must not revoke newer Firebase refresh tokens");
        assert.equal(isAuthTimeRevoked(102, db.records.get(userPath)?.sessionsValidAfterEpoch,
          db.records.get(cutoffPath)?.sessionsValidAfterEpoch), false);
      });
    }
  }

  it("uses the higher cutoff when only the profile revokes the token", async (t) => {
    const { db, auth } = mockServices(t, {
      [userPath]: { sessionsValidAfterEpoch: 103 }, [cutoffPath]: { sessionsValidAfterEpoch: 101 },
    });
    const before = [...db.records];
    assert.equal((await revokeOwnSessions.run(request(102))).revokedAfterEpoch, 103);
    assert.deepEqual([...db.records], before);
    assert.equal(auth.mock.callCount(), 0);
  });

  it("lets a newer authenticated session revoke all sessions exactly once", async (t) => {
    const { db, auth } = mockServices(t, {
      [userPath]: { fullName: "Member", sessionsValidAfterEpoch: 100 },
      [cutoffPath]: { sessionsValidAfterEpoch: 101 },
    });
    assert.deepEqual(await revokeOwnSessions.run(request(102)), {
      success: true, scope: "all-devices", revokedAfterEpoch: 200,
    });
    assert.equal(db.records.get(userPath).sessionsValidAfterEpoch, 200);
    assert.equal(db.records.get(userPath).fullName, "Member");
    assert.equal(db.records.get(cutoffPath).sessionsValidAfterEpoch, 200);
    assert.equal(audits(db).length, 1);
    assert.equal(audits(db)[0][1].action, "SESSIONS_REVOKED_BY_USER");
    assert.equal(auth.mock.callCount(), 1);
    assert.deepEqual(auth.mock.calls[0].arguments, [uid]);

    const beforeReplay = [...db.records];
    Date.now.mock.mockImplementation(() => 300_000);
    assert.equal((await revokeOwnSessions.run(request(102))).revokedAfterEpoch, 200);
    assert.deepEqual([...db.records], beforeReplay);
    assert.equal(auth.mock.callCount(), 1);
    assert.equal(isAuthTimeRevoked(201, db.records.get(cutoffPath).sessionsValidAfterEpoch), false);
  });

  it("supports first logout and harmless replay before a profile exists", async (t) => {
    const { db, auth } = mockServices(t, {});
    assert.equal((await revokeOwnSessions.run(request(100))).revokedAfterEpoch, 200);
    assert.equal(db.records.has(userPath), false);
    assert.equal(db.records.get(cutoffPath).sessionsValidAfterEpoch, 200);
    assert.equal(audits(db).length, 1);
    assert.equal(auth.mock.callCount(), 1);
    const beforeReplay = [...db.records];
    Date.now.mock.mockImplementation(() => 300_000);
    assert.equal((await revokeOwnSessions.run(request(100))).revokedAfterEpoch, 200);
    assert.deepEqual([...db.records], beforeReplay);
    assert.equal(auth.mock.callCount(), 1);
  });

  it("does not repeat Auth revocation when concurrent requests share one token", async (t) => {
    const { db, auth } = mockServices(t, { [userPath]: { fullName: "Member" } });
    const results = await Promise.all([revokeOwnSessions.run(request(100)), revokeOwnSessions.run(request(100))]);
    assert.equal(results.every((result) => result.success && result.revokedAfterEpoch === 200), true);
    assert.equal(audits(db).length, 1);
    assert.equal(auth.mock.callCount(), 1);
  });

  it("allows local logout retry after Auth fails without revoking a later session", async (t) => {
    const { db, auth } = mockServices(t, { [userPath]: { fullName: "Member" } }, async () => {
      throw new Error("Auth unavailable");
    });
    await assert.rejects(revokeOwnSessions.run(request(100)), { code: "unavailable" });
    const beforeRetry = [...db.records];
    Date.now.mock.mockImplementation(() => 300_000);
    assert.deepEqual(await revokeOwnSessions.run(request(100)), {
      success: true, scope: "all-devices", revokedAfterEpoch: 200,
    });
    assert.deepEqual([...db.records], beforeRetry);
    assert.equal(auth.mock.callCount(), 1);
    assert.equal(isAuthTimeRevoked(201, db.records.get(cutoffPath).sessionsValidAfterEpoch), false);
  });
});

describe("suspension session cutoff monotonicity", () => {
  const uid = `0x${"b".repeat(40)}`;
  const userPath = `users/${uid}`;
  const cutoffPath = `sessionRevocations/${uid}`;
  const auditPath = "audits/suspension";
  const options = (db, overrides = {}) => ({
    targetRef: db.collection("users").doc(uid),
    revocationRef: db.collection("sessionRevocations").doc(uid),
    auditRef: db.collection("audits").doc("suspension"),
    actorUid: "administrator", adminUser: { fullName: "Administrator" },
    targetAddress: uid, suspended: true, reason: "Suspend compromised account",
    timestamp: { seconds: 100 }, revokedAfterEpoch: 100, ...overrides,
  });

  for (const [name, profileCutoff, markerCutoff, expected] of [
    ["profile cutoff", 103, 101, 103],
    ["marker cutoff", 101, 103, 103],
    ["incoming cutoff", 98, 99, 100],
    ["first cutoff", undefined, undefined, 100],
  ]) {
    it(`preserves the highest ${name} in both stores`, async () => {
      const initial = { [userPath]: { suspended: false } };
      if (profileCutoff !== undefined) initial[userPath].sessionsValidAfterEpoch = profileCutoff;
      if (markerCutoff !== undefined) initial[cutoffPath] = { sessionsValidAfterEpoch: markerCutoff };
      const db = memoryDb(initial);
      await db.runTransaction((tx) => applySuspensionChangeTransaction(tx, options(db)));

      assert.equal(db.records.get(userPath).suspended, true);
      assert.equal(db.records.get(userPath).sessionsValidAfterEpoch, expected);
      assert.equal(db.records.get(cutoffPath).sessionsValidAfterEpoch, expected);
      assert.equal(db.records.get(auditPath).action, "USER_SUSPENDED");
      assert.equal(isAuthTimeRevoked(expected, expected), true, "same-second tokens remain revoked");
      assert.equal(isAuthTimeRevoked(expected + 1, expected), false);
      assert.equal(db.reads, 2);
    });
  }

  it("keeps logout's newer cutoff when a suspension timestamp precedes its delayed first read", async () => {
    const db = memoryDb({ [userPath]: { suspended: false } });
    let releaseRead;
    let signalRead;
    const startedRead = new Promise((resolve) => { signalRead = resolve; });
    const readGate = new Promise((resolve) => { releaseRead = resolve; });
    const suspension = db.runTransaction((tx) => applySuspensionChangeTransaction({
      ...tx,
      get: async (ref) => {
        if (ref.path === userPath) {
          signalRead();
          await readGate;
        }
        return tx.get(ref);
      },
    }, options(db)));

    await startedRead;
    // A logout commits after the admin captures epoch 100 but before its first
    // server read. The suspension must retain the cutoff it actually reads.
    db.records.set(userPath, { suspended: false, sessionsValidAfterEpoch: 102 });
    db.records.set(cutoffPath, { sessionsValidAfterEpoch: 102 });
    releaseRead();
    await suspension;
    await db.runTransaction((tx) => applySuspensionChangeTransaction(tx, options(db, {
      suspended: false, reason: "Reinstate recovered account", revokedAfterEpoch: 103,
    })));

    assert.equal(db.records.get(userPath).suspended, false);
    assert.equal(db.records.get(userPath).sessionsValidAfterEpoch, 102);
    assert.equal(db.records.get(cutoffPath).sessionsValidAfterEpoch, 102);
    assert.equal(isAuthTimeRevoked(101, db.records.get(userPath).sessionsValidAfterEpoch,
      db.records.get(cutoffPath).sessionsValidAfterEpoch), true, "reinstatement must not revive the logged-out token");
  });

  it("does not read or change the revocation marker when reinstating an account", async () => {
    const db = memoryDb({
      [userPath]: { suspended: true, sessionsValidAfterEpoch: 103 },
      [cutoffPath]: { sessionsValidAfterEpoch: 104 },
    });
    const markerBefore = db.records.get(cutoffPath);
    await db.runTransaction((tx) => applySuspensionChangeTransaction(tx, options(db, { suspended: false })));

    assert.equal(db.reads, 1, "reinstatement needs only the target profile read");
    assert.equal(db.records.get(userPath).suspended, false);
    assert.equal(db.records.get(userPath).sessionsValidAfterEpoch, 103);
    assert.equal(db.records.get(cutoffPath), markerBefore);
    assert.equal(db.records.get(auditPath).action, "USER_REINSTATED");
  });
});
