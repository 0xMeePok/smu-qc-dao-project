import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { confirmedContributors, confirmedLifecycle, publicContributorNames } from "../escrowReporting.js";
import { deliverRefundNotifications, REFUND_NOTIFICATION_JOBS } from "../escrowRefundNotifications.js";
import { memoryDb } from "./memoryDb.mjs";
import { confirmedRefundMetadata } from "../escrowRefundMetadata.js";

const address = digit => `0x${digit.repeat(40)}`;
const base = { proposalId: "proposal", problemId: "problem", chainId: 421614, registryAddress: address("1"),
  escrowAddress: address("2"), tokenAddress: address("3"), fundingTarget: "9007199254740993", totalDeposited: "9007199254740993",
  totalReleased: "0", totalRefunded: "0", outstandingBalance: "9007199254740993", state: "Open", active: true,
  invalidated: false, currentTranche: 0, expiresAt: "2000000000", approvalDeadline: "0", refundsEnabled: false,
  refundAvailableAt: "0", custodyBalance: "9007199254740993", custodyLock: { status: "locked", unlockAt: "2000000000" },
  blockNumber: 100, timestamp: 1900000000, snapshotVerified: true };
const position = { ...base, uid: address("4"), committed: base.totalDeposited, released: "0", refunded: "0", locked: base.totalDeposited, claimable: "0" };

describe("confirmed escrow public reporting", () => {
  it("retains large integer contributions and exposes only the public profile label", async () => {
    const db = memoryDb({ [`users/${position.uid}`]: { fullName: "Public Member", email: "private@example.test", privyId: "private" } });
    const names = await publicContributorNames(db, [position]);
    const result = confirmedContributors(base, [position], { names });
    assert.equal(result.available, true); assert.equal(result.complete, true);
    assert.deepEqual(result.items[0], { walletAddress: position.uid, displayName: "Public Member", committed: base.totalDeposited,
      released: "0", refunded: "0", held: base.totalDeposited, claimable: "0", shareBps: "10000" });
    assert(!JSON.stringify(result).includes("private"));
  });

  it("does not combine stale payout allocations, foreign deployments or unverified rows with current totals", () => {
    const paid = { ...base, totalReleased: "100", outstandingBalance: "9007199254740893", custodyBalance: "9007199254740893" };
    assert.equal(confirmedContributors(paid, [position]).available, false);
    assert.equal(confirmedContributors(base, [{ ...position, snapshotVerified: false }]).available, false);
    assert.equal(confirmedContributors(base, [{ ...position, registryAddress: address("8") }]).available, false);
    assert.equal(confirmedContributors(base, [{ ...position, blockNumber: 101 }]).available, false);
    assert.equal(confirmedContributors(base, [position, position]).available, false);
    assert.equal(confirmedContributors(base, [{ ...position, claimable: "9007199254740994" }]).available, false);
  });

  it("labels incomplete lists and reuses unchanged allocations without forcing per-wallet RPC reads", () => {
    const newer = { ...base, blockNumber: 101, timestamp: base.timestamp + 1 };
    assert.equal(confirmedContributors(newer, [position]).complete, true);
    assert.equal(confirmedContributors(newer, [position], { truncated: true }).complete, false);
    assert.deepEqual(confirmedContributors({ ...base, totalDeposited: "0", fundingTarget: "100", outstandingBalance: "0", custodyBalance: "0" }).items, []);
  });

  it("keeps wallet labels available if profiles are missing or the profile service fails", async () => {
    assert.equal((await publicContributorNames(memoryDb(), [position])).size, 0);
    assert.equal((await publicContributorNames({ getAll: async () => { throw new Error("Offline"); }, collection: () => ({ doc: () => null }) }, [position])).size, 0);
    assert.equal(confirmedContributors(base, [position]).items[0].displayName, null);
  });

  it("presents only receipt-confirmed lifecycle events from the canonical escrow", () => {
    const event = { ...base, id: "confirmed", eventType: "Expired", verified: true, blockNumber: 99, logIndex: 2,
      refundReason: "funding_target_not_met", transactionHash: `0x${"a".repeat(64)}` };
    const result = confirmedLifecycle(base, [event, { ...event, id: "fake", verified: false }, { ...event, id: "foreign", escrowAddress: address("9") },
      { ...event, id: "pending", blockNumber: 101 }]);
    assert.deepEqual(result.events.map(row => row.id), ["confirmed"]);
    assert.equal(result.refundReason, "funding_target_not_met");
    assert.equal(result.refundEvent.transactionHash, event.transactionHash);
  });

  it("retains only confirmed refund explanations for the same canonical escrow and never carries old accounting", () => {
    const previous = { ...base, state: "Voided", refundsEnabled: true, refundReason: "admin_cancelled",
      refundTransactionHash: `0x${"a".repeat(64)}`, refundReasonHash: `0x${"b".repeat(64)}` };
    const current = { ...previous, blockNumber: 101, totalRefunded: "1", outstandingBalance: "9007199254740992" };
    assert.deepEqual(Object.keys(confirmedRefundMetadata(current, previous)).sort(), ["refundReason", "refundReasonHash", "refundTransactionHash"]);
    for (const change of [{ escrowAddress: address("9") }, { registryAddress: address("9") }, { proposalId: "other" },
      { chainId: 1 }, { blockNumber: 99 }, { state: "Open", refundsEnabled: false }]) {
      assert.deepEqual(confirmedRefundMetadata({ ...current, ...change }, previous), {});
    }
    assert.deepEqual(confirmedRefundMetadata(current, { ...previous, snapshotVerified: false }), {});
    assert.deepEqual(confirmedRefundMetadata(current, { ...previous, refundTransactionHash: null }), {});
  });
});

describe("refund opening depositor notifications", () => {
  it("pages all depositors, deduplicates repeated deposits and retains read receipts on retries", async () => {
    const now = Timestamp.fromMillis(1900000000000), eventId = "refund-open";
    const job = { eventId, proposalId: "proposal", problemId: "problem", registryAddress: base.registryAddress, chainId: base.chainId,
      transactionHash: `0x${"a".repeat(64)}`, timestamp: 1900000000, refundReason: "selection_declined", refundAvailableAt: "1900000000",
      status: "pending", cursor: null, nextAttemptAt: now };
    const db = memoryDb({ [`${REFUND_NOTIFICATION_JOBS}/${eventId}`]: job });
    const wallets = Array.from({ length: 101 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`);
    wallets.forEach((actor, index) => db.records.set(`escrowFundingEvents/deposit_${String(index).padStart(3, "0")}`, {
      proposalId: "proposal", registryAddress: base.registryAddress, chainId: base.chainId, eventType: "Deposit", actor, verified: true,
    }));
    db.records.set("escrowFundingEvents/deposit_101", { proposalId: "proposal", registryAddress: base.registryAddress,
      chainId: base.chainId, eventType: "Deposit", actor: wallets[0], verified: true });
    await deliverRefundNotifications({ db, config: { address: base.registryAddress, chainId: base.chainId }, eventId, now });
    assert.equal(db.records.get(`${REFUND_NOTIFICATION_JOBS}/${eventId}`).status, "pending");
    const first = `moderationNotifications/${eventId}_${wallets[0]}`;
    db.records.set(first, { ...db.records.get(first), readAt: now });
    await deliverRefundNotifications({ db, config: { address: base.registryAddress, chainId: base.chainId }, eventId, now });
    await deliverRefundNotifications({ db, config: { address: base.registryAddress, chainId: base.chainId }, eventId, now });
    assert.equal(db.records.get(`${REFUND_NOTIFICATION_JOBS}/${eventId}`).status, "complete");
    assert.equal([...db.records.keys()].filter(key => key.startsWith("moderationNotifications/")).length, 101);
    assert.equal(db.records.get(first).readAt, now);
    assert.match(db.records.get(first).message, /no refund fee/i);
    assert.equal(db.records.get(first).refundReason, "selection_declined");
  });
});
