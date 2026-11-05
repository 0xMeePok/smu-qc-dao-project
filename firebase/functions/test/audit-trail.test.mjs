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
const token = `0x${"2".repeat(40)}`;
const escrow = `0x${"3".repeat(40)}`;

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
    records,
    collection: (name) => ({
      doc: (id) => ({ path: `${name}/${id}`, get: async () => snapshot(`${name}/${id}`) }),
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
      authorId: owner, reason: "abusive", details: "do not quote this brief", title: "Route medicines",
      salt: `0x${"ab".repeat(32)}`, createdAt: at("2026-09-15T00:00:00Z"), chainStatus: "pending",
    },
    "moderationEvents/mod-comment": {
      contentType: "comment", contentId: "comment-9", parentProblemId: "problem-1",
      action: "remove", actorId: admin, authorId: creator, reason: "spam",
      details: "quoted comment text", title: "Route medicines",
      createdAt: at("2026-09-15T01:00:00Z"), chainStatus: "anchored", transactionHash: tx,
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

it("does not claim an escrow deposit is confirmed without a valid verified transaction reference", async () => {
  for (const patch of [{ transactionHash: "" }, { transactionHash: "not-a-transaction" }, { verified: false }]) {
    const db = fixture();
    const row = db.records.get("audits/escrow-1");
    db.records.set("audits/escrow-1", { ...row, eventType: "Deposit", verified: true, ...patch });
    const { items } = await problemTrail(db, member, 0, { eventTypes: ["funding_status"] });
    const event = items.find(item => item.id === "audit_escrow-1");
    assert.equal(event.verification, "pending");
    assert.equal(event.label, "Escrow deposit");
    assert.equal(event.description.includes("confirmed"), false);
    assert.match(event.description, /waiting for on-chain verification/);
  }
});

function fundingRow(eventType, fields = {}) {
  return { type: "escrow", eventType, problemId: "problem-1", proposalId: "proposal-1", title: "Cold chain",
    actor: funder, counterparty: escrow, amountBaseUnits: "1234567", tokenAddress: token,
    tokenSymbol: "USDC", tokenDecimals: 6, escrowAddress: escrow, verified: true,
    transactionHash: tx, blockNumber: 101, chainId: 421614, timestamp: at("2026-09-20T00:00:00Z"), ...fields };
}

describe("QCDAO-117 verified funding audit details", () => {
  it("projects event-specific deposit, lock, release, refund, cancellation and expiry details", async () => {
    const db = fixture();
    const events = [
      ["Deposit", "Escrow deposit confirmed", {}],
      ["SelectionLocked", "Escrow selection locked", { actor: owner, counterparty: null, amountBaseUnits: null }],
      ["TrancheReleased", "Escrow tranche released", { actor: owner, counterparty: creator }],
      ["RefundClaimed", "Escrow refund claimed", { counterparty: funder }],
      ["Cancelled", "Escrow cancelled", { actor: owner, counterparty: null, amountBaseUnits: null }],
      ["Expired", "Escrow expired", { actor: "system", counterparty: null, amountBaseUnits: null }],
    ];
    for (const [eventType, , fields] of events) db.records.set(`audits/${eventType}`, fundingRow(eventType, fields));
    const result = await problemTrail(db, member, 0, { eventTypes: ["funding_status"], verification: "anchored" });
    for (const [eventType, label, fields] of events) {
      const event = result.items.find((row) => row.id === `audit_${eventType}`);
      assert.ok(event, eventType); assert.equal(event.label, label);
      assert.equal(event.eventType, "funding_status"); assert.deepEqual(event.types, ["funding_status"]);
      assert.equal(event.funding.eventType, eventType);
      assert.equal(event.funding.amountBaseUnits, Object.hasOwn(fields, "amountBaseUnits") ? fields.amountBaseUnits : "1234567");
      assert.equal(event.funding.tokenAddress, token); assert.equal(event.funding.tokenSymbol, "USDC");
      assert.equal(event.funding.tokenDecimals, 6); assert.equal(event.funding.transactionHash, tx);
      assert.equal(event.funding.blockNumber, 101); assert.equal(event.funding.chainId, 421614);
      assert.equal(event.transactionHash, tx); assert.equal(event.verification, "anchored");
      assert.equal(event.receiptKind, "proposal"); assert.match(event.description, new RegExp(label));
    }
    const deposit = result.items.find((row) => row.id === "audit_Deposit");
    assert.equal(deposit.funding.counterpartyAddress, escrow); assert.equal(deposit.funding.counterpartyLabel, "Escrow");
    const release = result.items.find((row) => row.id === "audit_TrancheReleased");
    assert.equal(release.actorRole, "problem_owner"); assert.equal(release.funding.actorLabel, "Problem owner");
    assert.equal(release.funding.actorAddress, owner);
    assert.equal(release.funding.counterpartyAddress, creator); assert.equal(release.funding.counterpartyLabel, "Solution owner");
    const expired = result.items.find((row) => row.id === "audit_Expired");
    assert.equal(expired.actorRole, "system"); assert.equal(expired.funding.actorLabel, "System");
    assert.equal(expired.funding.actorAddress, null);
  });

  it("keeps contributor and matching refund-recipient identities private for every non-admin", async () => {
    const db = fixture();
    db.records.set("audits/deposit", fundingRow("Deposit"));
    db.records.set("audits/refund", fundingRow("RefundClaimed", { counterparty: funder }));
    for (const uid of [member, owner, creator, funder]) {
      const result = await problemTrail(db, uid, 0, { eventTypes: ["funding_status"] });
      for (const id of ["audit_deposit", "audit_refund"]) {
        const event = result.items.find((row) => row.id === id);
        assert.equal(event.actorLabel, "Private contributor");
        assert.equal(event.funding.actorAddress, null); assert.equal(event.funding.actorLabel, "Private contributor");
        assert.equal(JSON.stringify(event).includes(funder), false);
      }
      const refund = result.items.find((row) => row.id === "audit_refund");
      assert.equal(refund.funding.counterpartyAddress, null); assert.equal(refund.funding.counterpartyLabel, "Private contributor");
    }
    const result = await problemTrail(db, admin, 1, { eventTypes: ["funding_status"] });
    const refund = result.items.find((row) => row.id === "audit_refund");
    assert.equal(refund.funding.actorAddress, funder); assert.equal(refund.funding.counterpartyAddress, funder);
    assert.match(refund.funding.actorLabel, /^0xeeee/); assert.match(refund.funding.counterpartyLabel, /^0xeeee/);
  });

  it("keeps owner contributions and creator funder votes private despite known public roles", async () => {
    const db = fixture();
    db.records.set("audits/owner-deposit", fundingRow("Deposit", { actor: owner, counterparty: owner }));
    db.records.set("audits/owner-refund", fundingRow("RefundClaimed", { actor: owner, counterparty: owner }));
    db.records.set("audits/creator-vote", fundingRow("FunderVote", { actor: creator, counterparty: null, amountBaseUnits: null }));
    const result = await problemTrail(db, member, 0, { eventTypes: ["funding_status"] });
    const deposit = result.items.find((row) => row.id === "audit_owner-deposit");
    assert.equal(deposit.actorRole, "funder"); assert.equal(deposit.funding.actorAddress, null);
    assert.equal(deposit.funding.counterpartyAddress, null); assert.equal(deposit.funding.counterpartyLabel, "Private contributor");
    const refund = result.items.find((row) => row.id === "audit_owner-refund");
    assert.equal(refund.funding.actorAddress, null); assert.equal(refund.funding.counterpartyAddress, null);
    assert.equal(refund.funding.counterpartyLabel, "Private contributor");
    const vote = result.items.find((row) => row.id === "audit_creator-vote");
    assert.equal(vote.funding.actorAddress, null); assert.equal(vote.funding.actorLabel, "Private contributor");
  });

  it("preserves zero-decimal tokens and huge exact base-unit amounts without numeric conversion", async () => {
    const db = fixture(), exact = ((1n << 256n) - 1n).toString();
    db.records.set("audits/large", fundingRow("Deposit", { amountBaseUnits: exact, tokenDecimals: 0, tokenSymbol: "WHOLE", blockNumber: 0 }));
    db.records.set("audits/zero", fundingRow("Deposit", { amountBaseUnits: "0", tokenDecimals: 0 }));
    const result = await problemTrail(db, member, 0, { eventTypes: ["funding_status"] });
    const large = result.items.find((row) => row.id === "audit_large");
    assert.equal(large.funding.amountBaseUnits, exact); assert.equal(typeof large.funding.amountBaseUnits, "string");
    assert.equal(large.funding.tokenDecimals, 0); assert.equal(large.funding.blockNumber, 0);
    assert.equal(result.items.find((row) => row.id === "audit_zero").funding.amountBaseUnits, "0");
    assert.doesNotThrow(() => JSON.stringify(result));
  });

  it("reports missing or malformed legacy metadata as unavailable rather than inventing values", async () => {
    const db = fixture();
    const result = await problemTrail(db, member, 0, { eventTypes: ["funding_status"] });
    const legacy = result.items.find((row) => row.id === "audit_escrow-1");
    assert.deepEqual(legacy.funding, {
      eventType: null, amountBaseUnits: null, tokenAddress: null, tokenSymbol: null, tokenDecimals: null,
      actorAddress: null, actorLabel: "Private contributor", counterpartyAddress: null, counterpartyLabel: "Unavailable",
      transactionHash: tx, blockNumber: null, chainId: null,
    });
    db.records.set("audits/malformed", fundingRow("Deposit", { amountBaseUnits: Number.MAX_SAFE_INTEGER + 1,
      tokenAddress: "not a token", tokenSymbol: "", tokenDecimals: "18", actor: null, counterparty: "not a wallet",
      transactionHash: null, blockNumber: "101", chainId: null }));
    const malformed = (await problemTrail(db, member, 0)).items.find((row) => row.id === "audit_malformed");
    assert.equal(malformed.verification, "pending");
    assert.equal(malformed.funding.amountBaseUnits, null); assert.equal(malformed.funding.tokenDecimals, null);
    assert.equal(malformed.funding.tokenAddress, null); assert.equal(malformed.funding.transactionHash, null);
    assert.equal(malformed.funding.actorLabel, "Unavailable"); assert.equal(malformed.funding.counterpartyLabel, "Unavailable");
  });

  it("uses content ACL context without profile queries or hidden-author exposure", async () => {
    const db = fixture(), collections = [], original = db.collection;
    db.records.set("proposals/hidden", { researcherId: funder, postingOwnerId: owner, problemId: "problem-1",
      status: "submitted", moderationStatus: "hidden", title: "Secret title", createdAt: at("2026-09-02T00:00:00Z") });
    db.records.set("audits/hidden-release", fundingRow("TrancheReleased", { proposalId: "hidden", title: "Secret title", actor: funder, counterparty: funder }));
    db.collection = (name) => { collections.push(name); return original(name); };
    const result = await problemTrail(db, member, 0, { eventTypes: ["funding_status"] });
    const hidden = result.items.find((row) => row.id === "audit_hidden-release");
    assert.equal(hidden.funding.actorAddress, null); assert.equal(hidden.funding.counterpartyAddress, null);
    assert.equal(JSON.stringify(result).includes(funder), false); assert.equal(JSON.stringify(result).includes("Secret title"), false);
    assert.ok(collections.every(name => ["problems", "proposals", "matchingEvents", "comments", "moderationEvents", "audits"].includes(name)));
    const adminView = await problemTrail(db, admin, 1, { eventTypes: ["funding_status"] });
    assert.equal(adminView.items.find((row) => row.id === "audit_hidden-release").funding.actorAddress, funder);
  });
});

describe("audit trail proposal title privacy", () => {
  const currentTitle = "Current confidential design";
  const savedTitle = "Earlier confidential design";
  const withoutTitles = ({ description, entityLabel, ...event }) => event;

  it("redacts saved and current titles without changing financial history for unreadable children", async () => {
    for (const [status, moderationStatus, postingOwnerId, missing] of [
      ["moderated_hidden", "hidden", ""],
      ["moderated_removed", "removed", ""],
      ["draft", "visible", owner],
      ["submitted", "visible", owner, true],
      ["submitted", "hidden", owner], // Legacy documents may retain a sponsor ACL.
      ["submitted", "removed", owner],
    ]) {
      const db = fixture();
      const proposal = { ...db.records.get("proposals/proposal-1"), title: currentTitle, postingOwnerId: owner };
      db.records.set("proposals/proposal-1", proposal);
      const exact = ((1n << 256n) - 1n).toString();
      db.records.set("audits/private-deposit", fundingRow("Deposit", {
        title: savedTitle, amountBaseUnits: exact, tokenDecimals: 0, tokenSymbol: "WHOLE", blockNumber: 0,
      }));
      db.records.set("audits/private-refund", fundingRow("RefundClaimed", {
        title: savedTitle, counterparty: funder, amountBaseUnits: "0",
      }));
      const filters = { eventTypes: ["funding_status"], verification: "anchored",
        startDate: "2026-09-20", endDate: "2026-09-20" };
      const before = await problemTrail(db, member, 0, filters);
      if (missing) db.records.delete("proposals/proposal-1");
      else db.records.set("proposals/proposal-1", { ...proposal, status, moderationStatus, postingOwnerId });
      for (const uid of [member, owner]) {
        const result = await problemTrail(db, uid, 0, filters);
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes(savedTitle), false);
        assert.equal(serialized.includes(currentTitle), false);
        assert.equal(serialized.includes(funder), false);
        assert.deepEqual(result.items.map(withoutTitles), before.items.map(withoutTitles));
        assert.equal(result.count, before.count);
        assert.equal(result.nextCursor, before.nextCursor);
        assert.equal(result.truncated, before.truncated);
        for (const event of result.items) {
          assert.equal(event.entityLabel, "Proposal");
          assert.match(event.description, /for “a proposal”/);
        }
        for (const related of [savedTitle, currentTitle]) {
          const filtered = await problemTrail(db, uid, 0, { ...filters, related });
          assert.deepEqual(filtered.items, []);
          assert.equal(filtered.count, 0);
          assert.equal(JSON.stringify(filtered).includes(related), false);
        }
        const byId = await problemTrail(db, uid, 0, { ...filters, related: "proposal-1" });
        assert.deepEqual(byId, result);
      }
    }
  });

  it("keeps stale sponsor ACLs from exposing hidden submission and matching titles", async () => {
    const db = fixture();
    const proposal = db.records.get("proposals/proposal-1");
    db.records.set("proposals/proposal-1", { ...proposal, title: currentTitle,
      postingOwnerId: owner, moderationStatus: "hidden" });
    db.records.set("audits/escrow-1", fundingRow("TrancheReleased", { title: savedTitle }));
    for (const uid of [member, owner]) {
      const result = await problemTrail(db, uid, 0);
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes(currentTitle), false);
      assert.equal(serialized.includes(savedTitle), false);
      assert.equal(result.items.some((event) => event.eventType === "proposal_submitted"), false);
      assert.equal(result.items.find((event) => event.id === "match_selected").entityLabel, "Route medicines");
      assert.ok(result.items.some((event) => event.id === "audit_escrow-1"));
    }
    await assert.rejects(() => readAuditTrail({ db, uid: owner, profile: profile(0),
      input: { entityType: "proposal", entityId: "proposal-1" } }),
    (error) => error.code === "permission-denied");
  });

  it("uses current authorized titles for members and authors while preserving administrator history", async () => {
    const db = fixture();
    const proposal = { ...db.records.get("proposals/proposal-1"), title: currentTitle, postingOwnerId: owner };
    db.records.set("proposals/proposal-1", proposal);
    db.records.set("audits/escrow-1", fundingRow("Deposit", { title: savedTitle }));
    const inputs = [{ entityType: "problem", entityId: "problem-1" },
      { entityType: "proposal", entityId: "proposal-1" }];
    for (const input of inputs) {
      for (const uid of [member, owner, creator]) {
        const result = await readAuditTrail({ db, uid, profile: profile(0), input });
        assert.equal(JSON.stringify(result).includes(savedTitle), false);
        const event = result.items.find((item) => item.id === "audit_escrow-1");
        assert.equal(event.entityLabel, currentTitle);
        assert.ok(event.description.includes(currentTitle));
      }
    }
    const renamed = await problemTrail(db, member, 0, { related: savedTitle });
    assert.equal(renamed.count, 0);
    const current = await problemTrail(db, member, 0, { related: currentTitle, eventTypes: ["funding_status"] });
    assert.ok(current.items.some((event) => event.id === "audit_escrow-1"));

    db.records.set("proposals/proposal-1", { ...proposal, moderationStatus: "hidden", postingOwnerId: "" });
    for (const input of inputs) {
      const authorView = await readAuditTrail({ db, uid: creator, profile: profile(0), input });
      assert.equal(JSON.stringify(authorView).includes(savedTitle), false);
      assert.ok(JSON.stringify(authorView).includes(currentTitle));
    }
    for (const input of [...inputs, {}]) {
      const adminView = await readAuditTrail({ db, uid: admin, profile: profile(1), input });
      const event = adminView.items.find((item) => item.id === "audit_escrow-1");
      assert.ok(event.description.includes(savedTitle));
      assert.equal(event.entityLabel, currentTitle);
      assert.equal(event.funding.actorAddress, funder);
    }
    db.records.set("proposals/proposal-1", { ...proposal, status: "draft" });
    for (const uid of [creator, admin]) {
      const result = await problemTrail(db, uid, uid === admin ? 1 : 0);
      assert.equal(JSON.stringify(result).includes(currentTitle), false);
      assert.equal(result.items.some((event) => event.eventType === "proposal_submitted"), false);
      assert.equal(JSON.stringify(result).includes(savedTitle), uid === admin);
    }
  });

  it("hydrates targetId-only escrow rows through both supported document-read paths", async () => {
    for (const batched of [false, true]) {
      const db = fixture();
      if (batched) db.getAll = (...refs) => Promise.all(refs.map((ref) => ref.get()));
      db.records.set("proposals/legacy-child", { researcherId: creator, problemId: "problem-1",
        status: "submitted", title: currentTitle, createdAt: at("2026-09-01T00:00:00Z") });
      db.records.set("audits/legacy", fundingRow("Deposit", {
        proposalId: undefined, targetId: "legacy-child", title: savedTitle,
      }));
      const filters = { startDate: "2026-09-20", endDate: "2026-09-20" };
      const result = await problemTrail(db, member, 0, filters);
      const event = result.items.find((item) => item.id === "audit_legacy");
      assert.equal(event.proposalId, "legacy-child");
      assert.equal(event.entityLabel, currentTitle);
      assert.ok(event.description.includes(currentTitle));
      assert.equal(JSON.stringify(result).includes(savedTitle), false);
      db.records.delete("proposals/legacy-child");
      const missing = await problemTrail(db, member, 0, filters);
      assert.equal(JSON.stringify(missing).includes(savedTitle), false);
      assert.equal(JSON.stringify(missing).includes(currentTitle), false);
      assert.equal(missing.items.find((item) => item.id === "audit_legacy").entityLabel, "Proposal");
      assert.deepEqual(missing.items.map(withoutTitles), result.items.map(withoutTitles));
    }
  });

  it("hydrates every child from bounded sources while preserving financial events and pagination", async () => {
    const db = memoryDb({ "problems/problem-1": { ownerId: owner, status: "open", title: "Route medicines" } });
    const readIds = [], collection = db.collection;
    db.collection = (name) => {
      const source = collection(name);
      return { ...source, doc: (id) => {
        if (name === "proposals") readIds.push(id);
        return source.doc(id);
      } };
    };
    for (let index = 0; index < 41; index += 1) {
      const id = `child-${index}`;
      db.records.set(`proposals/${id}`, { researcherId: creator, problemId: "problem-1", status: "submitted",
        title: `Current design ${index}`, createdAt: at("2026-09-01T00:00:00Z") });
      db.records.set(`audits/history-${index}`, fundingRow("RefundClaimed", {
        proposalId: undefined, targetId: id, title: `Saved secret ${index}`, counterparty: funder,
      }));
    }
    const filters = { startDate: "2026-09-20", endDate: "2026-09-20", eventTypes: ["funding_status"] };
    const first = await problemTrail(db, member, 0, filters);
    assert.equal(new Set(readIds).size, 41);
    const second = await problemTrail(db, member, 0, { ...filters, cursor: first.nextCursor });
    assert.equal(first.count, 41); assert.equal(second.count, 41);
    assert.equal(first.items.length, 25); assert.equal(second.items.length, 16);
    const items = [...first.items, ...second.items];
    assert.equal(new Set(items.map((event) => event.id)).size, 41);
    assert.equal(JSON.stringify({ first, second }).includes("Saved secret"), false);
    assert.ok(items.every(event => event.entityLabel.startsWith("Current design")));
    assert.ok(items.every(event => event.funding.counterpartyAddress === null));
  });
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
    assert.equal(kinds.includes("moderation"), false);
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

  it("[BUT-ACM-82] shows a moderation decision to the content author and administrators only", async () => {
    const db = fixture();
    const salt = `0x${"ab".repeat(32)}`;
    const memberView = await problemTrail(db, member, 0);
    assert.equal(memberView.items.some((item) => item.eventType === "moderation"), false);
    assert.equal(JSON.stringify(memberView.items).includes(salt), false);
    assert.equal((await problemTrail(db, member, 0, { eventTypes: ["moderation"] })).count, 0);

    const ownerView = await problemTrail(db, owner, 0);
    const decision = ownerView.items.find((item) => item.id === "moderation_mod-1");
    assert.ok(decision);
    assert.equal(decision.moderationAction, "hidden");
    assert.equal(decision.contentType, "problem");
    assert.equal(decision.contentId, "problem-1");
    assert.equal(decision.reason, "abusive");
    assert.equal(decision.reasonLabel, "Abusive content");
    assert.match(decision.actorLabel, /^0xcccc/);
    assert.equal(decision.entityLabel, "Problem statement");
    assert.equal(decision.verification, "pending");
    assert.equal(decision.salt, salt);
    const packed = JSON.stringify(decision);
    assert.equal(packed.includes("do not quote"), false);
    assert.equal(packed.includes("Route medicines"), false);
    assert.equal(packed.includes("title"), false);
    assert.equal(packed.includes("body"), false);
    assert.equal(ownerView.items.some((item) => item.id === "moderation_mod-comment"), false);
    const filtered = await problemTrail(db, owner, 0, { eventTypes: ["moderation"] });
    assert.deepEqual(filtered.items.map((item) => item.id), ["moderation_mod-1"]);

    const authorView = await problemTrail(db, creator, 0);
    const comment = authorView.items.find((item) => item.id === "moderation_mod-comment");
    assert.ok(comment);
    assert.equal(comment.contentType, "comment");
    assert.equal(comment.contentId, "comment-9");
    assert.equal(comment.moderationAction, "removed");
    assert.equal(comment.reason, "spam");
    assert.equal(comment.entityLabel, "Comment");
    assert.equal(comment.verification, "anchored");
    assert.equal(comment.transactionHash, tx);
    assert.equal(JSON.stringify(comment).includes("quoted comment"), false);
    assert.equal(authorView.items.some((item) => item.id === "moderation_mod-1"), false);

    const adminView = await readAuditTrail({ db, uid: admin, profile: profile(1), input: {} });
    assert.ok(adminView.items.some((item) => item.id === "moderation_mod-1"));
    assert.ok(adminView.items.some((item) => item.id === "moderation_mod-comment"));
  });

  it("does not label events with titles of drafts or hidden proposals", async () => {
    const db = fixture();
    db.records.set("proposals/draft-proposal", {
      researcherId: creator, problemId: "problem-1", status: "draft", title: "Secret draft title",
      createdAt: at("2026-09-02T00:00:00Z"),
    });
    db.records.set("proposals/hidden-proposal", {
      researcherId: creator, problemId: "problem-1", status: "submitted", title: "Secret hidden title",
      moderationStatus: "hidden", createdAt: at("2026-09-03T00:00:00Z"),
    });
    db.records.set("matchingEvents/draft-selected", {
      type: "owner_selected", problemId: "problem-1", proposalId: "draft-proposal", actorId: owner,
      actorRole: "problem_owner", createdAt: at("2026-09-18T00:00:00Z"),
    });
    db.records.set("matchingEvents/hidden-selected", {
      type: "owner_selected", problemId: "problem-1", proposalId: "hidden-proposal", actorId: owner,
      actorRole: "problem_owner", createdAt: at("2026-09-19T00:00:00Z"),
    });
    const memberView = await problemTrail(db, member, 0);
    const memberText = JSON.stringify(memberView.items);
    assert.equal(memberText.includes("Secret draft title"), false);
    assert.equal(memberText.includes("Secret hidden title"), false);
    assert.equal(memberView.items.find((item) => item.proposalId === "draft-proposal").entityLabel, "Route medicines");
    assert.equal(memberView.items.find((item) => item.proposalId === "hidden-proposal").entityLabel, "Route medicines");

    const adminView = await problemTrail(db, admin, 1);
    const adminText = JSON.stringify(adminView.items);
    assert.equal(adminText.includes("Secret draft title"), false);
    assert.equal(adminText.includes("Secret hidden title"), true);
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

  it("shows a selected-proposal export to administrators and hides it from members", async () => {
    const db = fixture();
    db.records.set("audits/export-1", {
      type: "proposal_comment_export",
      actor: admin,
      actorName: "Ada Admin",
      scope: "posting",
      postingId: "problem-1",
      problemId: "problem-1",
      targetId: "problem-1",
      title: "Route medicines",
      timestamp: at("2026-10-27T00:00:00Z"),
    });
    const memberView = await problemTrail(db, member, 0);
    assert.equal(memberView.items.some((item) => item.label === "Selected proposals exported"), false);
    const adminView = await problemTrail(db, admin, 1);
    const event = adminView.items.find((item) => item.id === "audit_export-1");
    assert.equal(event.eventType, "governance");
    assert.equal(event.verification, "off_chain");
    assert.equal(event.problemId, "problem-1");
    assert.match(event.description, /Ada Admin exported accepted postings/);
    assert.match(event.description, /outside the platform/);
  });
});


describe("live child ACLs in parent audit recommendations", () => {
  it("fails closed for hidden, draft, missing and private-parent children with author/admin exceptions", async () => {
    for (const state of ["hidden", "draft", "missing", "private-parent"]) {
      const db = fixture();
      const child = db.records.get("proposals/proposal-1");
      if (state === "missing") db.records.delete("proposals/proposal-1");
      else db.records.set("proposals/proposal-1", { ...child,
        ...(state === "hidden" ? { moderationStatus: "hidden" } : {}),
        ...(state === "draft" ? { status: "draft" } : {}),
        ...(state === "private-parent" ? { problemId: "draft-1", postingOwnerId: "" } : {}),
      });
      const comment = db.records.get("comments/comment-1");
      db.records.set("comments/comment-1", { ...comment, authorId: funder });
      const filters = { eventTypes: ["evaluator_recommendation"] };
      assert.equal((await problemTrail(db, member, 0, filters)).count, 0, state);
      assert.ok((await problemTrail(db, funder, 0, filters)).items.some(row => row.commentId === "comment-1"), state);
      assert.ok((await problemTrail(db, admin, 1, filters)).items.some(row => row.commentId === "comment-1"), state);
    }
  });

  it("authorizes children beyond forty and caches live proposal and parent reads", async () => {
    const db = memoryDb({ "problems/problem-1": { ownerId: owner, status: "open", title: "Parent" } });
    const counts = new Map(), collection = db.collection;
    db.collection = name => {
      const source = collection(name);
      return { ...source, doc: id => {
        const ref = source.doc(id), get = ref.get;
        return { ...ref, get: async () => { counts.set(ref.path, (counts.get(ref.path) || 0) + 1); return get(); } };
      } };
    };
    for (let index = 0; index < 55; index++) {
      db.records.set(`proposals/child-${index}`, { problemId: "problem-1", researcherId: creator,
        status: "submitted", moderationStatus: index === 54 ? "hidden" : "visible", title: `Design ${index}` });
      db.records.set(`comments/recommendation-${index}`, { problemId: "problem-1", proposalId: `child-${index}`,
        authorId: creator, recommendation: "recommend_with_revisions", moderationStatus: "visible", createdAt: at("2026-09-10T00:00:00Z") });
    }
    const result = await problemTrail(db, member, 0, { eventTypes: ["evaluator_recommendation"] });
    assert.equal(result.count, 54);
    assert.equal(counts.get("problems/problem-1"), 1);
    assert.ok([...counts.values()].every(count => count === 1));
    assert.equal(counts.size, 56);
  });
});
