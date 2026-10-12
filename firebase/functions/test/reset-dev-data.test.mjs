import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import {
  describeReset,
  executeReset,
  formatPlan,
  parseArgs,
  resolveTarget,
} from "../scripts/reset-dev-data.mjs";

const LIVE = "qcdao-a0c7a";
// Opt-in so a normal functions run cannot wipe a shared emulator.
const emulatorReady = process.env.RESET_EMULATOR_TEST === "1" && Boolean(
  process.env.FIRESTORE_EMULATOR_HOST
  && process.env.FIREBASE_AUTH_EMULATOR_HOST
  && process.env.FIREBASE_STORAGE_EMULATOR_HOST,
);

describe("reset target guards", () => {
  it("parses a dry run and a confirmed delete", () => {
    assert.deepEqual(parseArgs([]), { target: "emulator", confirm: null, project: null, help: false });
    assert.equal(parseArgs(["--target", "production", "--project", LIVE, "--confirm", LIVE]).confirm, LIVE);
    assert.throws(() => parseArgs(["--target", "staging"]), /emulator or production/);
    assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
  });

  it("refuses to delete unless --confirm is the project id", () => {
    const env = {
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199",
    };
    assert.equal(resolveTarget({ env, args: parseArgs(["--project", LIVE]) }).execute, false);
    assert.throws(
      () => resolveTarget({ env, args: parseArgs(["--project", LIVE, "--confirm", "other-project"]) }),
      /must be the project id/,
    );
    assert.equal(resolveTarget({ env, args: parseArgs(["--project", LIVE, "--confirm", LIVE]) }).execute, true);
  });

  it("refuses a live wipe without an explicit production target, and refuses any other project", () => {
    assert.throws(() => resolveTarget({ env: {}, args: parseArgs(["--confirm", LIVE]) }), /live project/);
    assert.throws(
      () => resolveTarget({
        env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
        args: parseArgs(["--target", "production", "--project", LIVE, "--confirm", LIVE]),
      }),
      /emulator host/,
    );
    assert.throws(
      () => resolveTarget({ env: {}, args: parseArgs(["--target", "production", "--project", "other", "--confirm", "other"]) }),
      /only live project/,
    );
    const live = resolveTarget({ env: {}, args: parseArgs(["--target", "production", "--project", LIVE]) });
    assert.equal(live.execute, false);
    assert.equal(live.emulator, false);
    assert.match(formatPlan({
      collections: [{ id: "users", count: 2 }], firestoreDocuments: 2, storageFiles: 1, authUsers: 2,
    }, live), /Dry run/);
    assert.doesNotMatch(formatPlan({
      collections: [], firestoreDocuments: 0, storageFiles: 0, authUsers: 0,
    }, { ...live, execute: true }), /Nothing was deleted/);
  });

  it("refuses a partial emulator wipe", () => {
    assert.throws(
      () => resolveTarget({
        env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
        args: parseArgs(["--project", LIVE, "--confirm", LIVE]),
      }),
      /partial wipe/,
    );
  });
});

describe("emulator wipe", { skip: !emulatorReady }, () => {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || LIVE;
  let app;

  after(async () => {
    if (app) await deleteApp(app);
  });

  it("dry run leaves emulator data, and confirm removes Firestore, Storage and Auth", async () => {
    app = initializeApp({
      projectId,
      storageBucket: `${projectId}.firebasestorage.app`,
    }, "reset-dev-data-test");
    const db = getFirestore(app);
    const auth = getAuth(app);
    const bucket = getStorage(app).bucket();
    const uid = `0x${"a".repeat(40)}`;

    await db.collection("users").doc(uid).set({ email: "wipe@example.com", address: uid });
    await db.collection("problems").doc("posting").set({ title: "wipe me" });
    await db.collection("problems").doc("posting").collection("revisions").doc("rev").set({ n: 1 });
    await db.collection("emailAccounts").doc("wipe@example.com").set({ address: uid });
    await bucket.file(`problems/${uid}/posting/file.pdf`).save(Buffer.from("%PDF"), {
      resumable: false,
      contentType: "application/pdf",
    });
    await auth.createUser({ uid, email: "wipe@example.com", emailVerified: true });

    assert.equal((await db.collection("users").doc(uid).get()).exists, true);
    const before = await describeReset({ db, auth, bucket });
    assert.ok(before.firestoreDocuments >= 3, JSON.stringify(before));
    assert.ok(before.collections.some((row) => row.id === "problems" && row.count >= 1), JSON.stringify(before));
    assert.ok(before.collections.some((row) => row.id === "users" && row.count >= 1));
    assert.ok(before.storageFiles >= 1);
    assert.ok(before.authUsers >= 1);
    assert.equal((await db.collection("problems").doc("posting").collection("revisions").doc("rev").get()).exists, true);

    const target = resolveTarget({
      args: parseArgs(["--project", projectId, "--confirm", projectId]),
    });
    assert.equal(target.execute, true);
    assert.equal(target.emulator, true);
    await executeReset({ db, auth, bucket });

    const after = await describeReset({ db, auth, bucket });
    assert.equal(after.firestoreDocuments, 0);
    assert.equal(after.collections.length, 0);
    assert.equal(after.storageFiles, 0);
    assert.equal(after.authUsers, 0);
    assert.equal((await db.collection("problems").doc("posting").collection("revisions").doc("rev").get()).exists, false);
  });
});
