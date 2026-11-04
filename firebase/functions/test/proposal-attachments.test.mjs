import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { HttpsError } from "firebase-functions/v2/https";
import { memoryDb } from "./memoryDb.mjs";
import { authorizeProposalAttachment, createProposalAttachmentHandler, MAX_PROPOSAL_PDF_BYTES } from "../proposalAttachments.js";
import { moderatedProblemId } from "../moderationFunctions.js";

const AUTHOR = `0x${"a".repeat(40)}`, SPONSOR = `0x${"b".repeat(40)}`;
const MEMBER = `0x${"c".repeat(40)}`, ADMIN = `0x${"d".repeat(40)}`;
const PDF = Buffer.from("%PDF-1.7\nminimal PDF");
function fixture() {
  return memoryDb({
    [`users/${AUTHOR}`]: { role: 0 }, [`users/${SPONSOR}`]: { role: 0 },
    [`users/${MEMBER}`]: { role: 0 }, [`users/${ADMIN}`]: { role: 1 },
    "problems/parent": { ownerId: SPONSOR, status: "submitted" },
    "proposals/child": { researcherId: AUTHOR, postingOwnerId: SPONSOR, problemId: "parent",
      status: "submitted", problemBrowsable: true },
  });
}
const authorize = (db, uid = MEMBER) => authorizeProposalAttachment({ db, uid, authTime: 100, proposalId: "child" });

test("live parent revokes stale child PDFs before any visibility fanout", async () => {
  const db = fixture();
  assert.equal(await authorize(db), AUTHOR);
  db.records.set("problems/parent", { ownerId: SPONSOR, status: "moderated_removed", moderationStatus: "removed" });
  assert.equal(db.records.get("proposals/child").problemBrowsable, true);
  await assert.rejects(authorize(db), { code: "permission-denied" });
  for (const uid of [AUTHOR, ADMIN, SPONSOR]) assert.equal(await authorize(db, uid), AUTHOR);
});

test("all allowed parent/child states remain readable; unsupported, missing or moderated parents fail closed", async () => {
  const db = fixture(), parent = db.records.get("problems/parent"), child = db.records.get("proposals/child");
  for (const status of ["submitted", "under_review", "accepted", "rejected", "withdrawn"]) {
    child.status = status;
    for (const state of ["submitted", "open", "cancelled", "expired"]) {
      parent.status = state; assert.equal(await authorize(db), AUTHOR);
    }
  }
  for (const status of ["draft", "moderated_removed", "unknown"]) {
    parent.status = status; await assert.rejects(authorize(db), { code: "permission-denied" });
  }
  parent.status = "submitted"; parent.moderationStatus = "hidden";
  await assert.rejects(authorize(db), { code: "permission-denied" });
  db.records.delete("problems/parent");
  await assert.rejects(authorize(db), { code: "permission-denied" });
});

test("draft privacy and child moderation remain immediate for sponsors and other members", async () => {
  const db = fixture(), child = db.records.get("proposals/child");
  for (const update of [{ status: "draft" }, { status: "submitted", moderationStatus: "hidden" },
    { status: "moderated_removed", moderationStatus: "removed" }]) {
    Object.assign(child, update);
    for (const uid of [SPONSOR, MEMBER]) await assert.rejects(authorize(db, uid), { code: "permission-denied" });
    for (const uid of [AUTHOR, ADMIN]) assert.equal(await authorize(db, uid), AUTHOR);
  }
});

test("independent published proposals need no parent or cached problemBrowsable", async () => {
  const db = fixture(), child = db.records.get("proposals/child");
  child.proposalKind = "independent"; delete child.problemId; delete child.problemBrowsable;
  assert.equal(await authorize(db), AUTHOR);
  child.status = "draft";
  await assert.rejects(authorize(db), { code: "permission-denied" });
});

test("missing/suspended profiles and either inclusive cutoff deny even authors and administrators", async () => {
  for (const uid of [AUTHOR, ADMIN, MEMBER]) {
    for (const update of [{ suspended: true }, { sessionsValidAfterEpoch: 100 }]) {
      const db = fixture(); Object.assign(db.records.get(`users/${uid}`), update);
      await assert.rejects(authorize(db, uid), { code: "permission-denied" });
    }
    const db = fixture(); db.records.set(`sessionRevocations/${uid}`, { sessionsValidAfterEpoch: 100 });
    await assert.rejects(authorize(db, uid), { code: "permission-denied" });
    db.records.delete(`sessionRevocations/${uid}`); db.records.delete(`users/${uid}`);
    await assert.rejects(authorize(db, uid), { code: "permission-denied" });
  }
});

class Response extends Writable {
  constructor() { super(); this.headers = {}; this.statusCode = 200; this.chunks = []; this.headersSent = false; }
  _write(chunk, _encoding, callback) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); callback(); }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  removeHeader(name) { delete this.headers[name.toLowerCase()]; }
  status(code) { this.statusCode = code; return this; }
  json(data) { this.setHeader("Content-Type", "application/json"); this.end(JSON.stringify(data)); return this; }
  get body() { return Buffer.concat(this.chunks); }
}
function transport({ bytes = PDF, metadata = {}, emulator = false, ...overrides } = {}) {
  const db = fixture(), calls = { streams: [], members: [], app: [], auth: [] };
  const bucket = { file(path, options) {
    return { getMetadata: async () => [{ size: String(bytes.length), contentType: "application/pdf", generation: "7",
      metadata: { firebaseStorageDownloadTokens: "secret" }, ...metadata }],
    createReadStream() { calls.streams.push({ path, options }); return Readable.from([bytes]); } };
  } };
  const handler = createProposalAttachmentHandler({ db, getBucket: () => bucket, emulator,
    allowedOrigins: ["https://example.test"],
    verifyIdToken: async (token) => { calls.auth.push(token); return { uid: MEMBER, auth_time: 100 }; },
    verifyAppCheckToken: async (token) => { calls.app.push(token); },
    requireMember: async (request) => { calls.members.push(request); return request.auth.uid; }, ...overrides });
  const request = (patch = {}) => ({ method: "GET", query: { proposalId: "child", attachmentId: "support01" },
    headers: { authorization: "Bearer identity", "x-firebase-appcheck": "attestation", origin: "https://example.test" }, ...patch });
  return { db, calls, handler, request, bucket };
}
async function invoke(f, patch) { const res = new Response(); await f.handler(f.request(patch), res); return res; }

test("one raw response pins generation, supplies credentials to shared auth and omits permanent tokens", async () => {
  const f = transport(), res = await invoke(f);
  assert.deepEqual(res.body, PDF);
  assert.equal(res.headers["content-type"], "application/pdf");
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.equal(res.headers["content-length"], String(PDF.length));
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.chunks.length, 1);
  assert.equal(JSON.stringify(res.headers).includes("secret"), false);
  assert.deepEqual(f.calls.streams, [{ path: `proposals/${AUTHOR}/child/support01.pdf`, options: { generation: "7" } }]);
  assert.deepEqual(f.calls.members[0], { auth: { uid: MEMBER, token: { uid: MEMBER, auth_time: 100 } } });
  assert.deepEqual(f.calls.auth, ["identity"]); assert.deepEqual(f.calls.app, ["attestation"]);
});

test("10 MiB stays raw binary; oversized metadata never opens an object stream", async () => {
  const bytes = Buffer.alloc(MAX_PROPOSAL_PDF_BYTES, 0x25), f = transport({ bytes });
  const complete = await invoke(f);
  assert.deepEqual(complete.body, bytes);
  assert.equal(complete.chunks.length, 1);
  for (const metadata of [{ size: String(MAX_PROPOSAL_PDF_BYTES + 1) }, { size: "0" }, { contentType: "text/html" }]) {
    const bad = transport({ metadata }), res = await invoke(bad);
    assert.equal(res.statusCode, 409); assert.equal(bad.calls.streams.length, 0);
  }
  for (const size of ["1", String(PDF.length + 1)]) {
    const mismatch = transport({ metadata: { size } });
    const failed = await invoke(mismatch);
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(JSON.parse(failed.body), { error: "The PDF download failed. Please try again." });
  }
});

test("ID token, App Check, shared session gate and live parent are all enforced before opening bytes", async () => {
  for (const options of [
    { verifyIdToken: async () => { throw new Error("invalid"); } },
    { verifyAppCheckToken: async () => { throw new Error("invalid"); } },
    { requireMember: async () => { throw new HttpsError("unauthenticated", "Revoked session"); } },
  ]) {
    const f = transport(options), res = await invoke(f);
    assert.ok([401, 403].includes(res.statusCode)); assert.equal(f.calls.streams.length, 0);
  }
  for (const headers of [{}, { authorization: "Bearer identity" }]) {
    const f = transport(), res = await invoke(f, { headers });
    assert.ok([401, 403].includes(res.statusCode)); assert.equal(f.calls.streams.length, 0);
  }
  const f = transport(); f.db.records.get("problems/parent").moderationStatus = "removed";
  assert.equal((await invoke(f)).statusCode, 403); assert.equal(f.calls.streams.length, 0);
});

test("preflight, CORS, methods, emulator-only attestation bypass and path validation", async () => {
  const f = transport();
  assert.equal((await invoke(f, { method: "OPTIONS", headers: { origin: "https://example.test" } })).statusCode, 204);
  assert.equal((await invoke(f, { method: "POST" })).statusCode, 405);
  assert.equal((await invoke(f, { headers: { origin: "https://attacker.test" } })).statusCode, 403);
  assert.equal((await invoke(f, { headers: { origin: "http://localhost:5173" } })).statusCode, 403);
  for (const query of [{ proposalId: "../parent", attachmentId: "support01" },
    { proposalId: ["child", "parent"], attachmentId: "support01" },
    { proposalId: "child", attachmentId: "../../secret" },
    { proposalId: "child", attachmentId: "support01", path: "other/secret" },
    { proposalId: "child", attachmentId: "support01", ownerId: MEMBER }]) {
    assert.equal((await invoke(f, { query })).statusCode, 400);
  }
  const local = transport({ emulator: true });
  assert.deepEqual((await invoke(local, { headers: { authorization: "Bearer identity", origin: "http://localhost:5173" } })).body, PDF);
  assert.equal(local.calls.app.length, 0);
});

test("missing object errors stay sanitized and never emit Storage metadata", async () => {
  const f = transport({ getBucket: () => ({ file() { return { getMetadata: async () => { throw { code: 404, message: "secret-path" }; } }; } }) });
  const res = await invoke(f); assert.equal(res.statusCode, 404); assert.equal(res.body.includes("secret-path"), false);
});

test("midstream Storage errors send sanitized errors with no partial PDF body", async () => {
  let source;
  const f = transport({ getBucket: () => ({ file(_path, options) {
    return { getMetadata: async () => [{ size: "100", generation: "7", contentType: "application/pdf" }],
      createReadStream() {
        assert.deepEqual(options, { generation: "7" });
        source = Readable.from((async function* () {
          yield PDF;
          throw new Error("secret storage error");
        })());
        return source;
      } };
  } }) });
  const res = await invoke(f);
  assert.equal(source.destroyed, true); assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { error: "The PDF download failed. Please try again." });
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.headers["content-length"], undefined);
  assert.equal(res.body.includes("secret"), false);
  assert.equal(res.body.includes("%PDF"), false);
});

test("client disconnect cancels the upstream Storage stream", async () => {
  const source = new PassThrough();
  const f = transport({ getBucket: () => ({ file() {
    return { getMetadata: async () => [{ size: "100", generation: "7", contentType: "application/pdf" }],
      createReadStream: () => source };
  } }) });
  const res = new Response(), work = f.handler(f.request(), res);
  await new Promise((resolve) => setImmediate(resolve));
  source.write(PDF);
  assert.equal(res.headersSent, false);
  assert.equal(res.body.length, 0);
  res.destroy();
  await work;
  assert.equal(source.destroyed, true);
  assert.equal(res.body.length, 0);
});

test("moderation fanout identifies parent from the UI queueId contract", () => {
  assert.equal(moderatedProblemId("problem_parent_with_underscores"), "parent_with_underscores");
  for (const value of ["proposal_child", "problem_", "problem_../secret", undefined]) assert.equal(moderatedProblemId(value), null);
});
