import { expect } from "chai";
import { fixture, terms, at, assertAccounting, State } from "./helpers.js";
import { reconcileFundingReceipt } from "../../../firebase/functions/escrowFundingEvents.js";

// Use mined Hardhat receipts so the production reconciler sees the contracts'
// real event order and ABI payloads, including registry calls within escrow writes.
async function reconciliationContext(c, plan) {
  const provider = c.ethers.provider;
  const config = { chainId: Number((await provider.getNetwork()).chainId), address: c.registryAddress,
    abi: JSON.parse(c.registry.interface.formatJson()), escrow: { escrowAbi: JSON.parse(c.escrow.interface.formatJson()) } };
  const fundingTerms = terms(c, plan);
  const expected = { entityId: c.proposalId, opportunityId: c.postingId, expectedResearcher: c.solution.address,
    fundingTerms, fundingTermsHash: c.ethers.keccak256(c.ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(address token,uint256 target,bool funderVoting,uint16[] trancheBps,uint64[] reviewWindows,bytes32[] milestoneHashes)"], [fundingTerms])) };
  const client = {
    getTransactionReceipt: async ({ hash }) => {
      const receipt = await provider.getTransactionReceipt(hash);
      return { status: receipt.status === 1 ? "success" : "reverted", transactionHash: receipt.hash,
        blockHash: receipt.blockHash, blockNumber: BigInt(receipt.blockNumber),
        logs: receipt.logs.map(log => ({ address: log.address, topics: log.topics, data: log.data, logIndex: log.index })) };
    },
    getBlock: async ({ blockNumber }) => {
      const block = await provider.getBlock(Number(blockNumber));
      return { hash: block.hash, timestamp: BigInt(block.timestamp) };
    },
    readContract: ({ address, abi, functionName, args = [], blockNumber }) =>
      new c.ethers.Contract(address, abi, provider)[functionName](...args, { blockTag: Number(blockNumber) }),
  };
  return async transactions => {
    const safeBlock = BigInt(await provider.getBlockNumber());
    const rows = [];
    for (const transaction of transactions) rows.push(...await reconcileFundingReceipt({ client, config, expected,
      escrowAddress: c.escrowAddress, transactionHash: transaction.hash, safeBlock }));
    expect(new Set(rows.map(row => row.id)).size).to.equal(rows.length);
    expect(rows.every(row => row.verified && row.registryAddress === c.registryAddress.toLowerCase())).to.equal(true);
    expect(rows.length).to.equal(Number(await c.registry.fundingAnchorCount(c.proposalId)));
    return rows;
  };
}

describe("Production event reconciliation against mined escrow transactions", function () {
  it("reconciles creation, deposits and top-up, dual approvals, evidence, votes and both 50% payments", async function () {
    const plan = { trancheBps: [5000, 5000], funderVoting: true };
    const c = await fixture({ ...plan, target: 1000n, feeBps: 100 });
    const transactions = [c.creation];
    const send = async promise => { const tx = await promise; await tx.wait(); transactions.push(tx); };
    await send(c.escrow.connect(c.alice).deposit(400n));
    await send(c.escrow.connect(c.bob).deposit(100n));
    await send(c.escrow.connect(c.alice).deposit(500n));
    await send(c.escrow.lockSelection(c.selectionId, c.solution.address));
    await send(c.escrow.connect(c.owner).approveSelection(c.selectionId));
    await send(c.escrow.connect(c.solution).approveSelection(c.selectionId));
    await send(c.escrow.release(c.selectionId));
    const evidence = c.ethers.id("Delivered implementation and reproducible benchmark results");
    await send(c.escrow.connect(c.solution).submitMilestone(1, evidence));
    await send(c.escrow.connect(c.owner).approveMilestone(c.selectionId, 1, evidence));
    await send(c.escrow.connect(c.solution).approveMilestone(c.selectionId, 1, evidence));
    await send(c.escrow.connect(c.alice).voteMilestone(1, evidence, true));
    await send(c.escrow.releaseMilestone(c.selectionId, 1, evidence));

    const reconcile = await reconciliationContext(c, plan), rows = await reconcile(transactions);
    expect(rows.map(row => row.type)).to.deep.equal(["EscrowCreated", "Deposit", "Deposit", "Deposit", "SelectionLocked",
      "Approval", "Approval", "TrancheReleased", "MilestoneSubmitted", "Approval", "Approval", "FunderVote", "TrancheReleased"]);
    expect(rows.filter(row => row.type === "Deposit").map(row => row.amountBaseUnits)).to.deep.equal(["400", "100", "500"]);
    const paid = rows.filter(row => row.type === "TrancheReleased");
    expect(paid.map(row => [row.tranche, row.amountBaseUnits, row.feeBaseUnits, row.netAmountBaseUnits]))
      .to.deep.equal([[0, "500", "5", "495"], [1, "500", "5", "495"]]);
    expect(paid.every(row => row.counterparty === c.solution.address.toLowerCase())).to.equal(true);
    expect(await c.escrow.state()).to.equal(State.Released);
    expect(await c.token.balanceOf(c.solution.address)).to.equal(990n);
    await assertAccounting(c);
  });

  it("reconciles a cancelled escrow followed by a refund after its posting lock expires", async function () {
    const plan = { trancheBps: [5000, 5000] }, c = await fixture(plan), transactions = [c.creation];
    transactions.push(await c.escrow.connect(c.alice).deposit(400n));
    transactions.push(await c.escrow.cancel(c.reason));
    await at(c, c.expiresAt);
    transactions.push(await c.escrow.connect(c.alice).claimRefund());
    const rows = await (await reconciliationContext(c, plan))(transactions);
    expect(rows.map(row => row.type)).to.deep.equal(["EscrowCreated", "Deposit", "Cancelled", "RefundClaimed"]);
    expect(rows.at(-1).amountBaseUnits).to.equal("400");
    expect(rows.at(-1).counterparty).to.equal(c.alice.address.toLowerCase());
    expect(await c.escrow.state()).to.equal(State.Refunded);
    await assertAccounting(c);
  });

  it("reconstructs final review expiry from the real state-change and refund-pool event order", async function () {
    const plan = { trancheBps: [5000, 5000], reviewWindows: [86400, 86400] };
    const c = await fixture(plan), transactions = [c.creation];
    const send = async promise => { const tx = await promise; await tx.wait(); transactions.push(tx); };
    await send(c.escrow.connect(c.alice).deposit(c.target));
    await send(c.escrow.lockSelection(c.selectionId, c.solution.address));
    await send(c.escrow.connect(c.owner).approveSelection(c.selectionId));
    await send(c.escrow.connect(c.solution).approveSelection(c.selectionId));
    await send(c.escrow.release(c.selectionId));
    await at(c, await c.escrow.approvalDeadline());
    await send(c.escrow.expire());
    await send(c.escrow.connect(c.alice).claimRefund());
    const rows = await (await reconciliationContext(c, plan))(transactions);
    expect(rows.slice(-2).map(row => row.type)).to.deep.equal(["Expired", "RefundClaimed"]);
    expect(rows.at(-1).amountBaseUnits).to.equal("500");
    expect(await c.escrow.totalReleased()).to.equal(500n);
    expect(await c.escrow.totalRefunded()).to.equal(500n);
    await assertAccounting(c);
  });
});
