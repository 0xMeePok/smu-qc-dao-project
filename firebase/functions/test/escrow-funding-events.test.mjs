import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters } from "viem";
import { escrowEventId, reconcileFundingReceipt } from "../escrowFundingEvents.js";
import { escrowConfig as config } from "./fixtures/escrowConfigFixture.js";

const address = digit => `0x${digit.repeat(40)}`;
const hash = digit => `0x${digit.repeat(64)}`;
const escrowAddress = address("d"), actor = address("1"), researcher = address("a");
const transactionHash = hash("3"), blockHash = hash("4"), selectionId = hash("5"), evidenceHash = hash("6"), reasonHash = hash("8");
const timestamp = 1900000000n, zeroHash = hash("0");
const digest = (types, values) => keccak256(encodeAbiParameters(parseAbiParameters(types), values));
const expected = { entityId: hash("e"), opportunityId: hash("f"), expectedResearcher: researcher,
  fundingTerms: { token: address("c") }, fundingTermsHash: hash("9") };

function log(eventName, args, logIndex, at) {
  const registry = ["FundingEventAnchored", "ProposalEscrowLinked"].includes(eventName);
  const abi = registry ? config.abi : config.escrow.escrowAbi;
  const event = abi.find(item => item.type === "event" && item.name === eventName);
  assert(event, `Missing test event ABI ${eventName}`);
  const fields = event.inputs.filter(input => !input.indexed);
  return { address: at ?? (registry ? config.address : escrowAddress), logIndex, transactionHash, blockHash, blockNumber: 100n,
    topics: encodeEventTopics({ abi, eventName, args }), data: encodeAbiParameters(fields, fields.map(input => args[input.name])) };
}

function anchor(eventType, eventDigest, logIndex = 0, overrides = {}) {
  return log("FundingEventAnchored", { proposalId: expected.entityId, escrow: escrowAddress,
    eventType, digest: eventDigest, actor, timestamp, ...overrides }, logIndex);
}

function fixture(logs, overrides = {}) {
  const reads = [];
  const receipt = { status: "success", transactionHash, blockNumber: 100n, blockHash, logs, ...overrides.receipt };
  const block = { hash: blockHash, timestamp, ...overrides.block };
  const state = { selectionId, currentTranche: 1n, expiresAt: timestamp, approvalDeadline: timestamp - 1n, ...overrides.state };
  return { config, expected, escrowAddress, transactionHash, safeBlock: 102n, reads,
    client: { getTransactionReceipt: async () => receipt, getBlock: async () => block,
      readContract: async request => { reads.push(request); return state[request.functionName]; } } };
}

function depositPair({ amount = 123456789n, cumulativeAmount = amount, at, actorOverride = actor, anchorOverrides = {} } = {}) {
  return [anchor(1, digest("address,uint256,uint256", [actor, amount, cumulativeAmount]), 0, anchorOverrides),
    log("Deposited", { postingId: expected.opportunityId, proposalId: expected.entityId, depositor: actorOverride,
      token: expected.fundingTerms.token, amount, cumulativeAmount, depositNumber: 1n }, 1, at)];
}

describe("confirmed escrow funding event reconciliation", () => {
  it("pairs exact deposit units and participants with the independently encoded audit digest", async () => {
    const [event] = await reconcileFundingReceipt(fixture(depositPair()));
    assert.equal(event.type, "Deposit"); assert.equal(event.amountBaseUnits, "123456789");
    assert.equal(event.actor, actor); assert.equal(event.counterparty, escrowAddress);
    assert.equal(event.tokenAddress, expected.fundingTerms.token); assert.equal(event.verified, true);
    assert.equal(event.id, escrowEventId(config.chainId, config.address, transactionHash, 0));
    assert.equal(event.timestamp, Number(timestamp)); assert.equal(event.blockNumber, 100);
  });

  it("validates the creation link against the stored proposal terms and researcher", async () => {
    const rows = [anchor(0, expected.fundingTermsHash, 0, { actor: researcher }),
      log("ProposalEscrowLinked", { proposalId: expected.entityId, postingId: expected.opportunityId,
        escrow: escrowAddress, termsHash: expected.fundingTermsHash }, 1)];
    assert.equal((await reconcileFundingReceipt(fixture(rows)))[0].type, "EscrowCreated");
    await assert.rejects(reconcileFundingReceipt({ ...fixture(rows), expected: { ...expected, fundingTermsHash: hash("7") } }), /terms differ/);
    await assert.rejects(reconcileFundingReceipt(fixture([...rows, { ...rows[0], logIndex: 2 }])), /no matching canonical escrow event/);
  });

  it("pairs selection locking and both upfront and delivery approvals", async () => {
    const deadline = timestamp + 86400n;
    const rows = [anchor(2, digest("bytes32,address,uint64", [selectionId, researcher, deadline]), 0),
      log("SelectionLocked", { selectionId, solutionOwner: researcher, approvalDeadline: deadline }, 1),
      anchor(3, digest("bytes32,uint256,address", [selectionId, 0n, actor]), 2),
      log("SelectionApproved", { selectionId, approver: actor }, 3),
      anchor(3, digest("bytes32,uint256,bytes32,address", [selectionId, 1n, evidenceHash, researcher]), 4, { actor: researcher }),
      log("MilestoneApproved", { index: 1n, evidenceHash, approver: researcher }, 5)];
    const f = fixture(rows), events = await reconcileFundingReceipt(f);
    assert.deepEqual(events.map(event => event.type), ["SelectionLocked", "Approval", "Approval"]);
    assert(f.reads.every(request => request.blockNumber === 100n && request.address === escrowAddress));
  });

  for (const index of [0n, 1n]) it(`preserves gross, fee and net units for ${index === 0n ? "upfront" : "final"} release`, async () => {
    const evidence = index === 0n ? zeroHash : evidenceHash;
    const rows = [anchor(8, digest("uint256,bytes32,uint256,uint256", [index, evidence, 50000001n, 50000n])),
      log("TrancheReleased", { index, evidenceHash: evidence, grossAmount: 50000001n, fee: 50000n, netAmount: 49950001n }, 1)];
    const [event] = await reconcileFundingReceipt(fixture(rows));
    assert.equal(event.tranche, Number(index)); assert.equal(event.amountBaseUnits, "50000001");
    assert.equal(event.netAmountBaseUnits, "49950001"); assert.equal(event.feeBaseUnits, "50000");
    assert.equal(event.counterparty, researcher);
  });

  it("pairs delivery evidence and the funding-weighted vote for that evidence", async () => {
    const rows = [anchor(7, digest("uint256,bytes32", [1n, evidenceHash]), 0, { actor: researcher }),
      log("MilestoneSubmitted", { index: 1n, evidenceHash }, 1),
      anchor(11, digest("uint256,bytes32,address,bool,uint256", [1n, evidenceHash, actor, true, 2000000n]), 2),
      log("MilestoneVoted", { index: 1n, evidenceHash, voter: actor, approve: true, weight: 2000000n }, 3)];
    assert.deepEqual((await reconcileFundingReceipt(fixture(rows))).map(event => event.type), ["MilestoneSubmitted", "FunderVote"]);
  });

  it("pairs cancellation, selection invalidation, moderation void and a refund claim", async () => {
    const rows = [anchor(5, reasonHash, 0), log("Cancelled", { reasonHash }, 1),
      anchor(4, digest("bytes32,bytes32", [selectionId, reasonHash]), 2), log("SelectionInvalidated", { selectionId, reasonHash }, 3),
      anchor(9, reasonHash, 4), log("EscrowVoided", { admin: actor, reasonHash, refundPool: 7000000n }, 5),
      anchor(10, digest("address,uint256", [actor, 7000000n]), 6), log("RefundClaimed", { depositor: actor, amount: 7000000n, cumulativeRefunded: 7000000n }, 7)];
    const events = await reconcileFundingReceipt(fixture(rows));
    assert.deepEqual(events.map(event => event.type), ["Cancelled", "SelectionInvalidated", "Voided", "RefundClaimed"]);
    assert.equal(events.at(-1).amountBaseUnits, "7000000"); assert.equal(events.at(-1).counterparty, actor);
  });

  for (const previousState of [0, 1, 6]) it(`reconstructs expiry from the correct deadline for prior state ${previousState}`, async () => {
    const deadline = previousState === 6 ? timestamp - 1n : timestamp;
    const rows = [log("StateChanged", { previousState, newState: 5 }, 0),
      log("RefundsOpened", { pool: 7000000n, availableAt: timestamp }, 1),
      anchor(6, digest("uint256,uint256,uint256", [1n, deadline, 7000000n]), 2)];
    assert.equal((await reconcileFundingReceipt(fixture(rows)))[0].type, "Expired");
  });

  it("rejects unmatched digests, foreign escrow logs, incorrect actors and token identities", async () => {
    for (const rows of [depositPair({ anchorOverrides: { digest: hash("2") } }), depositPair({ at: address("2") }),
      depositPair({ actorOverride: researcher }), depositPair({ anchorOverrides: { escrow: address("2") } }),
      depositPair({ anchorOverrides: { proposalId: hash("2") } })]) {
      await assert.rejects(reconcileFundingReceipt(fixture(rows)), /reconciliation mismatch/);
    }
    const rows = depositPair();
    rows[1] = log("Deposited", { postingId: expected.opportunityId, proposalId: expected.entityId, depositor: actor,
      token: address("2"), amount: 123456789n, cumulativeAmount: 123456789n, depositNumber: 1n }, 1);
    await assert.rejects(reconcileFundingReceipt(fixture(rows)), /no matching canonical escrow event/);
  });

  it("rejects reverted, pending, redirected and noncanonical receipts", async () => {
    for (const receipt of [{ status: "reverted" }, { blockNumber: 103n }, { blockNumber: null }, { transactionHash: hash("7") }]) {
      await assert.rejects(reconcileFundingReceipt(fixture(depositPair(), { receipt })), /not successfully confirmed/);
    }
    await assert.rejects(reconcileFundingReceipt(fixture(depositPair(), { block: { hash: hash("7") } })), /canonical block/);
    await assert.rejects(reconcileFundingReceipt(fixture(depositPair(), { block: { timestamp: timestamp + 1n } })), /timestamp differs/);
  });

  it("rejects a reused escrow event and an escrow event missing its anchor", async () => {
    const rows = depositPair();
    rows.push({ ...rows[0], logIndex: 2 });
    await assert.rejects(reconcileFundingReceipt(fixture(rows)), /no matching canonical escrow event/);
    const orphan = depositPair();
    orphan.push({ ...orphan[1], logIndex: 2 });
    await assert.rejects(reconcileFundingReceipt(fixture(orphan)), /missing its registry anchor/);
  });

  it("rejects a release whose fee and net amount fail to account for the gross amount", async () => {
    const rows = [anchor(8, digest("uint256,bytes32,uint256,uint256", [1n, evidenceHash, 500n, 1n])),
      log("TrancheReleased", { index: 1n, evidenceHash, grossAmount: 500n, fee: 1n, netAmount: 500n }, 1)];
    await assert.rejects(reconcileFundingReceipt(fixture(rows)), /do not add up/);
  });
});
