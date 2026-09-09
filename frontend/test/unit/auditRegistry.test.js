import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUDIT_HASH_SCHEME,
  AUDIT_REGISTRY_ABI,
  AUDIT_REGISTRY_ADDRESS,
  AUDIT_REGISTRY_CHAIN_ID,
  DEFAULT_AUDIT_REGISTRY_ADDRESS,
  OPPORTUNITY_KIND,
} from "../../src/config/auditRegistry.js";
import {
  AUDIT_ENTITY_TYPE,
  canonicalizeAuditPayload,
  classifyAuditError,
  commitOpportunityAudit,
  commitProposalAudit,
  createAuditEntityId,
  hashAuditPayload,
  opportunityEntityId,
  prepareOpportunityCommit,
  prepareOpportunityUpdate,
  prepareOpportunityWithdrawal,
  prepareProposalCommit,
  prepareProposalUpdate,
  prepareProposalWithdrawal,
  proposalEntityId,
  readOpportunityRevisionIndex,
  updateProposalAudit,
  verifyOpportunityAudit,
  verifyProposalAudit,
  writeOpportunityAudit,
} from "../../src/lib/auditRegistry.js";

const CONTRACT = DEFAULT_AUDIT_REGISTRY_ADDRESS;
const ACCOUNT = `0x${"a".repeat(40)}`;
const TX_HASH = `0x${"2".repeat(64)}`;

const OPPORTUNITY_PAYLOAD = {
  title: "Cold-chain",
  amount: 80_000,
  categories: ["quantum", "ai"],
  expiresAt: new Date("2026-12-01T00:00:00.000Z"),
};

function unused() {
  throw new Error("Unexpected adapter call");
}

describe("AuditRegistry canonical hash scheme", () => {
  it("uses the existing fixed-hash AuditRegistry write signatures", () => {
    const writes = AUDIT_REGISTRY_ABI.filter((entry) =>
      ["commitOpportunity", "updateOpportunity", "withdrawOpportunity",
        "commitProposal", "updateHashes", "withdrawProposal"].includes(entry.name));
    assert.equal(AUDIT_REGISTRY_CHAIN_ID, 421614);
    assert.match(DEFAULT_AUDIT_REGISTRY_ADDRESS, /^0x[0-9a-fA-F]{40}$/);
    assert.notEqual(DEFAULT_AUDIT_REGISTRY_ADDRESS.toLowerCase(), `0x${"0".repeat(40)}`);
    assert.equal(AUDIT_REGISTRY_ADDRESS, DEFAULT_AUDIT_REGISTRY_ADDRESS);
    assert.equal(AUDIT_HASH_SCHEME, 1);
    assert.equal(writes.length, 6);
    assert.equal(writes.find((entry) => entry.name === "commitOpportunity").inputs.length, 4);
    assert.equal(writes.find((entry) => entry.name === "updateOpportunity").inputs.length, 3);
    assert.equal(writes.find((entry) => entry.name === "withdrawOpportunity").inputs.length, 2);
    assert.equal(writes.find((entry) => entry.name === "commitProposal").inputs.length, 5);
    assert.equal(writes.find((entry) => entry.name === "updateHashes").inputs.length, 4);
    assert.equal(writes.find((entry) => entry.name === "withdrawProposal").inputs.length, 2);
    assert.equal(AUDIT_REGISTRY_ABI.some((entry) =>
      ["recordEvaluation", "evaluationAt", "evaluationCount"].includes(entry.name)), false);
  });

  it("matches the canonical JSON v1 golden vector", () => {
    const canonical = canonicalizeAuditPayload(
      AUDIT_ENTITY_TYPE.OPPORTUNITY,
      OPPORTUNITY_PAYLOAD,
    );
    assert.equal(
      canonical,
      "{\"entityType\":\"opportunity\",\"hashScheme\":1,\"payload\":{"
        + "\"amount\":80000,\"categories\":[\"quantum\",\"ai\"],"
        + "\"expiresAt\":{\"$timestamp\":\"2026-12-01T00:00:00.000Z\"},"
        + "\"title\":\"Cold-chain\"}}",
    );
    assert.equal(
      hashAuditPayload(AUDIT_ENTITY_TYPE.OPPORTUNITY, OPPORTUNITY_PAYLOAD),
      "0xd3a8d4a747fcff10f509e349a7324bb7fb885cd40dcb6cad9eb6906e60702822",
    );
  });

  it("sorts object keys recursively but preserves meaningful array order", () => {
    const first = { z: { beta: 2, alpha: 1 }, a: ["one", "two"] };
    const reordered = { a: ["one", "two"], z: { alpha: 1, beta: 2 } };
    const changedArray = { a: ["two", "one"], z: { alpha: 1, beta: 2 } };
    assert.equal(
      hashAuditPayload(AUDIT_ENTITY_TYPE.OPPORTUNITY, first),
      hashAuditPayload(AUDIT_ENTITY_TYPE.OPPORTUNITY, reordered),
    );
    assert.notEqual(
      hashAuditPayload(AUDIT_ENTITY_TYPE.OPPORTUNITY, first),
      hashAuditPayload(AUDIT_ENTITY_TYPE.OPPORTUNITY, changedArray),
    );
  });

  it("domain-separates stable ids for each workflow entity", () => {
    assert.equal(
      opportunityEntityId("posting-123"),
      "0xe7723eb1e163289bae7bee7b590d4979d6fb236e4bfed69069cb081e419f0cde",
    );
    assert.equal(
      proposalEntityId("proposal-123"),
      "0xdd640ef58b0858436bdb20ee825e3833ab25c1829f2c27a8dbe657d6874ec2d7",
    );
    assert.notEqual(
      createAuditEntityId(AUDIT_ENTITY_TYPE.OPPORTUNITY, "same-id"),
      createAuditEntityId(AUDIT_ENTITY_TYPE.PROPOSAL, "same-id"),
    );
  });
});

describe("AuditRegistry argument preparation", () => {
  it("maps an opportunity to the existing contract arguments", () => {
    const prepared = prepareOpportunityCommit({
      recordId: "posting-123",
      payload: OPPORTUNITY_PAYLOAD,
      kind: "business-problem",
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    });
    assert.equal(prepared.functionName, "commitOpportunity");
    assert.equal(prepared.args[0], opportunityEntityId("posting-123"));
    assert.equal(prepared.args[1], OPPORTUNITY_KIND.BUSINESS_PROBLEM);
    assert.equal(prepared.args[2], prepared.contentHash);
    assert.equal(prepared.args[3], 1_796_083_200n);
    assert.equal(prepared.args.length, 4);
  });

  it("maps an already-anchored opportunity onto updateOpportunity", () => {
    const update = prepareOpportunityUpdate({
      recordId: "posting-123",
      payload: OPPORTUNITY_PAYLOAD,
      kind: "business-problem",
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    });
    assert.equal(update.functionName, "updateOpportunity");
    assert.deepEqual(update.args, [
      opportunityEntityId("posting-123"),
      update.contentHash,
      1_796_083_200n,
    ]);
  });

  it("prepares separate proposal and solution hashes", () => {
    const proposal = prepareProposalCommit({
      recordId: "proposal-123",
      opportunityRecordId: "posting-123",
      proposalPayload: { title: "Proposal", amount: 12_000 },
      solutionPayload: { method: "Annealing" },
      expectedOpportunityRevisionIndex: 3,
    });
    assert.equal(proposal.functionName, "commitProposal");
    assert.equal(proposal.args[0], proposal.entityId);
    assert.equal(proposal.args[1], opportunityEntityId("posting-123"));
    assert.equal(proposal.args[2], proposal.proposalHash);
    assert.equal(proposal.args[3], proposal.solutionHash);
    assert.equal(proposal.args[4], 3);
    assert.equal(proposal.args.length, 5);
    assert.notEqual(proposal.proposalHash, proposal.solutionHash);
  });

  it("requires the opportunity revision the researcher viewed", () => {
    assert.throws(() => prepareProposalCommit({
      recordId: "proposal-123",
      opportunityRecordId: "posting-123",
      proposalPayload: { title: "Proposal" },
      solutionPayload: { method: "Annealing" },
    }), /revision index/);
  });

  it("prepares proposal updates against the same viewed opportunity revision", () => {
    const update = prepareProposalUpdate({
      recordId: "proposal-123",
      opportunityRecordId: "posting-123",
      proposalPayload: { title: "Proposal v2" },
      solutionPayload: { method: "Annealing v2" },
      expectedOpportunityRevisionIndex: 3,
    });
    assert.equal(update.functionName, "updateHashes");
    assert.deepEqual(update.args, [
      update.entityId,
      update.proposalHash,
      update.solutionHash,
      3,
    ]);
  });

  it("QCDAO-57 commits to the withdrawal reason without publishing it", () => {
    const withdrawal = (reason, researcherId = "0xABCdef0000000000000000000000000000000000") =>
      prepareProposalWithdrawal({ recordId: "proposal-123", researcherId, reason });
    const stated = withdrawal("The costing was wrong.");
    assert.equal(stated.functionName, "withdrawProposal");
    assert.deepEqual(stated.args, [stated.entityId, stated.contentHash]);
    // AuditRegistry.withdrawProposal rejects a zero evidence hash.
    assert.match(stated.contentHash, /^0x[0-9a-f]{64}$/);
    assert.notEqual(stated.contentHash, `0x${"0".repeat(64)}`);
    // The reason is the disputed part, so a reworded one is a different hash and
    // cannot be passed off as what was originally given.
    assert.notEqual(withdrawal("A more flattering reason.").contentHash, stated.contentHash);
    // Wallet casing is not part of the claim.
    assert.equal(withdrawal("The costing was wrong.", "0xabcdef0000000000000000000000000000000000").contentHash, stated.contentHash);
    // The same proposal always anchors under the same entity id.
    assert.equal(stated.entityId, proposalEntityId("proposal-123"));
    assert.throws(() => withdrawal("   "), /reason is required/);
  });

  it("QCDAO-57 commits to the opportunity withdrawal reason without publishing it", () => {
    const withdrawal = (reason, ownerId = "0xABCdef0000000000000000000000000000000000") =>
      prepareOpportunityWithdrawal({ recordId: "posting-123", ownerId, reason });
    const stated = withdrawal("The budget was withdrawn.");
    assert.equal(stated.functionName, "withdrawOpportunity");
    assert.deepEqual(stated.args, [stated.entityId, stated.contentHash]);
    assert.match(stated.contentHash, /^0x[0-9a-f]{64}$/);
    assert.notEqual(stated.contentHash, `0x${"0".repeat(64)}`);
    assert.notEqual(withdrawal("A more flattering reason.").contentHash, stated.contentHash);
    assert.equal(withdrawal("The budget was withdrawn.", "0xabcdef0000000000000000000000000000000000").contentHash, stated.contentHash);
    assert.equal(stated.entityId, opportunityEntityId("posting-123"));
    assert.throws(() => withdrawal("   "), /reason is required/);
  });
});

describe("AuditRegistry transaction lifecycle", () => {
  it("writes once, retries only receipt polling, and awaits statuses in order", async () => {
    const prepared = prepareOpportunityCommit({
      recordId: "posting-123",
      payload: OPPORTUNITY_PAYLOAD,
      kind: 0,
      expiresAt: 1_796_083_200,
    });
    const calls = { writes: [], waits: 0 };
    const statuses = [];
    const adapters = {
      writeContract: async (request) => {
        calls.writes.push(request);
        return TX_HASH;
      },
      waitForTransactionReceipt: async () => {
        calls.waits += 1;
        if (calls.waits < 3) throw new Error("HTTP timeout while polling receipt");
        return { status: "success", blockNumber: 99n };
      },
      readContract: unused,
    };

    const result = await commitOpportunityAudit(prepared, {
      address: CONTRACT,
      account: ACCOUNT,
      adapters,
      maxReceiptRetries: 2,
      onStatus: async (entry) => {
        await Promise.resolve();
        statuses.push(entry.status);
      },
    });

    assert.equal(calls.writes.length, 1, "a polling retry must never rebroadcast");
    assert.equal(calls.waits, 3);
    assert.equal(calls.writes[0].functionName, "commitOpportunity");
    assert.deepEqual(calls.writes[0].args, prepared.args);
    assert.equal(calls.writes[0].address, CONTRACT);
    assert.equal(calls.writes[0].chainId, 421614);
    assert.deepEqual(statuses, ["queued", "submitted", "pending", "pending", "pending", "confirmed"]);
    assert.equal(result.transactionHash, TX_HASH);
    assert.equal(result.blockNumber, 99n);
  });

  it("edits a live opportunity with updateOpportunity instead of a second commit", async () => {
    const prepared = prepareOpportunityCommit({
      recordId: "posting-123",
      payload: OPPORTUNITY_PAYLOAD,
      kind: 0,
      expiresAt: 1_796_083_200,
    });
    const calls = [];
    const result = await writeOpportunityAudit(prepared, {
      address: CONTRACT,
      account: ACCOUNT,
      adapters: {
        writeContract: async (request) => {
          calls.push(request.functionName);
          return TX_HASH;
        },
        waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 12n }),
        readContract: async ({ functionName }) => {
          if (functionName === "opportunityRevisionCount") return 1n;
          if (functionName === "getOpportunity") {
            return { contentHash: `0x${"9".repeat(64)}` };
          }
          return unused();
        },
      },
    });
    assert.deepEqual(calls, ["updateOpportunity"]);
    assert.equal(result.transactionHash, TX_HASH);
  });

  it("publishes a new opportunity with commitOpportunity", async () => {
    const prepared = prepareOpportunityCommit({
      recordId: "posting-123",
      payload: OPPORTUNITY_PAYLOAD,
      kind: 0,
      expiresAt: 1_796_083_200,
    });
    const calls = [];
    await writeOpportunityAudit(prepared, {
      address: CONTRACT,
      account: ACCOUNT,
      adapters: {
        writeContract: async (request) => {
          calls.push(request.functionName);
          return TX_HASH;
        },
        waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 8n }),
        readContract: async ({ functionName }) => {
          if (functionName === "opportunityRevisionCount") return 0n;
          return unused();
        },
      },
    });
    assert.deepEqual(calls, ["commitOpportunity"]);
  });

  it("refuses a no-op updateOpportunity instead of opening the wallet", async () => {
    const prepared = prepareOpportunityCommit({
      recordId: "posting-123",
      payload: OPPORTUNITY_PAYLOAD,
      kind: 0,
      expiresAt: 1_796_083_200,
    });
    await assert.rejects(
      writeOpportunityAudit(prepared, {
        address: CONTRACT,
        account: ACCOUNT,
        adapters: {
          writeContract: unused,
          waitForTransactionReceipt: unused,
          readContract: async ({ functionName }) => {
            if (functionName === "opportunityRevisionCount") return 1n;
            if (functionName === "getOpportunity") {
              return { contentHash: prepared.contentHash };
            }
            return unused();
          },
        },
      }),
      /already anchored/,
    );
  });

  it("caps transient retries and never retries a rejection or revert", () => {
    const transient = classifyAuditError(new Error("network timeout"), {
      attempt: 2,
      maxRetries: 100,
    });
    assert.deepEqual(transient, {
      category: "transient",
      retryable: true,
      attempt: 2,
      maxRetries: 3,
    });
    assert.equal(classifyAuditError({ code: 4001 }).retryable, false);
    const feeError = classifyAuditError(new Error("commitOpportunity reverted: max fee per gas less than block base fee"), { maxRetries: 3 });
    assert.equal(feeError.category, "fee-too-low");
    assert.equal(feeError.retryable, false, "fee rejection must not automatically rebroadcast");
    assert.equal(
      classifyAuditError(new Error("execution reverted: InvalidState"), { maxRetries: 3 }).category,
      "contract-reverted",
    );
  });

  it("rejects a contract address outside the configured deployment", async () => {
    const prepared = prepareOpportunityCommit({
      recordId: "posting-123",
      payload: OPPORTUNITY_PAYLOAD,
      kind: 0,
      expiresAt: 1_796_083_200,
    });
    await assert.rejects(
      commitOpportunityAudit(prepared, {
        address: `0x${"1".repeat(40)}`,
        account: ACCOUNT,
        adapters: {
          writeContract: unused,
          waitForTransactionReceipt: unused,
          readContract: unused,
        },
      }),
      /does not match the configured deployment/,
    );
  });

  it("rejects a prepared proposal operation passed to the wrong writer", () => {
    const input = {
      recordId: "proposal-123",
      opportunityRecordId: "posting-123",
      proposalPayload: { title: "Proposal" },
      solutionPayload: { method: "Annealing" },
      expectedOpportunityRevisionIndex: 0,
    };

    assert.throws(
      () => commitProposalAudit(prepareProposalUpdate(input)),
      /Expected a prepared commitProposal operation/,
    );
    assert.throws(
      () => updateProposalAudit(prepareProposalCommit(input)),
      /Expected a prepared updateHashes operation/,
    );
  });
});

describe("AuditRegistry read-side verification", () => {
  it("reads the opportunity revision index used to prepare a proposal", async () => {
    const opportunityId = opportunityEntityId("posting-123");
    const calls = [];
    const adapters = {
      writeContract: unused,
      waitForTransactionReceipt: unused,
      readContract: async ({ functionName, args }) => {
        calls.push({ functionName, args });
        if (functionName === "opportunityRevisionCount") return 4n;
        return unused();
      },
    };
    const index = await readOpportunityRevisionIndex(opportunityId, {
      address: CONTRACT,
      adapters,
    });
    assert.equal(index, 3);
    assert.deepEqual(calls.map(({ functionName }) => functionName), [
      "opportunityRevisionCount",
    ]);
  });

  it("detects a proposal bound to a different opportunity revision", async () => {
    const expected = prepareProposalCommit({
      recordId: "proposal-123",
      opportunityRecordId: "posting-123",
      proposalPayload: { title: "Proposal" },
      solutionPayload: { method: "Annealing" },
      expectedOpportunityRevisionIndex: 3,
    });
    const adapters = {
      writeContract: unused,
      waitForTransactionReceipt: unused,
      readContract: async ({ functionName }) => {
        assert.equal(functionName, "getProposal");
        return {
          opportunityId: expected.opportunityId,
          opportunityRevisionIndex: 4n,
          opportunityRevisionDigest: `0x${"5".repeat(64)}`,
          proposalHash: expected.proposalHash,
          solutionHash: expected.solutionHash,
        };
      },
    };
    const result = await verifyProposalAudit(expected, {
      address: CONTRACT,
      adapters,
      verifyAnchor: false,
    });
    assert.equal(result.verified, false);
    assert.deepEqual(result.mismatches.map(({ field }) => field), [
      "opportunityRevisionIndex",
    ]);
  });

  it("rejects an opportunity anchored by a different wallet", async () => {
    const expected = prepareOpportunityCommit({
      recordId: "posting-123",
      payload: { ...OPPORTUNITY_PAYLOAD, ownerId: ACCOUNT },
      kind: 0,
      expiresAt: 1_796_083_200,
    });
    const adapters = {
      writeContract: unused,
      waitForTransactionReceipt: unused,
      readContract: async ({ functionName }) => {
        assert.equal(functionName, "getOpportunity");
        return {
          owner: `0x${"b".repeat(40)}`,
          kind: 0,
          contentHash: expected.contentHash,
          expiresAt: 1_796_083_200n,
        };
      },
    };
    const result = await verifyOpportunityAudit(expected, {
      address: CONTRACT,
      adapters,
      verifyAnchor: false,
    });
    assert.equal(result.verified, false);
    assert.deepEqual(result.mismatches.map(({ field }) => field), ["owner"]);
  });

  it("reports the exact changed field instead of treating an existing record as verified", async () => {
    const expected = prepareOpportunityCommit({
      recordId: "posting-123",
      payload: OPPORTUNITY_PAYLOAD,
      kind: 0,
      expiresAt: 1_796_083_200,
    });
    const changed = prepareOpportunityCommit({
      recordId: "posting-123",
      payload: { ...OPPORTUNITY_PAYLOAD, amount: 80_001 },
      kind: 0,
      expiresAt: 1_796_083_200,
    });
    const adapters = {
      writeContract: unused,
      waitForTransactionReceipt: unused,
      readContract: async ({ functionName }) => {
        assert.equal(functionName, "getOpportunity");
        return {
          kind: 0,
          contentHash: changed.contentHash,
          expiresAt: 1_796_083_200n,
          exists: true,
        };
      },
    };
    const result = await verifyOpportunityAudit(expected, {
      address: CONTRACT,
      adapters,
      verifyAnchor: false,
    });
    assert.equal(result.verified, false);
    assert.equal(result.status, "mismatch");
    assert.deepEqual(result.mismatches.map(({ field }) => field), ["contentHash"]);
    assert.equal(result.mismatches[0].expected, expected.contentHash);
    assert.equal(result.mismatches[0].actual, changed.contentHash);
  });
});
