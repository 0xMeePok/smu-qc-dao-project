import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { readAuditTrail } from "../auditTrail.js";

const owner = `0x${"a".repeat(40)}`;
const member = `0x${"b".repeat(40)}`;
const admin = `0x${"c".repeat(40)}`;
const creator = `0x${"d".repeat(40)}`;
const funder = `0x${"e".repeat(40)}`;
const tx = `0x${"1".repeat(64)}`;

const at = (iso) => Timestamp.fromDate(new Date(iso));
const profile = (role) => ({ role, suspended: false });

function memoryDb(initial) {
  const records = new Map(Object.entries(initial));
  const comparable = (value) => value?.toMillis?.() ?? value;
  const fieldValue = (path, field) => comparable(field.split(".").reduce((value, key) => value?.[key], records.get(path)));
  const matches = (path, field, op, value) => {
    const left = fieldValue(path, field);
    const right = comparable(value);
    if (op === "==") return left === right;
    if (op === "in") return value.includes(left);
    if (op === ">=") return left >= right;
    if (op === "<=") return left != null && left <= right;
    return false;
  };
  const snapshot = (path) => ({ id: path.split("/").at(-1), exists: records.has(path), data: () => records.get(path) });
  const query = (name, filters = [], cap = Infinity, orders = []) => ({
    where: (field, op, value) => query(name, [...filters, [field, op, value]], cap, orders),
    orderBy: (field, direction = "asc") => query(name, filters, cap, [...orders, { field, direction }]),
    limit: (count) => query(name, filters, count, orders),
    get: async () => {
      const depth = name.split("/").length + 1;
      const paths = [...records.keys()].filter((path) => path.startsWith(`${name}/`) && path.split("/").length === depth
        && filters.every(([field, op, value]) => matches(path, field, op, value)))
        .sort((left, right) => {
          for (const { field, direction } of orders) {
            const x = fieldValue(left, field);
            const y = fieldValue(right, field);
            if (x !== y) return (x < y ? -1 : 1) * (direction === "desc" ? -1 : 1);
          }
          return 0;
        })
        .slice(0, cap);
      return { docs: paths.map(snapshot), size: paths.length, empty: !paths.length };
    },
  });
  return {
    collection: (name) => ({
      doc: (id) => ({ get: async () => snapshot(`${name}/${id}`) }),
      where: (field, op, value) => query(name).where(field, op, value),
      orderBy: (field, direction) => query(name).orderBy(field, direction),
    }),
  };
}

function fixture() {
  return memoryDb({
    "problems/problem-1": { ownerId: owner, status: "open", title: "Route medicines" },
    "problems/draft-1": { ownerId: owner, status: "draft", title: "Unpublished" },
    "proposals/proposal-1": {
      researcherId: creator, problemId: "problem-1", status: "submitted", title: "Cold chain",
      createdAt: at("2026-09-01T00:00:00Z"),
      audit: { status: "confirmed", transactionHash: tx },
    },
    "comments/comment-1": {
      proposalId: "proposal-1", problemId: "problem-1", recommendation: "recommend_with_revisions",
      authorRole: "evaluator", moderationStatus: "visible", createdAt: at("2026-09-10T00:00:00Z"),
      qftGrade: 9, body: "secret scores should not leak", criterionScores: { method: 4 },
    },
    "comments/comment-hidden": {
      proposalId: "proposal-1", problemId: "problem-1", recommendation: "do_not_recommend",
      authorId: creator, moderationStatus: "hidden", createdAt: at("2026-09-11T00:00:00Z"), body: "hidden",
    },
    "matchingEvents/selected": {
      type: "owner_selected", problemId: "problem-1", proposalId: "proposal-1", actorId: owner,
      actorRole: "problem_owner", createdAt: at("2026-09-12T00:00:00Z"),
    },
    "matchingEvents/funded": {
      type: "funding_contributed", problemId: "problem-1", proposalId: "proposal-1", actorId: funder,
      actorRole: "member", createdAt: at("2026-09-13T00:00:00Z"),
    },
    "matchingEvents/mock-eval": {
      type: "mock_evaluation_completed", problemId: "problem-1", proposalId: "proposal-1",
      actorId: admin, actorRole: "admin", createdAt: at("2026-09-14T00:00:00Z"),
    },
    "moderationEvents/mod-1": {
      contentType: "problem", contentId: "problem-1", action: "hide", actorId: admin,
      createdAt: at("2026-09-15T00:00:00Z"),
    },
    "audits/escrow-1": {
      type: "escrow", problemId: "problem-1", proposalId: "proposal-1", title: "Cold chain",
      actor: funder, transactionHash: tx, timestamp: at("2026-09-16T00:00:00Z"),
    },
    "audits/role-1": {
      type: "role_change", actor: admin, targetName: "Ada", timestamp: at("2026-09-17T00:00:00Z"),
    },
  });
}

const problemTrail = (db, uid, role, input = {}) => readAuditTrail({
  db, uid, profile: profile(role), input: { entityType: "problem", entityId: "problem-1", ...input },
});

describe("QCDAO-96 and QCDAO-97 consolidated audit trail", () => {
  it("shows on-chain and off-chain workflow events without scores or private funders", async () => {
    const { items, count } = await problemTrail(fixture(), member, 0);
    const kinds = items.map((item) => item.eventType);
    assert.equal(count, items.length);
    assert.ok(kinds.includes("proposal_submitted"));
    assert.ok(kinds.includes("evaluator_recommendation"));
    assert.ok(kinds.includes("selection"));
    assert.ok(kinds.includes("funding_status"));
    assert.ok(kinds.includes("moderation"));
    assert.equal(kinds.includes("governance"), false);
    assert.equal(items.some((item) => /mock evaluation|evaluation complete/i.test(item.label + item.description)), false);

    const recommendation = items.find((item) => item.eventType === "evaluator_recommendation");
    assert.equal(recommendation.recommendation, "recommend_with_revisions");
    assert.equal(recommendation.recommendationLabel, "Recommend with revisions");
    assert.equal(recommendation.badge, "evaluator");
    assert.equal(recommendation.verification, "off_chain");
    assert.equal(recommendation.commentId, "comment-1");
    assert.equal(recommendation.offChain, true);
    assert.equal("body" in recommendation, false);
    assert.equal("qftGrade" in recommendation, false);
    assert.equal("criterionScores" in recommendation, false);
    assert.equal(items.some((item) => item.recommendation === "do_not_recommend"), false);

    const submission = items.find((item) => item.eventType === "proposal_submitted");
    assert.equal(submission.verification, "anchored");
    assert.equal(submission.receiptKind, "proposal");
    const funding = items.find((item) => item.id === "match_funded");
    assert.equal(funding.actorLabel, "Private contributor");
    assert.equal(JSON.stringify(items).includes(funder), false);
    const selected = items.find((item) => item.eventType === "selection");
    assert.deepEqual(selected.types, ["selection", "owner_approval"]);
  });

  it("combines event type, date, role, entity and verification filters", async () => {
    const db = fixture();
    const selected = await problemTrail(db, member, 0, {
      eventTypes: ["selection", "owner_approval"],
      actorRole: "problem_owner",
      startDate: "2026-09-12",
      endDate: "2026-09-12",
      related: "cold",
      verification: "off_chain",
    });
    assert.equal(selected.count, 1);
    assert.equal(selected.items[0].id, "match_selected");

    const anchored = await problemTrail(db, member, 0, { verification: "anchored" });
    assert.ok(anchored.items.every((item) => item.verification === "anchored"));
    assert.equal(anchored.items.some((item) => item.eventType === "evaluator_recommendation"), false);

    const empty = await problemTrail(db, member, 0, { eventTypes: ["solution_owner_decline"], related: "missing" });
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.items, []);
  });

  it("lets an administrator see every record, including governance and funder identity", async () => {
    const { items } = await readAuditTrail({ db: fixture(), uid: admin, profile: profile(1), input: {} });
    assert.ok(items.some((item) => item.eventType === "governance"));
    assert.ok(items.some((item) => item.recommendation === "do_not_recommend"));
    const funding = items.find((item) => item.id === "match_funded");
    assert.match(funding.actorLabel, /0xe{3}/);
    await assert.rejects(
      () => readAuditTrail({ db: fixture(), uid: member, profile: profile(0), input: {} }),
      (error) => error instanceof HttpsError && error.code === "permission-denied",
    );
  });

  it("hides trails for records the member cannot view and rejects a bad date range", async () => {
    await assert.rejects(
      () => readAuditTrail({
        db: fixture(), uid: member, profile: profile(0), input: { entityType: "problem", entityId: "draft-1" },
      }),
      (error) => error instanceof HttpsError && error.code === "permission-denied",
    );
    await assert.rejects(
      () => problemTrail(fixture(), member, 0, { startDate: "2026-10-02", endDate: "2026-09-01" }),
      (error) => error instanceof HttpsError && error.code === "invalid-argument",
    );
  });

  it("pages older events with a cursor", async () => {
    const records = { "problems/problem-1": { ownerId: owner, status: "open", title: "Route medicines" } };
    for (let index = 0; index < 26; index += 1) {
      records[`matchingEvents/event-${index}`] = {
        type: "owner_selected", problemId: "problem-1", proposalId: "proposal-1", actorId: owner,
        actorRole: "problem_owner", createdAt: at(`2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`),
      };
    }
    const first = await problemTrail(memoryDb(records), member, 0);
    assert.equal(first.items.length, 25);
    assert.equal(first.count, 26);
    assert.ok(first.nextCursor);
    const second = await problemTrail(memoryDb(records), member, 0, { cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.equal(first.items.some((item) => item.id === second.items[0].id), false);
  });
});
