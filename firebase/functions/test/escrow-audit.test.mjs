import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData } from "viem";
import { asProposalUpdate, withOpportunityRevisionIndex } from "../auditCanonical.js";
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { verifyMinedProposal, recoverProposalAudit, enqueueProposalAudit } from "../proposalAuditRecovery.js";
import { fundingTermsHash, normalizeFundingTerms } from "../escrowAudit.js";
import { fundingAmountText, fundingAmountUnits, proposalFundingTerms } from "../escrowProposalTerms.js";
import { escrowClient, escrowConfig, escrowRecord, txHash, escrowAddress } from "./fixtures/escrowAuditFixture.js";
import { Timestamp } from "firebase-admin/firestore";

const options = { registryConfig: escrowConfig };

describe("Escrow-linked proposal verification", () => {
  it("prepares an atomic escrow commit and preserves terms when the viewed parent revision changes", () => {
    const prepared = prepareStoredProposal(escrowRecord(), options);
    assert.equal(prepared.functionName, "commitProposalWithEscrow");
    assert.equal(prepared.args.length, 6);
    const revised = withOpportunityRevisionIndex(prepared, 7);
    assert.equal(revised.args[4], 7);
    assert.equal(fundingTermsHash(revised.args[5]), prepared.fundingTermsHash);
    const update = withOpportunityRevisionIndex(asProposalUpdate(prepared), 9);
    assert.equal(update.args.length, 4);
    assert.equal(update.args[3], 9);
    assert.equal(update.fundingTermsHash, prepared.fundingTermsHash);
  });

  it("confirms the actual transaction, both escrow mappings, immutable amounts and every tranche", async () => {
    const record = escrowRecord(), client = escrowClient(record);
    const result = await verifyMinedProposal(record, client, options);
    assert.equal(result.status, "confirmed");
    assert.equal(client.calls.filter(call => call.functionName === "milestoneAt").length, 3);
    assert.equal(client.calls.find(call => call.functionName === "fundingTarget").address, escrowAddress);
  });

  it("confirms an unfunded content amendment without allowing a replacement payment plan", async () => {
    const record = escrowRecord(), client = escrowClient(record), prepared = prepareStoredProposal(record, options);
    const original = client.getTransaction;
    client.getTransaction = async () => ({ ...await original(), input: encodeFunctionData({ abi: escrowConfig.abi,
      functionName: "updateHashes", args: asProposalUpdate(prepared).args }) });
    assert.equal((await verifyMinedProposal(record, client, options)).status, "confirmed");
    await assert.rejects(verifyMinedProposal({ ...record, fundingTerms: { ...record.fundingTerms, funderVoting: false } }, client, options), /Mismatch/);
  });

  it("accepts nonzero parent revisions with the funding tuple after the revision argument", async () => {
    const record = escrowRecord(), client = escrowClient(record);
    const prepared = withOpportunityRevisionIndex(prepareStoredProposal(record, options), 4);
    const original = client.getTransaction, read = client.readContract;
    client.getTransaction = async () => ({ ...await original(), input: encodeFunctionData({ abi: escrowConfig.abi, functionName: prepared.functionName, args: prepared.args }) });
    client.readContract = async request => request.functionName === "getProposal"
      ? { ...await read(request), opportunityRevisionIndex: 4 } : read(request);
    assert.equal((await verifyMinedProposal(record, client, options)).status, "confirmed");
  });

  for (const [field, value] of [
    ["funderVoting", false], ["trancheBps", [2500, 2500, 5000]], ["reviewWindows", [86400, 86400, 86400]],
  ]) it(`rejects a transaction whose ${field} differs from the stored funding terms`, async () => {
    const record = escrowRecord();
    await assert.rejects(verifyMinedProposal({ ...record, fundingTerms: { ...record.fundingTerms, [field]: value } }, escrowClient(record), options), /Mismatch/);
  });

  for (const [name, value] of [
    ["fundingFactory", `0x${"1".repeat(40)}`], ["escrowForProposal", `0x${"1".repeat(40)}`],
    ["proposalEscrow", `0x${"0".repeat(40)}`], ["auditRegistry", `0x${"1".repeat(40)}`],
    ["fundingTarget", 1n], ["token", `0x${"1".repeat(40)}`], ["tokenDecimals", 18],
    ["funderVoting", false], ["problemOwner", `0x${"1".repeat(40)}`], ["proposalOwner", `0x${"1".repeat(40)}`],
    ["milestoneCount", 4n], ["expiresAt", 1n],
  ]) it(`rejects an escrow with a mismatched ${name}`, async () => {
    const record = escrowRecord(), client = escrowClient(record), original = client.readContract;
    client.readContract = request => request.functionName === name ? Promise.resolve(value) : original(request);
    await assert.rejects(verifyMinedProposal(record, client, options), /Mismatch|missing or invalid/);
  });

  it("rejects altered milestone payouts and never treats a network failure as confirmation", async () => {
    const record = escrowRecord(), client = escrowClient(record), read = client.readContract;
    client.readContract = async request => request.functionName === "milestoneAt"
      ? { ...await read(request), grossAmount: 1n } : read(request);
    await assert.rejects(verifyMinedProposal(record, client, options), /Mismatch/);
    client.readContract = async () => { throw new Error("HTTP 503"); };
    await assert.rejects(verifyMinedProposal(record, client, options), /503/);
  });

  it("does not accept the disabled legacy commit entry point on the linked registry", async () => {
    const record = escrowRecord(), client = escrowClient(record), prepared = prepareStoredProposal(record, options);
    const original = client.getTransaction;
    client.getTransaction = async () => ({ ...await original(), input: encodeFunctionData({ abi: escrowConfig.abi,
      functionName: "commitProposal", args: prepared.args.slice(0, 5) }) });
    await assert.rejects(verifyMinedProposal(record, client, options), /Mismatch/);
  });

  it("requires the proposal amount, currency and milestone text to match its immutable terms", () => {
    const record = escrowRecord();
    for (const patch of [{ amount: 1200.26 }, { currency: "USDT" }, { milestones: "Different deliverables" }]) {
      assert.throws(() => prepareStoredProposal({ ...record, ...patch }, options), /Mismatch|Configure/);
    }
    assert.throws(() => prepareStoredProposal({ ...record, fundingTerms: undefined }, options), /required/);
  });

  it("does not store a confirmation if only funding terms change during RPC verification", async () => {
    const record = escrowRecord();
    const records = new Map([[`proposals/${record.id}`, record]]);
    const ref = path => ({ path, id: path.split("/").at(-1), get: async () => snapshot(path) });
    const snapshot = path => ({ exists: records.has(path), data: () => records.get(path) });
    const db = { collection: name => ({ doc: id => ref(`${name}/${id}`) }), runTransaction: async fn => fn({
      get: async reference => snapshot(reference.path), set: (reference, value) => records.set(reference.path, value),
      update: (reference, patch) => records.set(reference.path, { ...records.get(reference.path), ...patch }),
    }) };
    const now = Timestamp.fromMillis(1000);
    await enqueueProposalAudit({ db, record, now });
    const client = escrowClient(record), read = client.readContract;
    client.readContract = async request => {
      if (request.functionName === "fundingTarget") records.set(`proposals/${record.id}`,
        { ...record, fundingTerms: { ...record.fundingTerms, funderVoting: false } });
      return read(request);
    };
    await assert.rejects(recoverProposalAudit({ db, client, proposalId: record.id, now, Timestamp, registryConfig: escrowConfig }), /record changed/);
    assert.notEqual(records.get(`proposals/${record.id}`).audit.status, "confirmed");
    assert.equal(records.get(`proposalAuditJobs/${record.id}`).transactionHash, txHash);
  });
});

describe("Escrow form amounts and plans", () => {
  it("preserves small high-precision token amounts across draft and submitted form restoration", () => {
    const config = { ...escrowConfig, escrow: { ...escrowConfig.escrow,
      tokens: [{ ...escrowConfig.escrow.tokens[0], decimals: 18 }] } };
    const form = { amount: "0.000000000000000001", milestones: "Delivery" };
    const terms = proposalFundingTerms({ form, currency: "USDC", config });
    const restored = { ...form, amount: fundingAmountText(Number(form.amount)), immutableFundingTerms: terms };
    assert.equal(restored.amount, form.amount);
    assert.deepEqual(proposalFundingTerms({ form: restored, currency: "USDC", config }), terms);
    assert.equal(terms.target, "1");
  });
  for (const decimals of [0, 6, 18, 77]) it(`uses exact base units for a token with ${decimals} decimals`, () => {
    assert.equal(fundingAmountUnits("1", decimals), 10n ** BigInt(decimals));
    if (decimals) assert.equal(fundingAmountUnits(`0.${"0".repeat(decimals - 1)}1`, decimals), 1n);
    assert.throws(() => fundingAmountUnits(`0.${"0".repeat(decimals)}1`, decimals), /decimal places/);
  });
  it("supports a lump sum or five uneven tranches and rejects lossy or malformed input", () => {
    const form = { amount: "1000.123456", milestones: "Five delivery stages", tranchePercentages: "10, 15, 20, 25, 30",
      reviewDays: "7, 14, 21, 28, 35", funderVoting: true };
    const terms = proposalFundingTerms({ form, currency: "USDC", config: escrowConfig });
    assert.deepEqual(terms.trancheBps, [1000, 1500, 2000, 2500, 3000]);
    assert.equal(terms.target, "1000123456");
    assert.equal(proposalFundingTerms({ form: { amount: "1", milestones: "Delivery" }, currency: "USDC", config: escrowConfig }).trancheBps[0], 10000);
    for (const patch of [{ amount: "0.0000001" }, { tranchePercentages: "30, 30" }, { tranchePercentages: "0, 100" },
      { reviewDays: "366" }, { reviewDays: "7,14" }, { funderVoting: "true" }]) {
      assert.throws(() => proposalFundingTerms({ form: { ...form, ...patch }, currency: "USDC", config: escrowConfig }));
    }
    assert.throws(() => normalizeFundingTerms({ ...terms, target: 100 }), /integer string/);
    assert.throws(() => normalizeFundingTerms({ ...terms, target: (1n << 256n).toString() }), /uint256/);
    assert.equal(fundingAmountUnits(1e-7, 18), 100000000000n);
    const highPrecision = { ...escrowConfig, escrow: { ...escrowConfig.escrow,
      tokens: [{ ...escrowConfig.escrow.tokens[0], decimals: 18 }] } };
    assert.throws(() => proposalFundingTerms({ form: { ...form, amount: "123456789.123456789" }, currency: "USDC", config: highPrecision }), /numeric precision/);
  });
});
