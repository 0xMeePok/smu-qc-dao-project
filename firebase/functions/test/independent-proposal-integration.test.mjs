import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, numberToHex } from "viem";
import { attestPublication } from "../index.js";
import registry from "../auditRegistry.contract.json" with { type: "json" };
import { INDEPENDENT_PUBLISH_VALIDATION } from "../publicationValidation.js";
import { INDEPENDENT_PROPOSAL_KIND } from "../independentProposal.js";
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { createComment } from "../comments.js";
import {
  canReadContent,
  listModerationNotifications,
  listReportableComments,
  moderateContent,
  submitContentReport,
} from "../moderation.js";
import { listIndependentListings } from "../independentProposalCatalog.js";
import { listActionItems, listEvaluatorQueue, listMyProposals } from "../proposalQueues.js";
import { fundMockProposal, prepareModerationMatching } from "../matching.js";
import { enqueueModerationVoidJobs } from "../escrowModerationVoid.js";
import { recordOwnerReview } from "../ownerReviews.js";

/** Independent listing publish, correction, queues, moderation, and expiry across callables. */

const UID = `0x${"a".repeat(40)}`;
const MEMBER = `0x${"b".repeat(40)}`;
const HASH = `0x${"1".repeat(64)}`;
const BLOCK = `0x${"2".repeat(64)}`;
const FUTURE = new Date("2099-12-29T09:00:00.000Z");
const now = Timestamp.fromMillis(1_800_000_000_000);
const later = (ms) => Timestamp.fromMillis(now.toMillis() + ms);

function listingFields(overrides = {}) {
  return {
    researcherId: UID,
    proposalKind: INDEPENDENT_PROPOSAL_KIND,
    status: "submitted",
    title: "Hybrid annealer for last-mile routing",
    summary: "A quantum-adjacent routing approach for independent discovery.",
    methodology: "Hybrid annealing with a classical fallback path.",
    addressedProblems: "Last-mile logistics under demand spikes.",
    team: "Two researchers with prior escrow deliveries.",
    category: "quantum-adjacent",
    maturity: "pilot",
    amount: 990,
    currency: "USDT",
    expiresAt: later(90 * 864e5),
    attachments: [],
    createdAt: now,
    ...overrides,
  };
}

function attestInput(overrides = {}) {
  const { createdAt, updatedAt, id, ...rest } = listingFields({
    expiresAt: FUTURE.toISOString(),
    audit: { transactionHash: HASH },
    ...overrides,
  });
  return rest;
}

/**
 * memoryDb maps unknown operators (including `>`) to `<`. Catalog, comments,
 * queues and moderation all share this store so `>` and `==` coexist.
 */
function integrationDb(initial = {}) {
  const records = new Map(Object.entries(initial));
  let queue = Promise.resolve();
  const snapshot = (path) => {
    const value = records.get(path);
    return { id: path.split("/").at(-1), ref: reference(path), exists: records.has(path), data: () => value };
  };
  const reference = (path) => ({
    path, id: path.split("/").at(-1),
    get: async () => snapshot(path),
    set: async (data) => records.set(path, data),
    delete: async () => records.delete(path),
  });
  const comparable = (value) => value?.toMillis?.() ?? value;
  const named = (field) => (typeof field === "string" ? field : "__name__");
  const fieldValue = (path, rawField) => named(rawField) === "__name__"
    ? path.split("/").at(-1)
    : comparable(named(rawField).split(".").reduce((value, key) => value?.[key], records.get(path)));
  const matches = (path, field, op, value) => {
    const left = fieldValue(path, field);
    const right = comparable(value);
    if (op === "==") return left === right;
    if (op === "in") return value.includes(left);
    if (op === ">") return left > right;
    if (op === ">=") return left >= right;
    if (op === "<") return left < right;
    if (op === "<=") return left != null && left <= right;
    return false;
  };
  const collection = (name, filters = [], cap = Infinity, orders = [], cursor = []) => ({
    doc: (id) => reference(`${name}/${id}`),
    where: (field, op, value) => collection(name, [...filters, [field, op, value]], cap, orders, cursor),
    limit: (n) => collection(name, filters, n, orders, cursor),
    orderBy: (field, direction = "asc") => collection(name, filters, cap, [...orders, { field, direction }], cursor),
    startAfter: (...values) => collection(name, filters, cap, orders, values.map(comparable)),
    get: async () => {
      const depth = name.split("/").length + 1;
      const paths = [...records.keys()].filter((path) => path.startsWith(`${name}/`) && path.split("/").length === depth
        && filters.every(([field, op, value]) => matches(path, field, op, value)))
        .sort((a, b) => {
          for (const { field, direction } of orders) {
            const x = fieldValue(a, field), y = fieldValue(b, field);
            if (x !== y) return (x < y ? -1 : 1) * (direction === "desc" ? -1 : 1);
          }
          return 0;
        })
        .filter((path) => {
          if (!cursor.length) return true;
          for (let i = 0; i < orders.length; i++) {
            const value = fieldValue(path, orders[i].field);
            if (value !== cursor[i]) return orders[i].direction === "desc" ? value < cursor[i] : value > cursor[i];
          }
          return false;
        })
        .slice(0, cap);
      return { docs: paths.map(snapshot), size: paths.length, empty: !paths.length };
    },
  });
  return {
    records, collection,
    getAll: async (...refs) => Promise.all(refs.map((ref) => ref.get())),
    runTransaction(fn) {
      const task = queue.then(() => {
        const writes = [];
        return Promise.resolve(fn({
          get: (ref) => ref.get(),
          create: (ref, data) => {
            if (records.has(ref.path)) throw new Error("Document already exists");
            writes.push(() => records.set(ref.path, data));
          },
          set: (ref, data) => writes.push(() => records.set(ref.path, data)),
          update: (ref, data) => writes.push(() => records.set(ref.path, { ...records.get(ref.path), ...data })),
          delete: (ref) => writes.push(() => records.delete(ref.path)),
        })).then((result) => { writes.forEach((write) => write()); return result; });
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}

function emptyAbiValue(parameter) {
  if (parameter.type === "tuple") {
    return Object.fromEntries(parameter.components.map((item) => [item.name, emptyAbiValue(item)]));
  }
  if (parameter.type === "bool") return false;
  if (parameter.type === "address") return `0x${"0".repeat(40)}`;
  if (parameter.type === "bytes32") return `0x${"0".repeat(64)}`;
  return 0n;
}

function independentClient(record, { update = false } = {}) {
  const expected = prepareStoredProposal({
    ...record,
    id: record.id,
    expiresAt: record.expiresAt?.toDate?.() ? record.expiresAt : Timestamp.fromDate(new Date(record.expiresAt)),
  });
  return {
    expected,
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 10n, blockHash: BLOCK, transactionHash: HASH }),
    getTransaction: async () => ({
      hash: HASH, to: registry.address, from: record.researcherId, chainId: registry.chainId,
      blockNumber: 10n, blockHash: BLOCK,
      input: encodeFunctionData({
        abi: registry.abi,
        functionName: update ? "updateOpportunity" : "commitOpportunity",
        args: update ? [expected.entityId, expected.contentHash, expected.args[3]] : expected.args,
      }),
    }),
    getBlock: async ({ blockNumber }) => blockNumber === 10n
      ? { hash: BLOCK }
      : { hash: `0x${"5".repeat(64)}`, parentHash: BLOCK },
    readContract: async () => ({
      owner: record.researcherId,
      contentHash: expected.contentHash,
      kind: expected.args[1],
      expiresAt: expected.args[3],
      withdrawn: false,
      exists: true,
    }),
  };
}

function mockRpc(t, client) {
  return t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { id, method, params } = JSON.parse(options.body);
    let result;
    if (method === "eth_chainId") {
      result = numberToHex(registry.chainId);
    } else if (method === "eth_getTransactionReceipt") {
      const receipt = await client.getTransactionReceipt();
      result = { ...receipt, status: "0x1", blockNumber: numberToHex(receipt.blockNumber), logs: [] };
    } else if (method === "eth_getTransactionByHash") {
      const transaction = await client.getTransaction();
      result = {
        ...transaction, blockNumber: numberToHex(transaction.blockNumber), chainId: numberToHex(transaction.chainId),
        type: "0x2", gas: "0x10000", nonce: "0x0", value: "0x0", transactionIndex: "0x0",
      };
    } else if (method === "eth_getBlockByNumber") {
      result = { ...await client.getBlock({ blockNumber: BigInt(params[0]) }), number: params[0], transactions: [] };
    } else if (method === "eth_call") {
      const { functionName, args } = decodeFunctionData({ abi: registry.abi, data: params[0].data });
      const value = await client.readContract({ address: params[0].to, functionName, args });
      const output = registry.abi.find((item) => item.name === functionName).outputs[0];
      result = encodeFunctionResult({
        abi: registry.abi, functionName,
        result: output.type === "tuple" ? { ...emptyAbiValue(output), ...value } : value,
      });
    } else {
      throw new Error(`Unexpected RPC method: ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "Content-Type": "application/json" } });
  });
}

function bindFirestore(t, db) {
  t.mock.method(getFirestore(), "collection", db.collection.bind(db));
  t.mock.method(getFirestore(), "runTransaction", db.runTransaction.bind(db));
}

function memberRequest(uid, data) {
  return { auth: { uid, token: { auth_time: 1 } }, data };
}

function world(extra = {}) {
  return integrationDb({
    [`users/${UID}`]: { role: 0, fullName: "Author", suspended: false },
    [`users/${MEMBER}`]: { role: 0, fullName: "Visitor", suspended: false },
    "users/bob": { role: 0, fullName: "Bob", suspended: false },
    "users/evaluator": { role: 2, fullName: "Assigned evaluator", suspended: false },
    "users/admin": { role: 1, fullName: "Moderator", suspended: false },
    [`publicProfiles/${UID}`]: { fullName: "Author" },
    [`publicProfiles/${MEMBER}`]: { fullName: "Visitor" },
    "publicProfiles/bob": { fullName: "Bob" },
    "publicProfiles/evaluator": { fullName: "Assigned evaluator" },
    "problems/problem": {
      ownerId: MEMBER, title: "Routing study", summary: "Improve routes",
      status: "submitted", expiresAt: later(20 * 864e5), createdAt: now,
    },
    "proposals/indie": listingFields(),
    "proposals/draft": listingFields({ status: "draft", title: "Draft listing" }),
    "proposals/expired": listingFields({ title: "Expired listing", expiresAt: Timestamp.fromMillis(now.toMillis() - 1) }),
    "proposals/attached": {
      researcherId: "bob", postingOwnerId: MEMBER, problemId: "problem",
      title: "Attached proposal", summary: "A parented approach", status: "submitted", createdAt: now,
    },
    ...extra,
  });
}

describe("independent listing backend integration", () => {
  it("[BIT-RPF-181] should attest an independent publish through the mined funding-request transaction", async (t) => {
    const record = attestInput();
    await assert.rejects(
      attestPublication.run(memberRequest(null, { scope: "proposals", recordId: "listing-new", record })),
      { code: "unauthenticated" },
    );

    const db = integrationDb({
      [`users/${UID}`]: { suspended: false },
      [`users/${MEMBER}`]: { suspended: false },
    });
    bindFirestore(t, db);
    const fetchMock = mockRpc(t, independentClient({ ...record, id: "listing-new" }));
    try {
      await assert.rejects(
        attestPublication.run(memberRequest(MEMBER, { scope: "proposals", recordId: "listing-new", record })),
        { code: "permission-denied" },
      );
      assert.deepEqual(
        await attestPublication.run(memberRequest(UID, { scope: "proposals", recordId: "listing-new", record })),
        { verified: true },
      );
      const proof = db.records.get("publicationProofs/proposals_listing-new");
      assert.equal(proof.uid, UID);
      assert.equal(proof.validation, INDEPENDENT_PUBLISH_VALIDATION);
      assert.equal(proof.transactionHash, HASH);
      assert.equal(proof.record.proposalKind, INDEPENDENT_PROPOSAL_KIND);
      assert.ok(!("problemId" in proof.record));
      assert.ok(!("id" in proof.record));
      assert.ok(!("audit" in proof.record));
      assert.ok(fetchMock.mock.callCount() > 0);

      db.records.delete("publicationProofs/proposals_listing-new");
      await assert.rejects(
        attestPublication.run(memberRequest(UID, {
          scope: "proposals", recordId: "listing-new",
          record: { ...record, fundingTerms: { trancheBps: [4000, 6000] } },
        })),
        { code: "failed-precondition" },
      );
      assert.equal(db.records.has("publicationProofs/proposals_listing-new"), false);
    } finally {
      t.mock.restoreAll();
    }
  });

  it("[BIT-RPF-182] should keep independent correction proofs on incomplete 50/50 terms without a parent", async (t) => {
    const storedTerms = { trancheBps: [5000, 5000], note: "not a canonical six-field map" };
    const original = attestInput({ fundingTerms: storedTerms });
    const db = integrationDb({
      [`users/${UID}`]: { suspended: false },
      "proposals/listing-edit": listingFields({ status: "draft", fundingTerms: storedTerms }),
    });
    bindFirestore(t, db);
    try {
      mockRpc(t, independentClient({ ...original, id: "listing-edit" }));
      await attestPublication.run(memberRequest(UID, {
        scope: "proposals", recordId: "listing-edit", record: original,
      }));
      const first = db.records.get("publicationProofs/proposals_listing-edit");
      assert.equal(first.validation, INDEPENDENT_PUBLISH_VALIDATION);
      assert.deepEqual(first.record.fundingTerms, storedTerms);

      const revised = { ...original, title: "Revised independent listing title" };
      t.mock.restoreAll();
      bindFirestore(t, db);
      mockRpc(t, independentClient({ ...revised, id: "listing-edit" }, { update: true }));
      await attestPublication.run(memberRequest(UID, {
        scope: "proposals", recordId: "listing-edit", record: revised,
      }));
      const second = db.records.get("publicationProofs/proposals_listing-edit");
      assert.equal(second.validation, INDEPENDENT_PUBLISH_VALIDATION);
      assert.equal(second.record.title, "Revised independent listing title");
      assert.deepEqual(second.record.fundingTerms, storedTerms);
      assert.ok(!("problemId" in second.record));

      t.mock.restoreAll();
      bindFirestore(t, db);
      const linked = attestInput({ problemId: "problem-1", fundingTerms: storedTerms });
      mockRpc(t, independentClient({ ...linked, id: "listing-linked" }));
      await attestPublication.run(memberRequest(UID, {
        scope: "proposals", recordId: "listing-linked", record: linked,
      }));
      const unmarked = db.records.get("publicationProofs/proposals_listing-linked");
      assert.equal(unmarked.validation, undefined);
      assert.equal(unmarked.record.problemId, "problem-1");
    } finally {
      t.mock.restoreAll();
    }
  });

  it("[BIT-RPF-183] should keep independent listings out of matching, owner review, and evaluator action queues", async () => {
    const db = world();
    const comment = await createComment({
      db, uid: MEMBER, proposalId: "indie",
      body: "Could this annealer cover refrigerated last-mile routes?", now,
    });
    const catalog = await listIndependentListings({ db, now });
    const mine = await listMyProposals({ db, uid: UID });
    const evaluator = await listEvaluatorQueue({ db, uid: "evaluator" });
    const actions = await listActionItems({ db, uid: "evaluator", now });
    const thread = await listReportableComments({ db, uid: MEMBER, proposalId: "indie" });

    assert.deepEqual(catalog.items.map((item) => item.id).sort(), ["indie"]);
    assert.equal(mine.items.find((item) => item.id === "indie").problemId, null);
    assert.equal(mine.items.find((item) => item.id === "indie").expiresAt, later(90 * 864e5).toDate().toISOString());
    assert.equal(mine.items.find((item) => item.id === "indie").comments, 1);
    assert.deepEqual(evaluator.items.map((item) => item.id), ["attached"]);
    assert.equal(actions.evaluator.awaitingRecommendation.some((item) => item.id === "indie"), false);
    assert.equal(thread.items[0].id, comment.id);
    assert.equal(thread.items[0].problemId, null);

    await assert.rejects(
      () => fundMockProposal({
        db, uid: MEMBER, problemId: "indie", proposalId: "indie", amount: 10,
        requestId: "independent-fund-1", now,
      }),
      { code: "not-found", message: "Problem not found." },
    );
    await assert.rejects(
      () => recordOwnerReview({
        db, uid: MEMBER, proposalId: "indie", outcome: "feedback",
        rationale: "Independent listings have no designated problem owner.",
        requestId: "independent-review-1", now,
      }),
      { code: "failed-precondition", message: "This proposal is not linked to an opportunity." },
    );
  });

  it("[BIT-RPF-184] should hide an independent listing from members without locking matching", async () => {
    const db = world();
    const parent = await createComment({
      db, uid: MEMBER, proposalId: "indie",
      body: "The claimed latency needs a cited benchmark.", now,
    });
    await createComment({
      db, uid: UID, proposalId: "indie", parentId: parent.id,
      body: "The benchmark is in the attached appendix.", now,
    });
    await assert.rejects(
      () => createComment({
        db, uid: "evaluator", proposalId: "indie",
        body: "Recommend this listing.", recommendation: "recommend", now,
      }),
      { code: "invalid-argument" },
    );
    assert.notEqual(db.records.get("proposals/indie").matching?.evaluationComplete, true);

    await submitContentReport({
      db, uid: MEMBER, contentType: "proposal", contentId: "indie",
      reason: "misleading", details: "Please check the claimed result.", now,
    });
    const removed = await moderateContent({
      db, uid: "admin", queueId: "proposal_indie", action: "remove", reason: "misleading", now,
      prepareMatching: prepareModerationMatching,
    });
    assert.equal((await enqueueModerationVoidJobs({
      db, contentType: "proposal", contentId: "indie", eventId: removed.eventId, reason: "misleading", now,
    })).enqueued, 0);
    assert.equal([...db.records.keys()].some((path) => path.startsWith("mockFunding/") || path.startsWith("escrowModerationVoidJobs/")), false);

    const hidden = db.records.get("proposals/indie");
    assert.equal(hidden.moderationStatus, "removed");
    assert.equal(hidden.status, "moderated_removed");
    assert.equal(await db.runTransaction((tx) => canReadContent(tx, db, "proposal", hidden, MEMBER, { role: 0 })), false);
    assert.equal(await db.runTransaction((tx) => canReadContent(tx, db, "proposal", hidden, UID, { role: 0 })), true);
    assert.deepEqual((await listIndependentListings({ db, now })).items.map((item) => item.id), []);
    await assert.rejects(
      () => listReportableComments({ db, uid: MEMBER, proposalId: "indie" }),
      { code: "permission-denied" },
    );
    await assert.rejects(
      () => createComment({ db, uid: MEMBER, proposalId: "indie", body: "Still discussing after a hide.", now }),
      { code: "permission-denied" },
    );

    const notices = await listModerationNotifications({ db, uid: UID });
    assert.equal(notices.items[0].proposalId, "indie");
    assert.equal(notices.items[0].problemId, undefined);
    assert.equal(notices.items[0].navigationTarget, "proposal/indie");
    assert.notEqual(db.records.get("proposals/indie").matching?.evaluationComplete, true);
  });

  it("[BIT-RPF-185] should close catalog and comments when the listing window ends, keeping the author row", async () => {
    const closing = later(60_000);
    const db = world({
      "proposals/indie": listingFields({ expiresAt: closing }),
    });
    await createComment({
      db, uid: MEMBER, proposalId: "indie",
      body: "Still inside the listing window.", now,
    });
    assert.deepEqual((await listIndependentListings({ db, now })).items.map((item) => item.id), ["indie"]);
    assert.equal((await listReportableComments({ db, uid: MEMBER, proposalId: "indie" })).items.length, 1);

    const closedAt = Timestamp.fromMillis(closing.toMillis() + 1);
    assert.deepEqual((await listIndependentListings({ db, now: closedAt })).items.map((item) => item.id), []);
    await assert.rejects(
      () => createComment({
        db, uid: MEMBER, proposalId: "indie",
        body: "Too late to comment on an expired listing.", now: closedAt,
      }),
      { code: "failed-precondition", message: "The listing window has closed. Comments can no longer be added." },
    );

    const listed = await listReportableComments({ db, uid: MEMBER, proposalId: "indie" });
    assert.equal(listed.items.length, 1);
    assert.equal(
      await db.runTransaction((tx) => canReadContent(
        tx, db, "proposal", db.records.get("proposals/indie"), MEMBER, { role: 0 },
      )),
      true,
    );
    const mine = await listMyProposals({ db, uid: UID });
    const row = mine.items.find((item) => item.id === "indie");
    assert.equal(row.expiresAt, closing.toDate().toISOString());
    assert.equal(row.comments, 1);
    assert.equal(row.problemId, null);
  });
});
