import assert from "node:assert/strict";
import { it } from "node:test";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { sweepAttachments } from "../index.js";
import { memoryDb } from "./memoryDb.mjs";

it("scheduled sweep deletes only with explicit true opt-in", async (t) => {
  const previous = process.env.ATTACHMENT_SWEEP_ENABLED;
  const path = `problems/0x${"a".repeat(40)}/abandoned/attachment01.pdf`;
  try {
    for (const enabled of [undefined, "", "false", "FALSE", "1", "TRUE", " true ", "true"]) {
      if (enabled === undefined) delete process.env.ATTACHMENT_SWEEP_ENABLED;
      else process.env.ATTACHMENT_SWEEP_ENABLED = enabled;
      const db = memoryDb(), deleted = [];
      const file = { name: path, metadata: { timeCreated: "2020-01-01T00:00:00Z" },
        delete: async () => { deleted.push(path); } };
      const bucket = {
        getFiles: async ({ prefix }) => [path.startsWith(prefix) ? [file] : []],
        file: () => ({ exists: async () => [!deleted.includes(path)] }),
      };
      t.mock.method(getFirestore(), "collection", db.collection.bind(db));
      t.mock.method(getFirestore(), "runTransaction", db.runTransaction.bind(db));
      t.mock.method(getStorage(), "bucket", () => bucket);
      await sweepAttachments.run({});
      assert.deepEqual(deleted, enabled === "true" ? [path] : [], `flag ${String(enabled)}`);
      if (enabled !== "true") assert.equal(db.records.size, 0, "dry run must not write retention state");
      t.mock.restoreAll();
    }
  } finally {
    if (previous === undefined) delete process.env.ATTACHMENT_SWEEP_ENABLED;
    else process.env.ATTACHMENT_SWEEP_ENABLED = previous;
  }
});
