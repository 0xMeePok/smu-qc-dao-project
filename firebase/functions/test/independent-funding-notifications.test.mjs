import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { notifyIndependentEvidenceSubmitted } from "../independentFundingNotifications.js";
import { memoryDb } from "./memoryDb.mjs";

const researcher = `0x${"a".repeat(40)}`, funder = `0x${"b".repeat(40)}`, other = `0x${"c".repeat(40)}`;
const config = { chainId: 421614, address: `0x${"d".repeat(40)}`,
  independentFunding: { enabled: true, factoryAddress: `0x${"e".repeat(40)}` } };
const proposalId = "listing-1";
const summaryKey = `${config.chainId}_${config.address}_${proposalId}`;
const now = Timestamp.fromMillis(1_900_000_000_000);
const position = (walletId, deposited = "1000000") => ({
  walletId, proposalId, summaryKey, deposited, chainId: config.chainId,
  registryAddress: config.address, factoryAddress: config.independentFunding.factoryAddress,
});

function fixture() {
  return memoryDb({
    [`proposals/${proposalId}`]: { proposalKind: "independent", researcherId: researcher, title: "Open annealing library", status: "accepted" },
    [`independentFundingSummaries/${summaryKey}`]: { state: "Accepted", completionDeadline: "1899604800", chainId: config.chainId,
      registryAddress: config.address, factoryAddress: config.independentFunding.factoryAddress },
    [`independentFundingPositions/${summaryKey}_${funder}`]: position(funder),
    [`independentFundingPositions/${summaryKey}_${other}`]: position(other),
    [`independentFundingPositions/${summaryKey}_${researcher}`]: position(researcher),
  });
}
const event = { eventType: "EvidenceSubmitted", proposalId, actorId: researcher, researcherId: researcher, timestamp: 1_899_000_000,
  transactionHash: `0x${"1".repeat(64)}` };
const notices = (db) => [...db.records.entries()].filter(([path]) => path.startsWith("moderationNotifications/"))
  .map(([path, row]) => ({ path, ...row }));

test("completion evidence notifies every funder except the researcher, once", async () => {
  const db = fixture();
  const result = await notifyIndependentEvidenceSubmitted({ db, config, eventId: "event-1", event, now });
  assert.equal(result.delivered, 2);
  const rows = notices(db);
  assert.deepEqual(rows.map((row) => row.recipientId).sort(), [funder, other].sort());
  assert.equal(rows[0].kind, "independent_funding");
  assert.equal(rows[0].workflowStatus, "accepted");
  assert.equal(rows[0].navigationTarget, "proposal/listing-1?tab=funding");
  assert.match(rows[0].message, /Open annealing library/);
  assert.match(rows[0].message, /vote by 2030-03-13 04:00:00 UTC/);
  assert.equal(rows.every((row) => row.recipientId !== researcher), true);
  assert.equal((await notifyIndependentEvidenceSubmitted({ db, config, eventId: "event-1", event, now })).delivered, 0);
  assert.equal(notices(db).length, 2);
});

test("ignores other independent funding events and a closed listing", async () => {
  const db = fixture();
  assert.equal((await notifyIndependentEvidenceSubmitted({ db, config, eventId: "deposit", event: { ...event, eventType: "Deposited" }, now })).delivered, 0);
  db.records.get(`independentFundingSummaries/${summaryKey}`).state = "Released";
  assert.equal((await notifyIndependentEvidenceSubmitted({ db, config, eventId: "late", event, now })).delivered, 0);
  assert.equal(notices(db).length, 0);
});
