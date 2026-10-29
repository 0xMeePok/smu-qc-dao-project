import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { proposalSearchTerms, retrieveSimilarProposals, retrieveAvailableSimilarProposals } from "../aiRetrieval.js";

const now = Timestamp.fromMillis(1_800_000_000_000);
const proposal = patch => ({ researcherId: "researcher", status: "submitted", title: "Cold chain route optimisation",
  summary: "Plan warehouse routes and reduce delivery emissions.", category: "hybrid", createdAt: now, problemId: "problem", ...patch });
function fixture() {
  return memoryDb({
    "users/viewer": { role: 0 }, "users/owner": { role: 0 }, "users/admin": { role: 1 },
    "problems/problem": { ownerId: "owner", status: "open", title: "Delivery routing" },
    "proposals/routes": proposal({}),
    "proposals/independent": proposal({ proposalKind: "independent", problemId: null, title: "Warehouse delivery route optimization", summary: "Schedule efficient cold chain routes." }),
    "proposals/unrelated": proposal({ title: "Secure cryptography for sensor networks", summary: "Encrypt device communications.", category: "quantum-adjacent" }),
  });
}
const retrieve = (db, patch = {}) => retrieveSimilarProposals({ db, uid: "viewer", title: "Cold chain routing optimization", ...patch });

test("retrieves related published attached and independent proposals with bounded safe snippets", async () => {
  const db = fixture();
  const result = await retrieve(db, { category: "hybrid" });
  assert.deepEqual(new Set(result.items.map(item => item.id)), new Set(["routes", "independent"]));
  assert.equal(result.truncated, true);
  for (const item of result.items) {
    assert.equal(item.route, `proposal/${item.id}`);
    assert.match(item.reason, /^Related terms:/);
    assert.ok(item.score > 0);
    assert.ok(item.summary.length <= 360);
    assert.deepEqual(Object.keys(item).sort(), ["id", "reason", "route", "score", "summary", "title"]);
  }
  assert.equal([...db.records.keys()].some(path => path.startsWith("ai")), false);
});

test("normalises UK/US spelling and common domain inflections without arbitrary semantic claims", () => {
  assert.deepEqual(proposalSearchTerms("routing optimization deliveries"), proposalSearchTerms("routes optimisation delivery"));
  assert.deepEqual(proposalSearchTerms("Predictive cybersecurity sensors"), ["predict", "security", "sensor"]);
  assert.deepEqual(proposalSearchTerms("a proposal for the quantum model"), []);
});

test("never returns draft or moderated proposals, including the viewer's own and administrator views", async () => {
  const db = fixture();
  for (const uid of ["viewer", "admin"]) {
    db.records.set("proposals/draft", proposal({ status: "draft", researcherId: uid, title: "Secret cold chain route draft" }));
    db.records.set("proposals/hidden", proposal({ moderationStatus: "hidden", researcherId: uid, title: "Hidden cold chain routes" }));
    db.records.set("proposals/removed", proposal({ status: "moderated_removed", researcherId: uid, title: "Removed cold chain routes" }));
    const result = await retrieve(db, { uid });
    assert.equal(result.items.some(item => ["draft", "hidden", "removed"].includes(item.id)), false);
    assert.equal(JSON.stringify(result).includes("Secret"), false);
  }
});

test("rejects hidden, removed, missing, and draft parents even with stale owner/browsable metadata", async () => {
  const db = fixture();
  for (const [id, parent] of [
    ["hidden", { status: "open", moderationStatus: "hidden" }],
    ["removed", { status: "moderated_removed", moderationStatus: "removed" }],
    ["draft", { status: "draft" }],
    ["missing", null],
  ]) {
    if (parent) db.records.set(`problems/${id}`, { ...parent, ownerId: "viewer" });
    db.records.set(`proposals/${id}`, proposal({ problemId: id, postingOwnerId: "viewer", problemBrowsable: true,
      title: `${id} private cold chain routes`, summary: "confidential overlap" }));
  }
  for (const uid of ["viewer", "admin"]) {
    const result = await retrieve(db, { uid });
    assert.deepEqual(new Set(result.items.map(item => item.id)), new Set(["routes", "independent"]));
    assert.equal(JSON.stringify(result).includes("confidential"), false);
  }
});

test("private documents cannot affect returned ranking, scores, or truncation information", async () => {
  const db = fixture();
  const before = await retrieve(db);
  for (let i = 0; i < 10; i++) db.records.set(`proposals/private-${i}`, proposal({ status: "draft", title: "Cold chain route optimisation", summary: "private matching content" }));
  assert.deepEqual(await retrieve(db), before);
});

test("old category and same-parent candidates join the recent window and results stay bounded", async () => {
  const db = fixture();
  db.records.clear();
  db.records.set("users/viewer", { role: 0 });
  db.records.set("problems/problem", { ownerId: "owner", status: "open" });
  for (let i = 0; i < 155; i++) db.records.set(`proposals/recent-${i}`, proposal({ title: "Unrelated encryption", summary: "Security benchmark", category: "quantum-adjacent", problemId: "other", createdAt: Timestamp.fromMillis(now.toMillis() + i) }));
  for (let i = 0; i < 6; i++) db.records.set(`proposals/old-${i}`, proposal({ createdAt: Timestamp.fromMillis(1_600_000_000_000 + i) }));
  const result = await retrieve(db, { category: "hybrid", problemId: "problem" });
  assert.equal(result.items.length, 4);
  assert.ok(result.items.every(item => item.id.startsWith("old-")));
  assert.equal(result.truncated, true);
});

test("excludes the current proposal and does not disclose unrelated or category-only matches", async () => {
  const db = fixture();
  const result = await retrieve(db, { excludeId: "routes" });
  assert.deepEqual(result.items.map(item => item.id), ["independent"]);
  assert.deepEqual((await retrieve(db, { title: "Protein molecule folding", category: "hybrid" })).items, []);
  assert.deepEqual(await retrieve(db, { title: "the proposal", summary: "" }), { items: [], truncated: false });
});

test("requires active membership and validates IDs, query lengths, and allowed categories", async () => {
  const db = fixture();
  await assert.rejects(retrieve(db, { uid: "" }), { code: "unauthenticated" });
  await assert.rejects(retrieve(db, { uid: "unknown" }), { code: "permission-denied" });
  db.records.set("users/viewer", { suspended: true });
  await assert.rejects(retrieve(db), { code: "permission-denied" });
  db.records.set("users/viewer", { role: 0 });
  for (const patch of [{ title: "a".repeat(161) }, { summary: "a".repeat(4001) }, { category: "invented" }, { problemId: "../../secret" }, { excludeId: "id/secret" }, { title: {} }]) {
    await assert.rejects(retrieve(db, patch), { code: "invalid-argument" });
  }
});

test("permission changes on later requests remove snippets instead of reusing a previous search cache", async () => {
  const db = fixture();
  assert.ok((await retrieve(db)).items.some(item => item.id === "routes"));
  db.records.set("problems/problem", { ownerId: "owner", status: "open", moderationStatus: "hidden" });
  assert.deepEqual((await retrieve(db)).items.map(item => item.id), ["independent"]);
});


test("shared similarity guard responds dynamically before any query when the operator disables search", async () => {
  const original = process.env.AI_SIMILARITY_ENABLED, db = fixture();
  try {
    process.env.AI_SIMILARITY_ENABLED = "true";
    const options = { db, uid: "viewer", title: "Cold chain route optimisation" };
    assert.ok((await retrieveAvailableSimilarProposals(options)).items.length);
    const reads = db.reads;
    process.env.AI_SIMILARITY_ENABLED = "false";
    await assert.rejects(retrieveAvailableSimilarProposals(options), { code: "unavailable" });
    assert.equal(db.reads, reads);
    process.env.AI_SIMILARITY_ENABLED = "true";
    assert.ok((await retrieveAvailableSimilarProposals(options)).items.length);
  } finally {
    if (original === undefined) delete process.env.AI_SIMILARITY_ENABLED;
    else process.env.AI_SIMILARITY_ENABLED = original;
  }
});
