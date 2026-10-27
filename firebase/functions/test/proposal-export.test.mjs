import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { memoryDb } from "./memoryDb.mjs";
import {
  CSV_COLUMNS,
  EXPORT_COMMENT_CAP,
  EXPORT_NOTICE,
  EXPORT_SCAN_CAP,
  EXPORT_SCHEMA_VERSION,
  exportSelectedProposals,
} from "../proposalExport.js";

const schema = JSON.parse(readFileSync(new URL("../../../docs/schemas/selected-proposal-export.schema.json", import.meta.url), "utf8"));
const at = (iso) => Timestamp.fromDate(new Date(iso));
const actor = { actorUid: "0xadmin", actorName: "Ada Admin" };

function posting(id, extra = {}) {
  return {
    ownerId: "0xowner",
    organisation: "QC Lab",
    title: `Posting ${id}`,
    summary: `Summary ${id}`,
    status: "submitted",
    opportunityType: "business-problem",
    categories: ["routing"],
    amount: 1000,
    currency: "SGD",
    hasAcceptedSolution: true,
    acceptedProposalId: `proposal-${id}`,
    createdAt: at("2026-09-01T00:00:00.000Z"),
    updatedAt: at("2026-10-02T00:00:00.000Z"),
    expiresAt: at("2026-12-01T00:00:00.000Z"),
    ...extra,
  };
}

function proposal(id, extra = {}) {
  return {
    researcherId: "0xresearcher",
    problemId: id.replace("proposal-", "posting-").replace(/^proposal/, "posting"),
    title: `Proposal ${id}`,
    summary: `Approach ${id}`,
    status: "accepted",
    amount: 1000,
    currency: "SGD",
    category: "annealing",
    createdAt: at("2026-09-15T00:00:00.000Z"),
    updatedAt: at("2026-10-02T00:00:00.000Z"),
    ...extra,
  };
}

function comment(extra = {}) {
  return {
    authorId: "0xmember",
    authorRole: "user",
    badge: null,
    recommendation: null,
    body: "A public comment.",
    parentId: null,
    qualifying: false,
    moderationStatus: "visible",
    createdAt: at("2026-10-03T00:00:00.000Z"),
    updatedAt: at("2026-10-03T00:00:00.000Z"),
    ...extra,
  };
}

function store(records) {
  return memoryDb(records);
}

function exportOf(db, input, now = at("2026-10-27T08:00:00.000Z")) {
  return exportSelectedProposals({ db, ...actor, input, now });
}

function audits(db) {
  return [...db.records.entries()].filter(([path]) => path.startsWith("audits/"));
}

function typeMatches(types, value) {
  return types.some((type) => {
    if (type === "null") return value == null;
    if (type === "array") return Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  });
}

function assertConforms(node, value, path, root = schema) {
  if (node.$ref) {
    const name = node.$ref.replace("#/$defs/", "");
    assertConforms(root.$defs[name], value, path, root);
    return;
  }
  if (node.oneOf || node.anyOf) {
    const options = node.oneOf || node.anyOf;
    const errors = [];
    for (const option of options) {
      try {
        assertConforms(option, value, path, root);
        return;
      } catch (error) {
        errors.push(error.message);
      }
    }
    assert.fail(`${path} matched no schema branch:\n${errors.join("\n")}`);
  }
  if (Object.hasOwn(node, "const")) {
    assert.deepEqual(value, node.const, path);
    return;
  }
  if (node.enum) {
    assert.ok(node.enum.includes(value), `${path} value ${JSON.stringify(value)} is not in the schema`);
    return;
  }
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (types.length && !typeMatches(types, value)) {
    assert.fail(`${path} expected ${types.join("|")} but was ${JSON.stringify(value)}`);
  }
  if (types.includes("object") || node.properties) {
    for (const key of node.required || []) assert.ok(Object.hasOwn(value, key), `${path}${key} is required`);
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.ok(node.properties?.[key], `${path}${key} is not in the published schema`);
    }
    for (const [key, child] of Object.entries(node.properties || {})) {
      if (!Object.hasOwn(value, key)) continue;
      assertConforms(child, value[key], `${path}${key}.`, root);
    }
    return;
  }
  if (types.includes("array")) {
    for (const [index, item] of value.entries()) assertConforms(node.items, item, `${path}[${index}].`, root);
  }
}

describe("QCDAO-107 selected proposal export", () => {
  it("publishes a schema that matches the JSON file and the CSV columns", async () => {
    assert.equal(schema["x-schema-version"], EXPORT_SCHEMA_VERSION);
    assert.deepEqual(schema["x-csv-columns"], [...CSV_COLUMNS]);
    const db = store({
      "problems/posting-a": posting("posting-a"),
      "proposals/proposal-posting-a": proposal("proposal-posting-a", { problemId: "posting-a" }),
      "comments/eval": comment({
        proposalId: "proposal-posting-a",
        problemId: "posting-a",
        authorId: "0xevaluator",
        authorRole: "evaluator",
        badge: "evaluator",
        recommendation: "recommend_with_revisions",
        qualifying: true,
        body: "=SUM(A1)\nHe said \"revise\".",
      }),
    });
    const { document, csv } = await exportOf(db, { postingId: "posting-a" });
    assertConforms(schema, document, "document.");
    assert.equal(csv.split("\r\n")[0], CSV_COLUMNS.join(","));
    assert.match(csv, /"'=SUM\(A1\)/);
    assert.equal(document.postings[0].proposals[0].comments[0].body.startsWith("=SUM(A1)"), true);
  });

  it("exports one accepted posting as JSON and CSV, including the evaluator badge and recommendation", async () => {
    const db = store({
      "problems/posting-a": posting("posting-a"),
      "proposals/proposal-posting-a": proposal("proposal-posting-a", { problemId: "posting-a", title: "Annealing study" }),
      "proposals/other": proposal("other", { problemId: "posting-a", status: "submitted", title: "Not selected" }),
      "comments/member": comment({ proposalId: "proposal-posting-a", problemId: "posting-a", authorId: "0xmember", body: "Looks promising." }),
      "comments/eval": comment({
        proposalId: "proposal-posting-a",
        problemId: "posting-a",
        authorId: "0xevaluator",
        authorRole: "evaluator",
        badge: "evaluator",
        recommendation: "recommend",
        qualifying: true,
        body: "Recommend this approach.",
        createdAt: at("2026-10-04T00:00:00.000Z"),
      }),
      "comments/reply": comment({
        proposalId: "proposal-posting-a",
        parentId: "eval",
        authorId: "0xresearcher",
        authorRole: "user",
        body: "Thanks, the revision is in.",
        createdAt: at("2026-10-05T00:00:00.000Z"),
      }),
      "comments/removed": comment({
        proposalId: "proposal-posting-a",
        authorId: "0xevaluator",
        authorRole: "evaluator",
        badge: "evaluator",
        recommendation: "do_not_recommend",
        body: "Withdrawn after reading the appendix.",
        deletedAt: at("2026-10-06T00:00:00.000Z"),
        moderationStatus: "removed",
        qualifying: false,
        createdAt: at("2026-10-06T00:00:00.000Z"),
      }),
      "comments/sibling": comment({ proposalId: "other", body: "This comment is on another proposal." }),
    });
    const result = await exportOf(db, { postingId: "posting-a" });
    assert.equal(result.document.notice, EXPORT_NOTICE);
    assert.equal(result.document.scope.mode, "posting");
    assert.equal(result.postingCount, 1);
    assert.equal(result.proposalCount, 1);
    assert.equal(result.commentCount, 4);
    const [exported] = result.document.postings;
    assert.equal(exported.workflowStatus, "decision_recorded");
    assert.equal(exported.proposals[0].id, "proposal-posting-a");
    assert.equal(exported.proposals[0].workflowStatus, "accepted");
    assert.equal(exported.proposals[0].title, "Annealing study");
    const evaluator = exported.proposals[0].comments.find((row) => row.id === "eval");
    assert.equal(evaluator.authorId, "0xevaluator");
    assert.equal(evaluator.authorRole, "evaluator");
    assert.equal(evaluator.badge, "evaluator");
    assert.equal(evaluator.recommendation, "recommend");
    assert.equal(evaluator.recommendationLabel, "Recommend");
    assert.equal(evaluator.qualifying, true);
    const removed = exported.proposals[0].comments.find((row) => row.id === "removed");
    assert.equal(removed.recommendation, "do_not_recommend");
    assert.equal(removed.recommendationLabel, "Do not recommend");
    assert.equal(removed.deletedAt, "2026-10-06T00:00:00.000Z");
    assert.equal(JSON.stringify(result.document).includes("another proposal"), false);
    assert.equal(JSON.stringify(result.document).includes("qftGrade"), false);
    assert.match(result.csv, /0xevaluator,evaluator,evaluator,recommend,Recommend/);
    const [auditPath, audit] = audits(db)[0];
    assert.equal(auditPath.startsWith("audits/"), true);
    assert.equal(audit.type, "proposal_comment_export");
    assert.equal(audit.action, "PROPOSAL_COMMENT_EXPORT");
    assert.equal(audit.actor, "0xadmin");
    assert.equal(audit.actorName, "Ada Admin");
    assert.equal(audit.scope, "posting");
    assert.equal(audit.postingId, "posting-a");
    assert.equal(audit.problemId, "posting-a");
    assert.equal(audit.commentCount, 4);
    assert.equal(audit.schemaVersion, 1);
    assert.equal(audit.timestamp.toDate().toISOString(), "2026-10-27T08:00:00.000Z");
    assert.equal(result.auditId, auditPath.split("/")[1]);
  });

  it("returns every accepted posting in a date range and leaves the others out", async () => {
    const db = store({
      "problems/early": posting("early", { acceptedProposalId: "early-proposal", updatedAt: at("2026-10-02T00:00:00.000Z") }),
      "proposals/early-proposal": proposal("early-proposal", { problemId: "early", updatedAt: at("2026-10-02T00:00:00.000Z") }),
      "comments/early-note": comment({ proposalId: "early-proposal", authorId: "0xearly" }),
      "problems/late": posting("late", { acceptedProposalId: "late-proposal", updatedAt: at("2026-11-02T00:00:00.000Z") }),
      "proposals/late-proposal": proposal("late-proposal", { problemId: "late", updatedAt: at("2026-11-02T00:00:00.000Z") }),
      "comments/late-note": comment({ proposalId: "late-proposal", authorId: "0xlate" }),
      "problems/open": { ...posting("open", { hasAcceptedSolution: false, acceptedProposalId: null, opportunityType: "open-funding" }), title: "Grant call" },
      "proposals/grant-in": proposal("grant-in", { problemId: "open", updatedAt: at("2026-10-20T00:00:00.000Z"), title: "In range grant" }),
      "proposals/grant-out": proposal("grant-out", { problemId: "open", updatedAt: at("2026-11-20T00:00:00.000Z"), title: "Later grant" }),
      "comments/grant-note": comment({
        proposalId: "grant-in",
        authorId: "0xevaluator",
        authorRole: "evaluator",
        badge: "evaluator",
        recommendation: "recommend_with_revisions",
        qualifying: true,
        body: "Recommend with the stated caveat.",
      }),
    });
    const { document, csv } = await exportOf(db, { startDate: "2026-10-01", endDate: "2026-10-31" });
    assert.deepEqual(document.postings.map((row) => row.id), ["early", "open"]);
    assert.deepEqual(document.postings[1].proposals.map((row) => row.id), ["grant-in"]);
    const grantComment = document.postings[1].proposals[0].comments[0];
    assert.equal(grantComment.badge, "evaluator");
    assert.equal(grantComment.recommendation, "recommend_with_revisions");
    assert.equal(grantComment.recommendationLabel, "Recommend with revisions");
    assert.equal(csv.includes("0xlate"), false);
    assert.equal(csv.includes("Later grant"), false);
    const audit = audits(db)[0][1];
    assert.equal(audit.scope, "range");
    assert.equal(audit.startDate, "2026-10-01");
    assert.equal(audit.endDate, "2026-10-31");
    assert.equal(audit.postingId, null);
    assert.equal(audit.problemId, null);
    assert.deepEqual(audit.postingIds, ["early", "open"]);
    assert.equal(audit.actor, "0xadmin");
    assert.ok(audit.timestamp);
  });

  it("includes a mock confirmation whose proposal status is still submitted", async () => {
    const db = store({
      "problems/mock": {
        ...posting("mock", { hasAcceptedSolution: false, acceptedProposalId: null }),
        matching: { status: "confirmed", proposalId: "mock-proposal", confirmedAt: at("2026-10-11T00:00:00.000Z") },
      },
      "proposals/mock-proposal": proposal("mock-proposal", {
        problemId: "mock",
        status: "submitted",
        matching: { status: "confirmed" },
      }),
      "comments/mock-note": comment({ proposalId: "mock-proposal", body: "Noted." }),
    });
    const { document } = await exportOf(db, { postingId: "mock" });
    assert.equal(document.postings[0].acceptedAt, "2026-10-11T00:00:00.000Z");
    assert.equal(document.postings[0].proposals[0].workflowStatus, "accepted");
    assert.equal(document.commentCount, 1);
  });

  it("keeps a proposal that has no comments, and records an empty range", async () => {
    const db = store({
      "problems/quiet": posting("quiet"),
      "proposals/proposal-quiet": proposal("proposal-quiet", { problemId: "quiet" }),
    });
    const single = await exportOf(db, { postingId: "quiet" });
    assert.equal(single.commentCount, 0);
    const lines = single.csv.trim().split("\r\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1], /quiet,.*proposal-quiet/);
    const empty = store({});
    const range = await exportOf(empty, { startDate: "2026-01-01", endDate: "2026-01-02" });
    assert.deepEqual(range.document.postings, []);
    assert.equal(range.csv, `${CSV_COLUMNS.join(",")}\r\n`);
    assert.equal(audits(empty).length, 1);
    assert.equal(audits(empty)[0][1].postingCount, 0);
  });

  it("refuses a posting that is not accepted, a missing posting, and a malformed request", async () => {
    const db = store({
      "problems/open": posting("open", { hasAcceptedSolution: false, acceptedProposalId: "" }),
      "proposals/still-open": proposal("still-open", { problemId: "open", status: "submitted" }),
    });
    await assert.rejects(() => exportOf(db, { postingId: "open" }), (error) => error instanceof HttpsError && error.code === "failed-precondition");
    await assert.rejects(() => exportOf(db, { postingId: "missing" }), (error) => error instanceof HttpsError && error.code === "not-found");
    await assert.rejects(() => exportOf(db, {}), (error) => error instanceof HttpsError && error.code === "invalid-argument");
    await assert.rejects(() => exportOf(db, { postingId: "open", startDate: "2026-10-01", endDate: "2026-10-02" }), (error) => error instanceof HttpsError && error.code === "invalid-argument");
    await assert.rejects(() => exportOf(db, { startDate: "2026-10-02", endDate: "2026-10-01" }), (error) => error instanceof HttpsError && error.code === "invalid-argument");
    await assert.rejects(() => exportOf(db, { startDate: "2026-13-01", endDate: "2026-13-02" }), (error) => error instanceof HttpsError && error.code === "invalid-argument");
    assert.equal(audits(db).length, 0);
  });

  it("stops instead of returning a partial comment list", async () => {
    const records = {
      "problems/full": posting("full"),
      "proposals/proposal-full": proposal("proposal-full", { problemId: "full" }),
    };
    for (let index = 0; index <= EXPORT_COMMENT_CAP; index += 1) {
      records[`comments/c${index}`] = comment({ proposalId: "proposal-full", body: `note ${index}` });
    }
    const db = store(records);
    await assert.rejects(() => exportOf(db, { postingId: "full" }), (error) => error instanceof HttpsError && error.code === "resource-exhausted");
    assert.equal(audits(db).length, 0);
    assert.ok(EXPORT_SCAN_CAP >= 1);
  });
});
