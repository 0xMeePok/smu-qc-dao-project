import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updates: [] }));

vi.mock("../../src/lib/postings.js", () => ({
  postingAuditPayload: (posting) => ({ title: posting.title, expiresAt: posting.expiresAt }),
  updatePostingAudit: async ({ audit }) => { mocks.updates.push(audit); },
}));

const { anchorPostingAudit, preparePostingAudit } = await import("../../src/lib/postingAudit.js");
const { DEFAULT_AUDIT_REGISTRY_ADDRESS } = await import("../../src/config/auditRegistry.js");

const TX = `0x${"3".repeat(64)}`;
const ACCOUNT = `0x${"a".repeat(40)}`;

function posting(audit) {
  return {
    id: "posting123",
    title: "Cold-chain optimisation",
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    audit,
  };
}

function queuedAudit() {
  const prepared = preparePostingAudit(posting());
  return prepared.audit;
}

function configuredReads(value = posting()) {
  const prepared = preparePostingAudit(value).prepared;
  return async ({ functionName }) => {
    if (functionName === "getOpportunity") {
      return {
        kind: 0,
        contentHash: prepared.contentHash,
        expiresAt: prepared.args[3],
      };
    }
    if (functionName === "anchorCount") return 1n;
    if (functionName === "anchorAt") return { contentHash: prepared.contentHash };
    throw new Error(`unexpected read: ${functionName}`);
  };
}

beforeEach(() => { mocks.updates = []; });

describe("QCDAO-79 posting audit recovery", () => {
  it("writes once and persists the ordered transaction lifecycle", async () => {
    let writes = 0;
    const adapters = {
      writeContract: async () => { writes += 1; return TX; },
      waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 88n }),
      readContract: configuredReads(),
    };

    const result = await anchorPostingAudit(posting(queuedAudit()), {
      account: ACCOUNT,
      adapters,
    });

    expect(writes).toBe(1);
    expect(mocks.updates.map(({ status }) => status)).toEqual([
      "queued", "submitted", "pending", "confirmed",
    ]);
    expect(result.transactionHash).toBe(TX);
    expect(result.blockNumber).toBe(88);
    expect(result.contractAddress).toBeUndefined();
  });

  it("resumes a known transaction hash without rebroadcasting", async () => {
    let writes = 0;
    let waits = 0;
    const adapters = {
      writeContract: async () => { writes += 1; return TX; },
      waitForTransactionReceipt: async ({ hash }) => {
        waits += 1;
        expect(hash).toBe(TX);
        return { status: "success", blockNumber: 99n };
      },
      readContract: configuredReads(),
    };
    const known = {
      ...queuedAudit(), status: "failed", transactionHash: TX,
      attemptCount: 1, lastError: "RPC timeout",
    };

    const result = await anchorPostingAudit(posting(known), { account: ACCOUNT, adapters });

    expect(writes).toBe(0);
    expect(waits).toBe(1);
    expect(mocks.updates.map(({ status }) => status)).toEqual(["pending", "confirmed"]);
    expect(result.blockNumber).toBe(99);
  });

  it("ignores a contract address supplied by Firestore", async () => {
    let writeRequest;
    const stored = {
      ...queuedAudit(),
      contractAddress: `0x${"c".repeat(40)}`,
    };
    await anchorPostingAudit(posting(stored), {
      account: ACCOUNT,
      adapters: {
        writeContract: async (request) => { writeRequest = request; return TX; },
        waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 100n }),
        readContract: configuredReads(),
      },
    });

    expect(writeRequest.address).toBe(DEFAULT_AUDIT_REGISTRY_ADDRESS);
    expect(mocks.updates.every((audit) => audit.contractAddress === undefined)).toBe(true);
  });
});
