import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import {
  INDEPENDENT_PROPOSAL_HASH_SCHEME,
  INDEPENDENT_PROPOSAL_KIND,
  isIndependentProposal,
} from "../independentProposal.js";
import { isPublishableIndependentProposal } from "../publicationValidation.js";
import {
  independentProposalAuditPayload,
  prepareStoredProposal,
} from "../proposalAuditPayload.js";
import { canReadContent } from "../moderation.js";
import { createComment } from "../comments.js";
import { listIndependentListings } from "../independentProposalCatalog.js";
import { listEvaluatorQueue, listMyProposals } from "../proposalQueues.js";

/** Independent listing publishability, audit, access, comments, catalog, and queues. */

const UID = `0x${"a".repeat(40)}`;
const MEMBER = `0x${"b".repeat(40)}`;
const now = Timestamp.fromMillis(1_800_000_000_000);
const later = (ms) => Timestamp.fromMillis(now.toMillis() + ms);
const past = Timestamp.fromMillis(now.toMillis() - 1);

const pdf = (i = 0) => ({
  id: `124bfa6b-1dac-4d57-a1de-fa35b736198${i}`,
  name: "spec.pdf",
  size: 580505,
  contentType: "application/pdf",
  sha256: `0x${"ab".repeat(32)}`,
});

const listing = (overrides = {}) => ({
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
  ...overrides,
});

const without = (record, key) => {
  const copy = { ...record };
  delete copy[key];
  return copy;
};

/**
 * memoryDb maps unknown operators (including `>`) to `<`, which inverts the
 * catalog's unexpired filter. This store implements `>` so listIndependentListings
 * can be unit-tested against its real query.
 */
function queryDb(initial = {}) {
  const records = new Map(Object.entries(initial));
  const named = (field) => (typeof field === "string" ? field : "__name__");
  const comparable = (value) => value?.toMillis?.() ?? value;
  const fieldValue = (path, field) => {
    const key = named(field);
    if (key === "__name__") return path.split("/").at(-1);
    return comparable(key.split(".").reduce((value, part) => value?.[part], records.get(path)));
  };
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
  const collection = (name, filters = [], orders = [], cap = Infinity, cursor = []) => ({
    where: (field, op, value) => collection(name, [...filters, [field, op, value]], orders, cap, cursor),
    orderBy: (field, direction = "asc") => collection(name, filters, [...orders, { field, direction }], cap, cursor),
    limit: (n) => collection(name, filters, orders, n, cursor),
    startAfter: (...values) => collection(name, filters, orders, cap, values.map(comparable)),
    doc: (id) => ({
      get: async () => {
        const path = `${name}/${id}`;
        return { exists: records.has(path), id, data: () => records.get(path) };
      },
    }),
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
      return {
        docs: paths.map((path) => ({ id: path.split("/").at(-1), data: () => records.get(path) })),
        size: paths.length,
      };
    },
  });
  return { collection };
}

function commentFixture(extra = {}) {
  return memoryDb({
    [`users/${UID}`]: { role: 0, fullName: "Author" },
    [`users/${MEMBER}`]: { role: 0, fullName: "Visitor" },
    "users/evaluator": { role: 2, fullName: "Assigned evaluator" },
    [`publicProfiles/${UID}`]: { fullName: "Author" },
    [`publicProfiles/${MEMBER}`]: { fullName: "Visitor" },
    "publicProfiles/evaluator": { fullName: "Assigned evaluator" },
    "proposals/live": listing({ createdAt: now }),
    "proposals/review": listing({ status: "under_review", createdAt: now }),
    "proposals/draft": listing({ status: "draft", createdAt: now }),
    "proposals/gone": listing({ status: "withdrawn", createdAt: now }),
    "proposals/orphan": {
      researcherId: UID, title: "Attached without a parent", status: "submitted", createdAt: now,
    },
    ...extra,
  });
}

describe("independent listing backend", () => {
  it("[BUT-RPF-67] accepts a complete parentless listing for publication attest", () => {
    const record = listing();
    assert.equal(isIndependentProposal(record), true);
    assert.equal(isPublishableIndependentProposal(record, { uid: UID }), true);
    assert.equal(isPublishableIndependentProposal(without(record, "fundingTerms"), { uid: UID }), true);
    assert.equal(isPublishableIndependentProposal(
      listing({ fundingTerms: { trancheBps: [5000, 5000] } }),
      { uid: UID },
    ), true);
    assert.equal(isPublishableIndependentProposal(listing({ attachments: [pdf(0)] }), { uid: UID }), true);
    assert.ok(!("problemId" in record));
    assert.ok(!("postingOwnerId" in record));
  });

  it("[BUT-RPF-68] rejects parent fields, drafts, extra keys, and a non-50/50 split", () => {
    const ctx = { uid: UID };
    assert.equal(isPublishableIndependentProposal(listing({ problemId: "problem-1" }), ctx), false);
    assert.equal(isPublishableIndependentProposal(listing({ postingOwnerId: UID }), ctx), false);
    assert.equal(isPublishableIndependentProposal(listing({ opportunityType: "business-problem" }), ctx), false);
    assert.equal(isPublishableIndependentProposal(listing({ fundingPlan: { reviewDays: "7" } }), ctx), false);
    assert.equal(isPublishableIndependentProposal(listing({ createdAt: now }), ctx), false);
    assert.equal(isPublishableIndependentProposal(listing({ status: "draft" }), ctx), false);
    assert.equal(isPublishableIndependentProposal(listing({ status: "open" }), ctx), false);
    assert.equal(isPublishableIndependentProposal(listing({ expiresAt: new Date("2099-01-01") }), ctx), false);
    assert.equal(isPublishableIndependentProposal(listing(), { uid: MEMBER }), false);
    assert.equal(isPublishableIndependentProposal(listing({ title: "A" }), ctx), false);
    assert.equal(isPublishableIndependentProposal(
      listing({ fundingTerms: { trancheBps: [4000, 6000] } }),
      ctx,
    ), false);
    assert.equal(isPublishableIndependentProposal(without(listing(), "proposalKind"), ctx), false);
  });

  it("[BUT-RPF-69] anchors independent listings as scheme-2 funding-request opportunities", () => {
    const record = { ...listing({ fundingTerms: { trancheBps: [5000, 5000] } }), id: "listing-1" };
    const payload = independentProposalAuditPayload(record);
    assert.equal(payload.proposalKind, INDEPENDENT_PROPOSAL_KIND);
    assert.equal(payload.ownerId, UID);
    assert.equal(payload.researcherId, UID);
    assert.equal(payload.amount, 990);
    assert.ok(!("problemId" in payload));
    assert.ok(!("postingOwnerId" in payload));
    assert.ok(!("fundingTerms" in payload));
    const prepared = prepareStoredProposal(record);
    assert.equal(prepared.hashScheme, INDEPENDENT_PROPOSAL_HASH_SCHEME);
    assert.equal(prepared.functionName, "commitOpportunity");
    assert.equal(prepared.args[1], 2);
    assert.equal(prepared.expectedOwner, UID);
    assert.throws(
      () => prepareStoredProposal({ ...record, fundingPlan: { reviewDays: "7" } }),
      /complete escrow payment plan/,
    );
    assert.throws(
      () => prepareStoredProposal({
        id: "attached-1",
        researcherId: UID,
        problemId: "problem-1",
        postingOwnerId: MEMBER,
        opportunityType: "business-problem",
        category: "hybrid",
        amount: 100,
        currency: "USDT",
        title: "Attached",
        summary: "Parented",
        methodology: "Anneal",
        audit: { schemaVersion: 2 },
      }),
      /hash scheme 1/,
    );
  });

  it("[BUT-RPF-70] lets members read published independent listings without a parent posting", async () => {
    const db = commentFixture({
      "proposals/hidden": listing({ moderationStatus: "hidden", createdAt: now }),
    });
    const read = (data, uid, profile = { role: 0 }) =>
      db.runTransaction((tx) => canReadContent(tx, db, "proposal", data, uid, profile));
    assert.equal(await read(listing(), MEMBER), true);
    assert.equal(await read(listing({ status: "withdrawn" }), MEMBER), true);
    assert.equal(await read(listing({ status: "draft" }), MEMBER), false);
    assert.equal(await read(listing({ status: "draft" }), UID), true);
    assert.equal(await read(listing({ moderationStatus: "hidden" }), MEMBER), false);
    assert.equal(await read({ researcherId: UID, status: "submitted" }, MEMBER), false);
  });

  it("[BUT-RPF-71] comments on independent listings omit a parent and refuse recommendations", async () => {
    const db = commentFixture();
    const posted = await createComment({
      db, uid: MEMBER, proposalId: "live",
      body: "Could this annealer cover refrigerated last-mile routes?", now,
    });
    assert.ok(!("problemId" in db.records.get(`comments/${posted.id}`)));
    assert.equal(posted.recommendation, null);
    assert.equal(posted.qualifying, false);
    assert.equal(db.records.get("proposalFeedbackSummaries/live").problemId, "");
    assert.notEqual(db.records.get("proposals/live").matching?.evaluationComplete, true);

    await createComment({
      db, uid: MEMBER, proposalId: "review",
      body: "Still discussing while under review.", now,
    });

    await assert.rejects(
      () => createComment({
        db, uid: "evaluator", proposalId: "live",
        body: "Recommend this listing.", recommendation: "recommend", now,
      }),
      { code: "invalid-argument", message: "Recommendations are not used on independent listings." },
    );
    await assert.rejects(
      () => createComment({
        db, uid: MEMBER, proposalId: "draft", body: "Drafts are not discussable.", now,
      }),
      { code: "failed-precondition", message: "Comments are only allowed on submitted solutions." },
    );
    await assert.rejects(
      () => createComment({
        db, uid: MEMBER, proposalId: "gone", body: "Withdrawn listings are closed.", now,
      }),
      { code: "failed-precondition", message: "The listing window has closed. Comments can no longer be added." },
    );
    await assert.rejects(
      () => createComment({
        db, uid: MEMBER, proposalId: "orphan", body: "Needs a parent posting.", now,
      }),
      { code: "failed-precondition", message: "This proposal is not linked to an opportunity." },
    );
  });

  it("[BUT-RPF-72] catalogs only submitted unexpired independent listings for members", async () => {
    const longSummary = `${"x".repeat(450)} should be trimmed`;
    const db = queryDb({
      [`publicProfiles/${UID}`]: { organisation: "  Meridian Logistics  " },
      "proposals/live-a": listing({ title: "Sooner listing", expiresAt: later(10 * 864e5), createdAt: now }),
      "proposals/live-b": listing({
        title: "Later listing", summary: longSummary, expiresAt: later(40 * 864e5), createdAt: now,
      }),
      "proposals/draft": listing({ status: "draft", expiresAt: later(5 * 864e5) }),
      "proposals/gone": listing({ status: "withdrawn", expiresAt: later(5 * 864e5) }),
      "proposals/old": listing({ expiresAt: past }),
      "proposals/hidden": listing({
        title: "Hidden listing", moderationStatus: "hidden", expiresAt: later(8 * 864e5),
      }),
      "proposals/attached": {
        researcherId: MEMBER, problemId: "problem-1", status: "submitted",
        title: "Attached proposal", expiresAt: later(5 * 864e5),
      },
    });
    const page = await listIndependentListings({ db, now });
    assert.deepEqual(page.items.map((item) => item.id), ["live-a", "live-b"]);
    assert.equal(page.nextCursor, null);
    assert.equal(page.items[0].status, "submitted");
    assert.equal(page.items[0].researcherId, UID);
    assert.equal(page.items[0].organisation, "Meridian Logistics");
    assert.equal(page.items[1].organisation, "Meridian Logistics");
    assert.equal(page.items[1].summary.length, 400);
    assert.ok(!page.items.some((item) => item.id === "hidden" || item.id === "attached" || item.id === "old"));
  });

  it("[BUT-RPF-73] author queues keep independent expiry while evaluators skip parentless rows", async () => {
    const db = memoryDb({
      [`users/${UID}`]: { role: 0, fullName: "Author" },
      "users/bob": { role: 0, fullName: "Bob" },
      "users/evaluator": { role: 2, fullName: "Assigned evaluator" },
      "problems/problem": {
        ownerId: MEMBER, title: "Routing study", status: "submitted",
        expiresAt: later(20 * 864e5), createdAt: now,
      },
      "proposals/indie": listing({ createdAt: now, expiresAt: later(12 * 864e5) }),
      "proposals/attached": {
        researcherId: "bob", postingOwnerId: MEMBER, problemId: "problem",
        title: "Attached proposal", status: "submitted", createdAt: now,
      },
    });
    const mine = await listMyProposals({ db, uid: UID });
    assert.equal(mine.items.length, 1);
    assert.equal(mine.items[0].id, "indie");
    assert.equal(mine.items[0].proposalKind, INDEPENDENT_PROPOSAL_KIND);
    assert.equal(mine.items[0].problemId, null);
    assert.equal(mine.items[0].expiresAt, later(12 * 864e5).toDate().toISOString());
    assert.equal(mine.items[0].posting.expiresAt, null);

    const queue = await listEvaluatorQueue({ db, uid: "evaluator" });
    assert.deepEqual(queue.items.map((item) => item.id), ["attached"]);
    assert.ok(!queue.items.some((item) => item.id === "indie"));
  });
});
