import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpsError } from "firebase-functions/v2/https";
import {
  applyRoleChangeTransaction,
  finalizeSuspensionRevocation,
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
