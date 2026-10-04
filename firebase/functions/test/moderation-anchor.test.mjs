import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { keccak256, stringToHex } from "viem";
import { memoryDb } from "./memoryDb.mjs";
import { deploymentKey, reconcileModerationAnchors, resumePlatformTransaction } from "../escrowFunding.js";
import { canonicalModerationRecord, moderationDecisionId, moderationRecordHash } from "../moderationAnchor.js";

const admin = `0x${"c".repeat(40)}`;
const now = Timestamp.fromDate(new Date("2026-10-02T00:00:00.000Z"));
const config = {
  chainId: 421614,
  address: `0x${"7".repeat(40)}`,
  contractName: "EscrowAuditRegistry",
  abi: [],
};
const record = {
  actorId: admin,
  action: "remove",
  contentType: "comment",
  contentId: "firestore-comment",
  reason: "spam",
  createdAt: "2026-10-02T00:00:00.000Z",
  salt: `0x${"ab".repeat(32)}`,
};
const ZERO = `0x${"0".repeat(64)}`;

describe("moderation anchor digest", () => {
  it("[BUT-ACM-79] hashes the versioned record in the registry field order", () => {
    const json = canonicalModerationRecord(record);
    assert.equal(json, JSON.stringify({
      eventVersion: 1, actorId: admin, action: "remove", contentType: "comment",
      contentId: "firestore-comment", reason: "spam", createdAt: record.createdAt, salt: record.salt,
    }));
    assert.equal(json.includes("details"), false);
    assert.equal(moderationRecordHash(record), keccak256(stringToHex(json)));
    assert.equal(moderationDecisionId("comment-remove"), keccak256(stringToHex("comment-remove")));
  });

  it("[BUT-ACM-80] stores one receipt and does not sign the same decision again", async () => {
    const hash = `0x${"1".repeat(64)}`;
    const blockHash = `0x${"2".repeat(64)}`;
    let broadcasts = 0;
    const db = memoryDb({
      [`escrowPlatformOutbox/${deploymentKey(config)}`]: {
        transactionHash: hash, anchorJobId: "evt-1", actionKey: "moderation:id",
        serializedTransaction: "0x1234", nonce: 1, signerAddress: admin,
      },
      "escrowModerationAnchorJobs/evt-1": {
        eventId: "mod-1", moderationId: moderationDecisionId("mod-1"),
        recordHash: moderationRecordHash(record), status: "pending", nextAttemptAt: now,
      },
      "moderationEvents/mod-1": { chainStatus: "pending", actorId: admin, action: "remove", contentType: "comment", contentId: "firestore-comment" },
    });
    const client = {
      getTransactionReceipt: async () => ({ status: "success", blockNumber: 10n, blockHash }),
      getBlockNumber: async () => 12n,
      getBlock: async () => ({ hash: blockHash }),
      sendRawTransaction: async () => { broadcasts += 1; },
      readContract: async () => { throw new Error("should not read the registry after the receipt is stored"); },
      simulateContract: async () => { throw new Error("should not sign again"); },
    };
    const resumed = await resumePlatformTransaction({ db, client, config, now });
    assert.equal(resumed.status, "success");
    assert.equal(broadcasts, 0);
    const event = db.records.get("moderationEvents/mod-1");
    assert.equal(event.chainStatus, "anchored");
    assert.equal(event.transactionHash, hash);
    assert.equal(db.records.get("escrowModerationAnchorJobs/evt-1").status, "complete");
    await resumePlatformTransaction({ db, client, config, now });
    await reconcileModerationAnchors({
      db, client, config, now, getWallet: () => ({ account: { address: admin } }),
    });
    assert.equal(broadcasts, 0);
    assert.equal(db.records.get("moderationEvents/mod-1").transactionHash, hash);
  });

  it("[BUT-ACM-81] leaves the job pending when the signer is not a moderation admin", async () => {
    const reads = [];
    const db = memoryDb({
      "escrowModerationAnchorJobs/evt-1": {
        eventId: "mod-1", moderationId: moderationDecisionId("mod-1"),
        recordHash: moderationRecordHash(record), status: "pending", nextAttemptAt: now,
      },
      "moderationEvents/mod-1": { chainStatus: "pending" },
    });
    const client = {
      readContract: async ({ functionName }) => {
        reads.push(functionName);
        if (functionName === "moderationRecordHash") return ZERO;
        if (functionName === "isModerationAdmin") return false;
        throw new Error(functionName);
      },
      simulateContract: async () => { throw new Error("should not sign"); },
    };
    await reconcileModerationAnchors({
      db, client, config, now, getWallet: () => ({ account: { address: admin } }),
    });
    assert.deepEqual(reads, ["moderationRecordHash", "isModerationAdmin"]);
    const job = db.records.get("escrowModerationAnchorJobs/evt-1");
    assert.equal(job.status, "pending");
    assert.match(job.blockedReason, /moderation admin/);
    assert.equal(db.records.get("moderationEvents/mod-1").chainStatus, "pending");
  });
});
