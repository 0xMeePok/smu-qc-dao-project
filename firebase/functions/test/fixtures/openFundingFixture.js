import { parseAbi, encodeAbiParameters, encodeEventTopics } from "viem";
import { Timestamp } from "firebase-admin/firestore";
import { escrowClient, escrowConfig, escrowRecord, escrowAddress, owner, researcher, txHash, blockHash } from "./escrowAuditFixture.js";
import { memoryDb } from "../memoryDb.mjs";
import { prepareOpportunityCommit } from "../../auditCanonical.js";
import { fundingOpportunityAuditPayload } from "../../opportunityAuditPayload.js";
import { prepareStoredProposal } from "../../proposalAuditPayload.js";

export { owner, researcher, txHash };
export const poolAddress = `0x${"f".repeat(40)}`, otherResearcher = `0x${"8".repeat(40)}`, zeroAddress = `0x${"0".repeat(40)}`;
export function openFundingFixture() {
  const openFundingPoolAbi = parseAbi([
    "function postingId() view returns(bytes32)", "function owner() view returns(address)", "function token() view returns(address)",
    "function tokenDecimals() view returns(uint8)", "function factory() view returns(address)", "function auditRegistry() view returns(address)",
    "function totalDeposited() view returns(uint256)", "function totalAllocated() view returns(uint256)", "function totalWithdrawn() view returns(uint256)",
    "function reservedAmount() view returns(uint256)", "function availableBalance() view returns(uint256)",
    "function getOffer(bytes32) view returns(uint256 amount,uint64 acceptanceDeadline,uint8 state)",
    "function proposalCount() view returns(uint256)", "function proposalAt(uint256) view returns(bytes32)", "function deposit(uint256)",
    "function selectProposal(bytes32)", "function acceptProposal(bytes32)", "function expireProposal(bytes32)", "function withdrawAvailable(uint256)",
    "event ProposalSelected(bytes32 indexed proposalId,uint256 amount,uint64 acceptanceDeadline)",
  ]);
  const config = { ...escrowConfig, escrow: { ...escrowConfig.escrow, openFundingPoolAbi,
    factoryAbi: [...escrowConfig.escrow.factoryAbi, ...parseAbi([
      "function openFundingPoolForPosting(bytes32) view returns(address)", "function createOpenFundingPool(bytes32,address) returns(address)",
      "event OpenFundingPoolCreated(bytes32 indexed postingId,address pool,address owner,address token)",
    ])], escrowAbi: [...escrowConfig.escrow.escrowAbi, ...parseAbi(["function openFundingPool() view returns(address)"])] } };
  const posting = { id: "escrow-posting", opportunityType: "open-funding", ownerId: owner, title: "100,000 research grant", organisation: "Funder",
    fundingThesis: "Research new quantum techniques", eligibilityNotes: "University teams", categories: ["quantum-annealing"], tags: ["research"],
    amount: 100000, currency: "USDC", status: "submitted", expiresAt: Timestamp.fromMillis(2000000000000),
    audit: { schemaVersion: 1, status: "confirmed", transactionHash: txHash } };
  const proposals = [0, 1].map(index => {
    const row = escrowRecord(); row.id = `proposal-${index}`; row.opportunityType = "open-funding"; row.amount = 50000;
    row.researcherId = index ? otherResearcher : researcher; row.fundingTerms = { ...row.fundingTerms, target: "50000000000" };
    row.audit.status = "confirmed"; return row;
  });
  const expectedPosting = prepareOpportunityCommit({ recordId: posting.id, payload: fundingOpportunityAuditPayload(posting), kind: 1,
    expiresAt: posting.expiresAt, actor: config.entityIdScheme === 2 ? owner : undefined });
  const expected = proposals.map(record => prepareStoredProposal(record, { registryConfig: config }));
  const addresses = [escrowAddress, `0x${"e".repeat(40)}`], calls = [], simulations = [], offers = new Map(), receipts = new Map();
  const proposalClients = proposals.map(escrowClient);
  const state = { poolAddress, timestamp: 1900000000n, totalDeposited: 100000000000n, totalAllocated: 0n, totalWithdrawn: 0n,
    reservedAmount: 0n, availableBalance: 100000000000n, proposalCount: 0n, paused: false, withdrawn: false,
    escrowDeposits: [0n, 0n], released: [0n, 0n], refunded: [0n, 0n], poolOwner: owner };
  Object.assign(state, { walletBalance: 150000000000n, tokenAllowance: 150000000000n, actualTokenDecimals: 6, tokenAllowed: true });
  receipts.set(txHash, { status: "success", to: config.address, transactionHash: txHash, blockHash, blockNumber: 88n, logs: [] });
  const db = memoryDb({ [`users/${owner}`]: { role: 0 }, [`users/${researcher}`]: { role: 0 }, [`users/${otherResearcher}`]: { role: 0 },
    [`problems/${posting.id}`]: posting, ...Object.fromEntries(proposals.map(row => [`proposals/${row.id}`, row])) });
  const client = {
    getChainId: async () => config.chainId, getBlockNumber: async () => 101n,
    getBlock: async () => ({ hash: blockHash, timestamp: state.timestamp }),
    getTransactionReceipt: async ({ hash }) => { if (!receipts.has(hash)) throw new Error("Unknown transaction"); return receipts.get(hash); },
    simulateContract: async request => { simulations.push(request); return { request }; },
    readContract: async request => {
      calls.push(request); const { functionName, args, address } = request;
      if (functionName === "balanceOf") return state.walletBalance;
      if (functionName === "allowance") return state.tokenAllowance;
      if (functionName === "decimals") return state.actualTokenDecimals;
      if (functionName === "allowedTokens") return state.tokenAllowed;
      if (functionName === "getOpportunity") return { owner, kind: 1, contentHash: expectedPosting.contentHash,
        expiresAt: 2000000000n, withdrawn: state.withdrawn };
      if (functionName === "postingFundingPaused") return state.paused;
      if (functionName === "openFundingPoolForPosting") return state.poolAddress;
      if (sameAddress(address, poolAddress)) {
        const fields = { postingId: expectedPosting.entityId, owner: state.poolOwner, token: proposals[0].fundingTerms.token, tokenDecimals: 6,
          factory: config.escrow.factoryAddress, auditRegistry: config.address, ...state };
        if (functionName === "getOffer") return offers.get(args[0]) || { amount: 0n, acceptanceDeadline: 0n, state: 0 };
        if (functionName === "proposalAt") return [...offers.keys()][Number(args[0])];
        if (functionName in fields) return fields[functionName];
      }
      let index = addresses.findIndex(row => sameAddress(address, row));
      if (index < 0 && args?.[0]) index = expected.findIndex(row => row.entityId === args[0]);
      if (index < 0) index = 0;
      if (functionName === "proposalEscrow" || functionName === "escrowForProposal") return addresses[index];
      if (functionName === "getProposal") return { researcher: proposals[index].researcherId, opportunityId: expected[index].opportunityId,
        proposalHash: expected[index].proposalHash, solutionHash: expected[index].solutionHash };
      if (addresses.some(row => sameAddress(address, row))) {
        const values = { openFundingPool: poolAddress, totalDeposited: state.escrowDeposits[index], state: state.escrowDeposits[index] ? 1 : 0,
          proposalOwner: proposals[index].researcherId,
          totalReleased: state.released[index], totalRefunded: state.refunded[index], currentTranche: 0n, selectionId: expected[index].entityId,
          ownerApproved: true, solutionApproved: true, yesWeight: 0n, approvalDeadline: 1950000000n, platformSigner: owner,
          outstandingBalance: state.escrowDeposits[index] - state.released[index] - state.refunded[index],
          depositorSummary: { deposited: state.escrowDeposits[index], refunded: state.refunded[index], released: state.released[index] } };
        if (functionName in values) return values[functionName];
      }
      if (functionName === "isFundingActive") return true;
      if (functionName === "isFundingInvalidated") return state.withdrawn;
      if (functionName === "fundingAnchorCount") return 1n;
      return proposalClients[index].readContract({ ...request, address: addresses.includes(address) ? escrowAddress : address });
    },
  };
  function select(index, offerState = 1, deadline = state.timestamp + 604800n) {
    offers.set(expected[index].entityId, { amount: BigInt(proposals[index].fundingTerms.target), acceptanceDeadline: deadline, state: offerState });
    state.proposalCount = BigInt(offers.size);
    state.reservedAmount = [...offers.values()].filter(row => row.state === 1).reduce((sum, row) => sum + row.amount, 0n);
    state.totalAllocated = [...offers.values()].filter(row => row.state === 2).reduce((sum, row) => sum + row.amount, 0n);
    state.availableBalance = state.totalDeposited - state.reservedAmount - state.totalAllocated - state.totalWithdrawn;
    state.escrowDeposits[index] = offerState === 2 ? 50000000000n : 0n;
  }
  function receipt(hash) {
    const args = { proposalId: expected[0].entityId, amount: 50000000000n, acceptanceDeadline: state.timestamp + 604800n };
    receipts.set(hash, { status: "success", transactionHash: hash, blockHash, blockNumber: 99n, to: poolAddress,
      logs: [{ address: poolAddress, logIndex: 0, topics: encodeEventTopics({ abi: openFundingPoolAbi, eventName: "ProposalSelected", args }),
        data: encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [args.amount, args.acceptanceDeadline]) }] });
  }
  return { db, client, config, uid: owner, problemId: posting.id, posting, proposals, expected, expectedPosting, state, offers, calls, simulations,
    addresses, receipts, select, receipt };
}
const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
