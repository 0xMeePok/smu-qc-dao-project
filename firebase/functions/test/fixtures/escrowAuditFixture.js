import { encodeFunctionData } from "viem";
import { escrowConfig } from "./escrowConfigFixture.js";
export { escrowConfig } from "./escrowConfigFixture.js";
import { prepareStoredProposal } from "../../proposalAuditPayload.js";
import { proposalFundingTerms } from "../../escrowProposalTerms.js";

export const researcher = `0x${"a".repeat(40)}`, owner = `0x${"b".repeat(40)}`;
export const escrowAddress = `0x${"d".repeat(40)}`;
export const txHash = `0x${"3".repeat(64)}`, blockHash = `0x${"4".repeat(64)}`;

export function escrowRecord() {
  const record = { id: "escrow-proposal", problemId: "escrow-posting", researcherId: researcher, postingOwnerId: owner,
    opportunityType: "business-problem", category: "quantum-annealing", title: "Quantum routing", summary: "Benchmark routing",
    amount: 1200.25, currency: "USDC", milestones: "Baseline, prototype, validation", status: "submitted",
    audit: { schemaVersion: 1, chainId: 421614, status: "pending", transactionHash: txHash,
      attemptCount: 1, blockNumber: 0, lastError: "" } };
  record.fundingTerms = proposalFundingTerms({ form: { ...record, amount: "1200.25", tranchePercentages: "20, 30, 50",
    reviewDays: "7, 14, 30", funderVoting: true }, currency: record.currency, config: escrowConfig });
  return record;
}

export function escrowClient(record = escrowRecord()) {
  const expected = prepareStoredProposal(record, { registryConfig: escrowConfig });
  const terms = expected.fundingTerms;
  const calls = [];
  const client = {
    calls,
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 88n, blockHash, transactionHash: txHash }),
    getTransaction: async () => ({ hash: txHash, to: escrowConfig.address, from: researcher, chainId: 421614,
      blockNumber: 88n, blockHash, input: encodeFunctionData({ abi: escrowConfig.abi,
        functionName: expected.functionName, args: expected.args }) }),
    getBlock: async ({ blockNumber }) => blockNumber === 88n ? { hash: blockHash }
      : { hash: `0x${"5".repeat(64)}`, parentHash: blockHash },
    readContract: async ({ address, functionName, args }) => {
      calls.push({ address, functionName, args });
      if (address.toLowerCase() === escrowConfig.address) {
        if (functionName === "getProposal") return { researcher, opportunityId: expected.opportunityId,
          opportunityRevisionIndex: 0, proposalHash: expected.proposalHash, solutionHash: expected.solutionHash };
        if (functionName === "getOpportunity") return { owner, expiresAt: 2_000_000_000n };
        if (functionName === "fundingFactory") return escrowConfig.escrow.factoryAddress;
        if (functionName === "proposalEscrow") return escrowAddress;
        if (functionName === "anchorCount") return 1n;
        if (functionName === "anchorAt") return { contentHash: expected.anchorHash };
      } else if (address.toLowerCase() === escrowConfig.escrow.factoryAddress) {
        if (functionName === "auditRegistry") return escrowConfig.address;
        if (functionName === "escrowForProposal") return escrowAddress;
      } else if (address.toLowerCase() === escrowAddress) {
        const values = { postingId: expected.opportunityId, proposalId: expected.entityId, token: terms.token,
          fundingTarget: terms.target, funderVoting: terms.funderVoting, proposalOwner: researcher, problemOwner: owner,
          tokenRegistry: escrowConfig.escrow.factoryAddress, auditRegistry: escrowConfig.address,
          milestoneCount: BigInt(terms.trancheBps.length), expiresAt: 2_000_000_000n, tokenDecimals: 6 };
        if (functionName in values) return values[functionName];
        if (functionName === "milestoneAt") {
          const index = Number(args[0]);
          const prefix = terms.trancheBps.slice(0, index).reduce((sum, value) => sum + BigInt(value), 0n);
          return { bps: terms.trancheBps[index], reviewWindow: terms.reviewWindows[index], descriptionHash: terms.milestoneHashes[index],
            grossAmount: terms.target * (prefix + BigInt(terms.trancheBps[index])) / 10000n - terms.target * prefix / 10000n };
        }
      }
      throw new Error(`Unexpected fixture read: ${address} ${functionName}`);
    },
  };
  return client;
}
