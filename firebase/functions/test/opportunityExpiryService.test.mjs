import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXPIRY_REASONS } from "../opportunityExpiry.js";
import { expireOpportunity, lapseDueOpportunities } from "../opportunityExpiryService.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const PAST = new Date("2026-09-12T11:59:00.000Z");
const FUTURE = new Date("2026-09-12T12:01:00.000Z");

function clone(value) {
  return structuredClone(value);
}

function millis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return value.toMillis();
  return value;
}

function compareKeys(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

// Supports the query shapes the service uses: chained where, orderBy, cursors, limit, select, sum.
function memoryFirestore(entries = [], { beforeTransaction, failOnSetPath } = {}) {
  const store = new Map(entries.map(([path, value]) => [path, clone(value)]));
  const reads = [];
  let autoId = 0;
  let transactions = 0;

  function snapshot(path) {
    return {
      id: path.slice(path.lastIndexOf("/") + 1),
      exists: store.has(path),
      data: () => (store.has(path) ? clone(store.get(path)) : undefined),
    };
  }

  function ref(path) {
    return {
      path,
      async get() {
        return snapshot(path);
      },
      async set(data, options = {}) {
        const previous = options.merge && store.has(path) ? store.get(path) : {};
        store.set(path, { ...clone(previous), ...clone(data) });
      },
      async delete() {
        store.delete(path);
      },
    };
  }

  function query(name, state = { filters: [], orders: [], limit: Infinity, after: null }) {
    const keyOf = (row) => state.orders.map((field) => (
      typeof field === "string" ? millis(row.data()[field]) : row.id));
    const matches = (data) => state.filters.every(([field, operator, value]) => {
      if (operator === "==") return data[field] === value;
      if (operator === "in") return value.includes(data[field]);
      if (operator === "<=") return millis(data[field]) <= millis(value);
      throw new Error(`Unsupported operator ${operator}`);
    });
    const run = () => {
      const prefix = `${name}/`;
      let rows = [...store.entries()]
        .filter(([path, data]) => path.startsWith(prefix)
          && !path.slice(prefix.length).includes("/")
          && matches(data))
        .map(([path]) => snapshot(path));
      rows.sort((left, right) => compareKeys(keyOf(left), keyOf(right)));
      if (state.after) rows = rows.filter((row) => compareKeys(keyOf(row), state.after) > 0);
      return rows.slice(0, state.limit);
    };
    const next = (patch) => query(name, { ...state, ...patch });
    return {
      where: (field, operator, value) => next({ filters: [...state.filters, [field, operator, value]] }),
      orderBy: (field) => next({ orders: [...state.orders, field] }),
      select: () => next({}),
      limit: (count) => next({ limit: count }),
      startAfter: (...values) => next({
        after: values.length === 1 && typeof values[0]?.data === "function"
          ? keyOf(values[0])
          : values.map(millis),
      }),
      async get() {
        reads.push(name);
        const docs = run();
        return { docs, empty: docs.length === 0 };
      },
      aggregate: () => ({
        async get() {
          reads.push(`${name}:aggregate`);
          const total = run().reduce((sum, row) => sum + (Number(row.data().amount) || 0), 0);
          return { data: () => ({ total }) };
        },
      }),
    };
  }

  function collection(name) {
    return {
      doc(id) {
        return ref(`${name}/${id ?? `auto-${++autoId}`}`);
      },
      ...query(name),
    };
  }

  const db = {
    collection,
    async runTransaction(callback) {
      transactions += 1;
      beforeTransaction?.(store);
      const operations = [];
      const tx = {
        get: async (target) => (target?.path ? snapshot(target.path) : target.get()),
        update(documentRef, data) {
          operations.push(() => {
            if (!store.has(documentRef.path)) throw new Error("missing document");
            Object.assign(store.get(documentRef.path), clone(data));
          });
        },
        set(documentRef, data, options = {}) {
          if (documentRef.path === failOnSetPath) throw new Error("injected transaction write failure");
          operations.push(() => {
            const previous = options.merge && store.has(documentRef.path)
              ? store.get(documentRef.path)
              : {};
            store.set(documentRef.path, { ...clone(previous), ...clone(data) });
          });
        },
      };
      const output = await callback(tx);
      operations.forEach((operation) => operation());
      return output;
    },
  };

  return { db, store, reads: () => [...reads], transactionCount: () => transactions };
}

function openProblem(overrides = {}) {
  return {
    title: "Cold-chain routing",
    status: "open",
    expiresAt: PAST,
    amount: 1000,
    ...overrides,
  };
}

function recordsForNormalExpiry(problem = openProblem()) {
  return [
    ["problems/problem-1", problem],
    ["funding/funding-1", { problemId: "problem-1", status: "pledged", amount: 1000 }],
    ["proposals/proposal-1", { problemId: "problem-1", status: "accepted" }],
    ["evaluations/evaluation-1", { proposalId: "proposal-1", status: "accepted" }],
  ];
}

function pathValues(store, prefix) {
  return [...store.entries()].filter(([path]) => path.startsWith(prefix));
}

describe("opportunity expiry persistence", () => {
  it("persists a scheduled lapse, durable audit, and pending refund hand-off together", async () => {
    const database = memoryFirestore(recordsForNormalExpiry());

    const saved = await expireOpportunity({
      db: database.db,
      problemId: "problem-1",
      now: NOW,
      source: "scheduled",
    });

    assert.deepEqual(saved, {
      changed: true,
      outcome: "expired",
      reason: EXPIRY_REASONS.NO_SOLUTION_SELECTED,
      source: "scheduled",
    });
    assert.deepEqual(database.store.get("problems/problem-1"), {
      ...openProblem(),
      status: "expired",
      expiryReason: EXPIRY_REASONS.NO_SOLUTION_SELECTED,
      expirySource: "scheduled",
      expiryActor: "system",
      expiryActorName: "System scheduler",
      expiredAt: NOW,
      updatedAt: NOW,
    });

    const [[auditPath, audit]] = pathValues(database.store, "audits/");
    assert.match(auditPath, /^audits\/auto-\d+$/);
    assert.equal(audit.type, "opportunity_expired");
    assert.equal(audit.source, "scheduled");
    assert.equal(audit.reason, EXPIRY_REASONS.NO_SOLUTION_SELECTED);
    assert.equal(audit.actor, "system");
    assert.equal(audit.target, "problem-1");
    assert.equal(audit.targetName, "Cold-chain routing");
    assert.deepEqual(database.store.get("escrowRefundTriggers/problem-1"), {
      problemId: "problem-1",
      status: "pending",
      source: "scheduled",
      reason: EXPIRY_REASONS.NO_SOLUTION_SELECTED,
      trigger: "opportunity_expired",
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("leaves future and successfully completed opportunities live without a transaction", async () => {
    const future = memoryFirestore(recordsForNormalExpiry(openProblem({ expiresAt: FUTURE })));
    assert.deepEqual(await expireOpportunity({
      db: future.db, problemId: "problem-1", now: NOW,
    }), { changed: false, outcome: "not-due" });
    assert.equal(future.transactionCount(), 0);
    assert.equal(pathValues(future.store, "audits/").length, 0);

    const selected = memoryFirestore(recordsForNormalExpiry(openProblem({
      acceptedProposalId: "proposal-1",
    })));
    assert.deepEqual(await expireOpportunity({
      db: selected.db, problemId: "problem-1", now: NOW,
    }), { changed: false, outcome: "no-expiry-reason" });
    assert.equal(selected.transactionCount(), 0);
    assert.equal(selected.store.get("problems/problem-1").status, "open");
  });

  it("sums live funding instead of loading every pledge, and stops at the first unmet requirement", async () => {
    const pledges = Array.from({ length: 250 }, (_, index) => [
      `funding/funding-${index}`,
      { problemId: "problem-1", status: index === 0 ? "cancelled" : "pledged", amount: 4 },
    ]);
    const database = memoryFirestore([
      ["problems/problem-1", openProblem()],
      ...pledges,
      ["proposals/proposal-1", { problemId: "problem-1", status: "submitted" }],
    ]);

    const saved = await expireOpportunity({ db: database.db, problemId: "problem-1", now: NOW });
    assert.equal(saved.reason, EXPIRY_REASONS.FUNDING_REQUIREMENT_NOT_MET);
    assert.ok(database.reads().includes("funding:aggregate"));
    assert.ok(!database.reads().includes("funding"), "pledges are summed, not fetched");
    assert.ok(!database.reads().some((name) => name === "proposals" || name === "evaluations"));
  });

  it("lapses a posting with more related records than any page instead of deferring it", async () => {
    const proposals = Array.from({ length: 650 }, (_, index) => [
      `proposals/p-${String(index).padStart(4, "0")}`,
      { problemId: "problem-1", status: "rejected" },
    ]);
    const database = memoryFirestore([
      ["problems/problem-1", openProblem()],
      ["funding/funding-1", { problemId: "problem-1", status: "pledged", amount: 1000 }],
      ...proposals,
      ["evaluations/evaluation-last", { proposalId: "p-0649", status: "submitted" }],
    ]);

    const saved = await expireOpportunity({ db: database.db, problemId: "problem-1", now: NOW });
    assert.equal(saved.reason, EXPIRY_REASONS.EVALUATION_NOT_COMPLETED);
    assert.equal(database.store.get("problems/problem-1").status, "expired");
  });

  it("finds evaluations through their proposal relationship before choosing the lapse reason", async () => {
    const database = memoryFirestore([
      ["problems/problem-1", openProblem()],
      ["funding/funding-1", { problemId: "problem-1", status: "pledged", amount: 1000 }],
      ["proposals/proposal-1", { problemId: "problem-1", status: "rejected" }],
      ["evaluations/evaluation-1", { proposalId: "proposal-1", status: "submitted" }],
    ]);

    const saved = await expireOpportunity({
      db: database.db, problemId: "problem-1", now: NOW,
    });
    assert.equal(saved.reason, EXPIRY_REASONS.EVALUATION_NOT_COMPLETED);
  });

  it("only lets an administrator force expiry with an exact prescribed reason", async () => {
    const database = memoryFirestore([
      ["problems/problem-1", openProblem({ expiresAt: FUTURE })],
    ]);

    await assert.rejects(
      () => expireOpportunity({
        db: database.db,
        problemId: "problem-1",
        now: NOW,
        source: "manual",
        forceReason: "expired_for_some_other_reason",
      }),
      /prescribed expiry reasons/,
    );
    assert.equal(database.store.get("problems/problem-1").status, "open");

    const saved = await expireOpportunity({
      db: database.db,
      problemId: "problem-1",
      now: NOW,
      source: "manual",
      forceReason: EXPIRY_REASONS.EVALUATION_NOT_COMPLETED,
      actorId: "admin-1",
      actorName: "Ada Admin",
    });
    assert.equal(saved.changed, true);
    assert.equal(saved.reason, EXPIRY_REASONS.EVALUATION_NOT_COMPLETED);
    assert.equal(database.store.get("problems/problem-1").expirySource, "manual");
    const [[, audit]] = pathValues(database.store, "audits/");
    assert.equal(audit.action, "OPPORTUNITY_FORCE_EXPIRED");
    assert.equal(audit.actor, "admin-1");
  });

  it("is idempotent and rereads status inside the transaction before writing", async () => {
    const expired = memoryFirestore([
      ["problems/problem-1", openProblem({ status: "expired" })],
    ]);
    assert.deepEqual(await expireOpportunity({
      db: expired.db, problemId: "problem-1", now: NOW,
    }), { changed: false, outcome: "already-expired" });
    assert.equal(expired.transactionCount(), 0);

    const raced = memoryFirestore(recordsForNormalExpiry(), {
      beforeTransaction(store) {
        store.set("problems/problem-1", openProblem({ status: "expired" }));
      },
    });
    assert.deepEqual(await expireOpportunity({
      db: raced.db, problemId: "problem-1", now: NOW,
    }), { changed: false, outcome: "already-expired" });
    assert.equal(raced.transactionCount(), 1);
    assert.equal(pathValues(raced.store, "audits/").length, 0);
    assert.equal(raced.store.has("escrowRefundTriggers/problem-1"), false);
  });

  it("does not commit the status or refund trigger if the audit write cannot join the transaction", async () => {
    const database = memoryFirestore(recordsForNormalExpiry(), {
      failOnSetPath: "audits/auto-1",
    });

    await assert.rejects(
      () => expireOpportunity({
        db: database.db, problemId: "problem-1", now: NOW,
      }),
      /injected transaction write failure/,
    );
    assert.deepEqual(database.store.get("problems/problem-1"), openProblem());
    assert.equal(database.store.has("escrowRefundTriggers/problem-1"), false);
  });
});

describe("lapsing every due opportunity", () => {
  const due = (count, prefix = "p") => Array.from({ length: count }, (_, index) => [
    `problems/${prefix}-${String(index).padStart(4, "0")}`,
    openProblem({ expiresAt: new Date(PAST.getTime() - (count - index) * 1000) }),
  ]);
  const expiredCount = (store) => pathValues(store, "problems/")
    .filter(([, data]) => data.status === "expired").length;

  it("visits every due posting across pages and both live statuses, not just the oldest page", async () => {
    const submitted = due(120, "s").map(([path, data]) => [path, { ...data, status: "submitted" }]);
    const database = memoryFirestore([...due(450), ...submitted, ["problems/live", openProblem({ expiresAt: FUTURE })]]);

    const summary = await lapseDueOpportunities({ db: database.db, now: NOW, pageSize: 100, concurrency: 7 });

    assert.equal(summary.complete, true);
    assert.equal(summary.expired, 570);
    assert.equal(expiredCount(database.store), 570);
    assert.equal(database.store.get("problems/live").status, "open");
    assert.equal(database.store.has("jobState/opportunityLapse"), false);
  });

  it("resumes from a checkpoint when the time budget runs out, so a backlog is worked through", async () => {
    // Submitted is scanned first, so the one-batch budget is spent on these, not an empty status.
    const database = memoryFirestore(due(30).map(([path, data]) => [path, { ...data, status: "submitted" }]));
    const run = () => {
      let calls = 0;
      return lapseDueOpportunities({
        db: database.db, now: NOW, pageSize: 10, concurrency: 10, budgetMs: 25, clock: () => (calls++) * 10,
      });
    };

    const first = await run();
    assert.equal(first.expired, 10);
    assert.equal(first.complete, false);
    assert.equal(database.store.get("jobState/opportunityLapse").status, "submitted");

    const second = await run();
    assert.equal(second.resumed, true);
    await run();
    assert.equal(expiredCount(database.store), 30);

    const last = await run();
    assert.equal(last.complete, true);
    assert.equal(database.store.has("jobState/opportunityLapse"), false);
  });

  it("does not let a posting that cannot lapse block the ones behind it", async () => {
    const database = memoryFirestore([
      ["problems/a-held", openProblem({ expiresAt: new Date(PAST.getTime() - 999_000), acceptedProposalId: "chosen" })],
      ["funding/funding-held", { problemId: "a-held", status: "pledged", amount: 1000 }],
      ...due(3),
    ]);

    const summary = await lapseDueOpportunities({ db: database.db, now: NOW, pageSize: 1, concurrency: 1 });

    assert.equal(summary.complete, true);
    assert.equal(summary.expired, 3);
    assert.equal(database.store.get("problems/a-held").status, "open");
  });

  it("keeps going when one posting fails and picks it up on a later run", async () => {
    const database = memoryFirestore(due(5));
    const original = database.db.runTransaction;
    let calls = 0;
    database.db.runTransaction = async (callback) => {
      calls += 1;
      if (calls === 1) throw new Error("contention");
      return original(callback);
    };
    const failures = [];

    const summary = await lapseDueOpportunities({
      db: database.db, now: NOW, concurrency: 1, onError: (problemId) => failures.push(problemId),
    });
    assert.equal(summary.failed, 1);
    assert.equal(summary.expired, 4);
    assert.deepEqual(failures, ["p-0000"]);

    database.db.runTransaction = original;
    const retry = await lapseDueOpportunities({ db: database.db, now: NOW, onError: () => {} });
    assert.equal(retry.expired, 1);
    assert.equal(expiredCount(database.store), 5);
  });
});
