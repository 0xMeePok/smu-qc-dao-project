import { contributionError } from "./contributionValidation.js";
import { erc20Abi, keccak256, stringToHex } from "viem";
import { getConnection } from "wagmi/actions";
import { AUDIT_REGISTRY_CHAIN_ID, AUDIT_REGISTRY_CONFIG, getAuditRegistryAddress } from "../config/auditRegistry.js";
import { createWagmiAuditAdapters, waitForAuditReceipt } from "./auditRegistry.js";
import {
  isRpcQuotaExceeded, isRpcUnreachable, isTransactionFeeTooLow, isWalletRejection,
  redactUrlPaths, RPC_QUOTA_MESSAGE, RPC_UNREACHABLE_MESSAGE, TRANSACTION_FEE_TOO_LOW_MESSAGE,
} from "./errors.js";
import { wagmiConfig } from "./wagmi.js";
import { assertBytes32, prepareOpportunityCommit } from "../../../firebase/functions/auditCanonical.js";
import { isEscrowRegistry, requireAddress, verifyProposalEscrow } from "../../../firebase/functions/escrowAudit.js";
import { fundingAmountUnits } from "../../../firebase/functions/escrowProposalTerms.js";
import { fundingOpportunityAuditPayload, postingAuditPayload } from "../../../firebase/functions/opportunityAuditPayload.js";
import { isIndependentProposal } from "../../../firebase/functions/independentProposal.js";
import { prepareIndependentEscrowCommit, prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";
import { assertActiveAuditDeployment, isActiveAuditDeployment, resolveAuditDeployment } from "../../../firebase/functions/auditDeployments.js";
import { prepareRemovedProposalClaim } from "./escrowFunding.js";

export const ESCROW_STATE = Object.freeze({ Open: 0, Locked: 1, Released: 2, Refunded: 3, Cancelled: 4, Expired: 5, Active: 6, Voided: 7 });
const ZERO_HASH = `0x${"0".repeat(64)}`;
const same = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();
const field = (value, name, index) => value?.[name] ?? value?.[index];

function deployment(config) {
  if (!isEscrowRegistry(config) || config.chainId !== AUDIT_REGISTRY_CHAIN_ID) {
    throw new Error("The configured deployment does not support this escrow workflow.");
  }
  if (config === AUDIT_REGISTRY_CONFIG && !same(getAuditRegistryAddress(), config.address)) {
    throw new Error("AuditRegistry address differs from the escrow deployment manifest.");
  }
  requireAddress(config.address, "AuditRegistry address");
  return config;
}

/** Uses the same simulation and fee estimation as publication transactions. */
export function createWagmiEscrowAdapters(config = wagmiConfig) {
  const adapters = createWagmiAuditAdapters(config);
  return { ...adapters, writeContract: async (request, options) => {
    const connection = getConnection(config);
    if (!connection.isConnected || !same(connection.address, request.account)) {
      throw new Error("Connect the wallet selected for this escrow action.");
    }
    if (connection.chainId !== request.chainId) throw new Error("Switch your wallet to Arbitrum Sepolia before continuing.");
    return adapters.writeContract(request, options);
  } };
}

export function hashEscrowEvidence(evidence) {
  const summary = String(evidence?.summary ?? "").trim().normalize("NFC");
  const url = String(evidence?.url ?? "").trim();
  if (summary.length < 2 || summary.length > 4000) throw new Error("Describe the delivery evidence in 2–4,000 characters.");
  let parsed;
  try { parsed = new URL(url); } catch { /* Report a form error below. */ }
  if (url.length > 2048 || !url.startsWith("https://") || parsed?.protocol !== "https:" || !parsed.hostname) {
    throw new Error("Provide an HTTPS delivery evidence link of at most 2,048 characters.");
  }
  return keccak256(stringToHex(JSON.stringify({ scheme: "qcdao.escrow.delivery.v1", summary, url })));
}

export function hashEscrowSelectionRejection(reason) {
  const normalized = String(reason ?? "").trim().normalize("NFC");
  if (normalized.length < 10 || normalized.length > 2000) throw new Error("Enter a rejection reason of 10–2,000 characters.");
  return keccak256(stringToHex(JSON.stringify({ scheme: "qcdao.escrow.selection-rejection.v1", reason: normalized })));
}

function milestone(value) {
  return {
    bps: Number(field(value, "bps", 0)), reviewWindow: BigInt(field(value, "reviewWindow", 1)),
    descriptionHash: field(value, "descriptionHash", 2), grossAmount: BigInt(field(value, "grossAmount", 3)),
    evidenceHash: field(value, "evidenceHash", 4), fee: BigInt(field(value, "fee", 5)), paid: field(value, "paid", 6),
  };
}

function depositor(value) {
  return Object.fromEntries(["deposited", "depositCount", "refunded", "claimable", "released", "status"]
    .map((name, index) => [name, name === "status" ? Number(field(value, name, index)) : BigInt(field(value, name, index))]));
}

// Request-local cache: every verification and eligibility read uses the same fresh block.
async function escrowBlockReader(adapters, config) {
  const block = await adapters.getBlock({ chainId: config.chainId, blockTag: "latest" });
  if (typeof block?.number !== "bigint" || typeof block?.timestamp !== "bigint") throw new Error("Could not read the current escrow block. Please refresh.");
  const cache = new Map();
  const readContract = request => {
    const key = JSON.stringify([request.address.toLowerCase(), request.functionName, request.args ?? []], (_, value) => typeof value === "bigint" ? value.toString() : value);
    if (!cache.has(key)) cache.set(key, adapters.readContract({ ...request, chainId: config.chainId, blockNumber: block.number }));
    return cache.get(key);
  };
  return { block, readContract };
}

function assertProposalContent(registered, expected) {
  if (!same(field(registered, "proposalHash", 4), expected.proposalHash) || !same(field(registered, "solutionHash", 5), expected.solutionHash)) {
    throw new Error("Mismatch detected: this proposal differs from its current on-chain record. Refresh before continuing.");
  }
}

const VERIFIED_USER_ACTIONS = new Set(["deposit", "approveSelection", "submitMilestone", "approveMilestone", "voteMilestone"]);

function reviewEligibility({ snapshot, account, active, timestamp, currentMilestone, contribution = 0n, hasVoted = false }) {
  const problemOwner = Boolean(account && same(account, snapshot.problemOwner));
  const proposalOwner = Boolean(account && same(account, snapshot.proposalOwner));
  const reviewOpen = active && timestamp < BigInt(snapshot.approvalDeadline);
  const upfront = Number(snapshot.state) === ESCROW_STATE.Locked && Number(snapshot.currentTranche) === 0;
  const final = Number(snapshot.state) === ESCROW_STATE.Active && Number(snapshot.currentTranche) === 1;
  const evidenceReady = Boolean(currentMilestone && !same(currentMilestone.evidenceHash, ZERO_HASH));
  const needsOwnerApproval = (problemOwner && !snapshot.ownerApproved) || (proposalOwner && !snapshot.solutionApproved);
  return {
    approveSelection: upfront && reviewOpen && needsOwnerApproval,
    submitMilestone: final && reviewOpen && proposalOwner,
    approveMilestone: final && reviewOpen && evidenceReady && needsOwnerApproval,
    voteMilestone: final && reviewOpen && evidenceReady && snapshot.funderVoting && contribution > 0n && !hasVoted,
  };
}

// Verify the complete canonical record, then fetch only the current action's guards.
// Dashboard accounting, refunds and unrelated wallet reads must not delay a signature.
async function readUserAction({ proposal, account, action, adapters, config }) {
  deployment(config);
  const expected = isIndependentProposal(proposal)
    ? prepareIndependentEscrowCommit(proposal, { registryConfig: config })
    : prepareStoredProposal(proposal, { registryConfig: config });
  const { block, readContract } = await escrowBlockReader(adapters, config);
  const [canonical, registered] = await Promise.all([
    verifyProposalEscrow({ expected, config, readContract }),
    readContract({ address: config.address, abi: config.abi, functionName: "getProposal", args: [expected.entityId] }),
  ]);
  assertProposalContent(registered, expected);
  const read = (functionName, args = []) => readContract({ address: canonical.address, abi: config.escrow.escrowAbi, functionName, args });
  const names = action === "deposit"
    ? ["state", "fundingTarget", "totalDeposited", "expiresAt", "tokenDecimals"]
    : ["state", "currentTranche", "selectionId", "approvalDeadline", "ownerApproved", "solutionApproved", "problemOwner", "proposalOwner", "funderVoting"];
  const tokenRead = (functionName, args = []) => readContract({ address: expected.fundingTerms.token, abi: erc20Abi, functionName, args });
  const [values, active, depositValues, contributionSummary] = await Promise.all([
    Promise.all(names.map(name => read(name))),
    readContract({ address: config.address, abi: config.abi, functionName: "isFundingActive", args: [expected.entityId, canonical.address] }),
    action === "deposit" ? Promise.all([
      tokenRead("decimals"),
      readContract({ address: canonical.factoryAddress, abi: config.escrow.factoryAbi, functionName: "allowedTokens", args: [expected.fundingTerms.token] }),
      tokenRead("balanceOf", [account]), tokenRead("allowance", [account, canonical.address]),
    ]) : null,
    action === "voteMilestone" ? read("depositorSummary", [account]) : null,
  ]);
  const snapshot = Object.fromEntries(names.map((name, index) => [name, values[index]]));
  if (action === "deposit") {
    const [tokenDecimals, tokenListed, balance, allowance] = depositValues;
    const decimals = Number(snapshot.tokenDecimals);
    const remaining = BigInt(snapshot.fundingTarget) - BigInt(snapshot.totalDeposited);
    return { ...canonical, decimals, remaining, token: expected.fundingTerms.token,
      symbol: config.escrow.tokens.find(token => same(token.address, expected.fundingTerms.token))?.symbol ?? proposal.currency,
      wallet: { balance: BigInt(balance), allowance: BigInt(allowance) },
      can: { deposit: Boolean(account && proposal.opportunityType !== "open-funding" && Number(snapshot.state) === ESCROW_STATE.Open
        && active && tokenListed && Number(tokenDecimals) === decimals && block.timestamp < BigInt(snapshot.expiresAt)
        && remaining > 0n && BigInt(balance) > 0n) },
    };
  }
  // milestoneAt is already cached by canonical verification; no additional RPC.
  const currentTranche = Number(snapshot.currentTranche);
  const currentMilestone = action !== "approveSelection" && currentTranche >= 0 && currentTranche < expected.fundingTerms.trancheBps.length
    ? milestone(await read("milestoneAt", [BigInt(currentTranche)])) : null;
  const hasVoted = action === "voteMilestone" && currentMilestone && !same(currentMilestone.evidenceHash, ZERO_HASH)
    ? await read("hasVoted", [BigInt(currentTranche), currentMilestone.evidenceHash, account]) : false;
  return { ...canonical, selectionId: snapshot.selectionId, currentTranche, currentMilestone,
    can: reviewEligibility({ snapshot, account, active, timestamp: block.timestamp, currentMilestone,
      contribution: contributionSummary ? depositor(contributionSummary).deposited : 0n, hasVoted }),
  };
}

/** A single-block snapshot, verified through the registry AND factory mappings.
 * Amounts and timestamps are bigint; state/currentTranche/decimals/feeBps are numbers.
 */
export async function readEscrow({ proposal, account, adapters = createWagmiEscrowAdapters(), config = AUDIT_REGISTRY_CONFIG }) {
  const usingConfiguredDeployment = config === AUDIT_REGISTRY_CONFIG;
  if (usingConfiguredDeployment) config = await resolveAuditDeployment(proposal, { getTransaction: adapters.getTransaction, activeConfig: AUDIT_REGISTRY_CONFIG });
  deployment(config);
  const isHistorical = usingConfiguredDeployment && !isActiveAuditDeployment(config, AUDIT_REGISTRY_CONFIG);
  return readEscrowSnapshot({ proposal, account, adapters, config, isHistorical });
}

async function readEscrowSnapshot({ proposal, account, adapters, config, isHistorical = false }) {
  deployment(config);
  const expected = isIndependentProposal(proposal)
    ? prepareIndependentEscrowCommit(proposal, { registryConfig: config })
    : prepareStoredProposal(proposal, { registryConfig: config });
  const walletAddress = account ? requireAddress(account, "Wallet address") : null;
  const { block, readContract } = await escrowBlockReader(adapters, config);
  const canonical = await verifyProposalEscrow({ expected, config, readContract });
  const read = (functionName, args = []) => readContract({ address: canonical.address, abi: config.escrow.escrowAbi, functionName, args });
  const names = ["state", "platformSigner", "problemOwner", "proposalOwner", "fundingTarget", "tokenDecimals", "funderVoting",
    "totalDeposited", "totalReleased", "totalRefunded", "feePaid", "feeBps", "selectionId", "currentTranche", "expiresAt",
    "approvalDeadline", "ownerApproved", "solutionApproved", "yesWeight", "noWeight", "refundsEnabled", "refundAvailableAt", "outstandingBalance", "funderCount"];
  const supportsInvalidation = config.abi.some(item => item.type === "function" && item.name === "isFundingInvalidated");
  const supportsPause = config.abi.some(item => item.type === "function" && item.name === "postingFundingPaused");
  const supportsPendingSelection = config.abi.some(item => item.type === "function" && item.name === "pendingProposalForPosting");
  const supportsSelectionRejection = config.escrow.escrowAbi.some(item => item.type === "function" && item.name === "rejectSelection");
  const tokenRead = (functionName, args) => readContract({ address: expected.fundingTerms.token, abi: erc20Abi, functionName, args });
  const [values, active, registered, tokenDecimals, tokenListed, invalidated, paused, pendingProposalId, walletValues] = await Promise.all([
    Promise.all(names.map(name => read(name))),
    readContract({ address: config.address, abi: config.abi, functionName: "isFundingActive", args: [expected.entityId, canonical.address] }),
    readContract({ address: config.address, abi: config.abi, functionName: "getProposal", args: [expected.entityId] }),
    readContract({ address: expected.fundingTerms.token, abi: erc20Abi, functionName: "decimals" }),
    readContract({ address: canonical.factoryAddress, abi: config.escrow.factoryAbi, functionName: "allowedTokens", args: [expected.fundingTerms.token] }),
    supportsInvalidation ? readContract({ address: config.address, abi: config.abi, functionName: "isFundingInvalidated", args: [expected.entityId, canonical.address] }) : null,
    supportsPause ? readContract({ address: config.address, abi: config.abi, functionName: "postingFundingPaused", args: [expected.opportunityId] }) : false,
    supportsPendingSelection ? readContract({ address: config.address, abi: config.abi, functionName: "pendingProposalForPosting", args: [expected.opportunityId] }) : ZERO_HASH,
    walletAddress ? Promise.all([
      tokenRead("balanceOf", [walletAddress]), tokenRead("allowance", [walletAddress, canonical.address]),
      read("depositorSummary", [walletAddress]),
    ]) : null,
  ]);
  assertProposalContent(registered, expected);
  const snapshot = Object.fromEntries(names.map((name, index) => [name, values[index]]));
  let grantEscrow = false;
  if (proposal.opportunityType === "open-funding" && config.escrow.openFundingPoolAbi?.length
      && config.escrow.escrowAbi.some(item => item.type === "function" && item.name === "openFundingPool")) {
    const pool = await read("openFundingPool");
    if (pool && !/^0x0{40}$/i.test(pool)) {
      grantEscrow = true;
      const offer = await readContract({ address: pool, abi: config.escrow.openFundingPoolAbi, functionName: "getOffer", args: [expected.entityId] });
      snapshot.grantOfferState = Number(field(offer, "state", 2));
    }
  }
  for (const name of ["state", "currentTranche", "feeBps"]) snapshot[name] = Number(snapshot[name]);
  for (const name of ["fundingTarget", "totalDeposited", "totalReleased", "totalRefunded", "feePaid", "expiresAt", "approvalDeadline", "yesWeight", "noWeight", "refundAvailableAt", "outstandingBalance", "funderCount"]) snapshot[name] = BigInt(snapshot[name]);
  const decimals = Number(snapshot.tokenDecimals);
  const tokenPrecisionValid = Number(tokenDecimals) === decimals;
  const milestones = await Promise.all(expected.fundingTerms.trancheBps.map((_, index) => read("milestoneAt", [BigInt(index)]).then(milestone)));
  const currentMilestone = milestones[snapshot.currentTranche] ?? null;
  const wallet = { address: walletAddress, balance: 0n, allowance: 0n, contribution: 0n, hasVoted: false, depositor: null };
  if (walletAddress) {
    const [balance, allowance, summary] = walletValues;
    // Only the vote lookup depends on the verified current milestone.
    const hasVoted = currentMilestone && !same(currentMilestone.evidenceHash, ZERO_HASH)
      ? await read("hasVoted", [BigInt(snapshot.currentTranche), currentMilestone.evidenceHash, walletAddress]) : false;
    Object.assign(wallet, { balance: BigInt(balance), allowance: BigInt(allowance), depositor: depositor(summary), hasVoted });
    wallet.contribution = wallet.depositor.deposited;
  }
  const roles = { problemOwner: Boolean(walletAddress && same(walletAddress, snapshot.problemOwner)),
    proposalOwner: Boolean(walletAddress && same(walletAddress, snapshot.proposalOwner)),
    platform: Boolean(walletAddress && same(walletAddress, snapshot.platformSigner)), funder: wallet.contribution > 0n };
  const remaining = snapshot.fundingTarget - snapshot.totalDeposited;
  const open = snapshot.state === ESCROW_STATE.Open;
  const upfront = snapshot.state === ESCROW_STATE.Locked && snapshot.currentTranche === 0;
  const final = snapshot.state === ESCROW_STATE.Active && snapshot.currentTranche === 1;
  const reviewOpen = active && block.timestamp < snapshot.approvalDeadline;
  const evidenceReady = Boolean(currentMilestone && !same(currentMilestone.evidenceHash, ZERO_HASH));
  const bothApproved = snapshot.ownerApproved && snapshot.solutionApproved;
  const majorityApproved = !snapshot.funderVoting || snapshot.yesWeight > snapshot.totalDeposited / 2n;
  const can = {
    deposit: Boolean(walletAddress && open && active && tokenListed && tokenPrecisionValid && block.timestamp < snapshot.expiresAt && remaining > 0n && wallet.balance > 0n),
    lockSelection: roles.platform && open && active && block.timestamp < snapshot.expiresAt && remaining === 0n,
    ...reviewEligibility({ snapshot, account: walletAddress, active, timestamp: block.timestamp, currentMilestone,
      contribution: wallet.contribution, hasVoted: wallet.hasVoted }),
    rejectSelection: supportsSelectionRejection && proposal.opportunityType !== "open-funding" && upfront && reviewOpen && (roles.problemOwner || roles.proposalOwner),
    release: upfront && reviewOpen && roles.platform && bothApproved,
    releaseMilestone: final && reviewOpen && roles.platform && bothApproved && evidenceReady && majorityApproved,
    claimRefund: Boolean(walletAddress && wallet.depositor?.claimable > 0n),
    expire: Boolean(walletAddress && [ESCROW_STATE.Open, ESCROW_STATE.Locked, ESCROW_STATE.Active].includes(snapshot.state)
      && !(grantEscrow && open) && block.timestamp >= (final || ((grantEscrow || supportsSelectionRejection) && upfront) ? snapshot.approvalDeadline : snapshot.expiresAt)),
    refundInvalidated: Boolean(walletAddress && (supportsInvalidation ? invalidated : !active) && ![ESCROW_STATE.Released, ESCROW_STATE.Refunded, ESCROW_STATE.Voided].includes(snapshot.state)),
  };
  if (isHistorical) for (const action of ["deposit", "lockSelection", "approveSelection", "rejectSelection", "submitMilestone", "approveMilestone", "voteMilestone", "release", "releaseMilestone"]) can[action] = false;
  // Grant funding comes from its owner's pool after researcher acceptance.
  if (proposal.opportunityType === "open-funding") { can.deposit = false; can.lockSelection = false; }
  return { ...canonical, ...snapshot, isGrant: proposal.opportunityType === "open-funding", chainId: config.chainId, token: expected.fundingTerms.token, decimals,
    symbol: config.escrow.tokens.find(token => same(token.address, expected.fundingTerms.token))?.symbol ?? proposal.currency,
    entityId: expected.entityId, blockNumber: block.number, timestamp: block.timestamp, workflowActive: active, workflowPaused: paused, workflowInvalidated: supportsInvalidation ? invalidated : !active, tokenListed, tokenPrecisionValid,
    remaining, milestones, currentMilestone, wallet, roles, can, isHistorical, supportsSelectionRejection, pendingProposalId,
    blockedBySelection: !same(pendingProposalId, ZERO_HASH) && !same(pendingProposalId, expected.entityId) };
}

export async function readPostingFundingStarted(posting, { adapters = createWagmiEscrowAdapters(), config = AUDIT_REGISTRY_CONFIG } = {}) {
  deployment(config);
  const openFunding = posting.opportunityType === "open-funding";
  const expected = prepareOpportunityCommit({ recordId: posting.id, actor: config.entityIdScheme === 2 ? posting.ownerId : undefined,
    payload: openFunding ? fundingOpportunityAuditPayload(posting) : postingAuditPayload(posting),
    kind: openFunding ? 1 : 0, expiresAt: posting.expiresAt, hashScheme: posting.audit?.schemaVersion ?? 1 });
  return adapters.readContract({ address: config.address, abi: config.abi, functionName: "postingFundingStarted", args: [expected.entityId], chainId: config.chainId });
}

const REVERT_MESSAGES = {
  AmountPrecisionExceeded: "Use at most 2 decimal places for funding amounts.",
  ContributionBelowMinimum: "Contribute at least 1 token, or fund the exact remaining balance.",
  ContributionLeavesDust: "This contribution would leave less than 1 token still needed. Enter a smaller amount or fund the exact remaining balance.",
  AccessDenied: "This connected wallet cannot perform that escrow action.",
  InvalidState: "The escrow state changed. Refresh before continuing.",
  InvalidInput: "The selection or evidence changed. Refresh before continuing.",
  WindowClosed: "The approval or funding window has closed.", WindowStillOpen: "The refund window is not open yet.",
  FundingTargetExceeded: "That amount exceeds the funding still needed. Refresh funding status and enter the remaining amount or less.", FundingIncomplete: "The full funding target must be in escrow first.",
  ApprovalIncomplete: "Both owners must approve before payment can be released.", AlreadyApproved: "This wallet has already approved.",
  NothingToRefund: "This wallet has no refund available.", TokenNotListed: "This token is no longer available for new deposits.",
  VotingDisabled: "This proposal uses approval from both owners without funder voting.", AlreadyVoted: "This wallet already voted on this evidence.",
  FunderMajorityRequired: "Yes votes must represent more than half of all contributed funds.",
  WorkflowInactive: "Funding is paused or this proposal is no longer eligible. Refresh to check the current status and any available refunds.",
  UnsupportedTokenBehavior: "This token transfer is not supported by the escrow.",
};

export function escrowErrorMessage(error) {
  if (isWalletRejection(error)) return "The wallet transaction was declined. You can retry when ready.";
  if (isTransactionFeeTooLow(error)) return TRANSACTION_FEE_TOO_LOW_MESSAGE;
  if (error?.code === "AUDIT_TRANSACTION_CANCELLED") return "The escrow transaction was cancelled in your wallet.";
  let current = error;
  for (let depth = 0; current && depth < 8; depth++, current = current.cause) {
    const name = current.data?.errorName ?? current.auditErrorName;
    if (REVERT_MESSAGES[name]) return REVERT_MESSAGES[name];
  }
  // Same leak as auditErrorMessage had: a viem transport error carries the RPC
  // URL, API key included, in its message.
  if (isRpcQuotaExceeded(error)) return RPC_QUOTA_MESSAGE;
  if (isRpcUnreachable(error)) return RPC_UNREACHABLE_MESSAGE;
  return redactUrlPaths(error?.shortMessage || error?.message)
    || "The escrow action could not be completed. Refresh and try again.";
}

/** Retry confirmation of one known hash without submitting another transaction. */
export async function confirmEscrowTransaction(transactionHash, { adapters = createWagmiEscrowAdapters(), config = AUDIT_REGISTRY_CONFIG, confirmations = 2 } = {}) {
  deployment(config);
  const hash = assertBytes32(transactionHash, "Transaction hash");
  try {
    let replaced = false;
    const receipt = await waitForAuditReceipt({ transactionHash: hash, maxRetries: 0, confirmations,
      adapters: { ...adapters, waitForTransactionReceipt: request => adapters.waitForTransactionReceipt({
        ...request, onReplaced: replacement => {
          if (replacement.reason === "replaced") replaced = true;
          request.onReplaced?.(replacement);
        },
      }) } });
    if (replaced) throw Object.assign(new Error("The escrow transaction was replaced by a different wallet transaction. Refresh to check its status."), { terminal: true, outcome: "replaced" });
    if (receipt.status !== "success") throw Object.assign(new Error("The escrow transaction reverted. No change was applied by this transaction."), { terminal: true, outcome: "reverted" });
    return { transactionHash: receipt.transactionHash ?? hash, receipt };
  } catch (cause) {
    const error = new Error(escrowErrorMessage(cause), { cause });
    error.transactionHash = hash;
    error.terminal = cause.terminal === true || cause.code === "AUDIT_TRANSACTION_CANCELLED";
    if (error.terminal) error.transactionSettled = true;
    error.outcome = cause.outcome ?? (cause.code === "AUDIT_TRANSACTION_CANCELLED" ? "cancelled" : "unknown");
    throw error;
  }
}

/** Claim the connected wallet's unpaid balance after a proposal is removed. */
export async function claimRemovedProposalFunds({ proposalId, account }) {
  const prepared = await prepareRemovedProposalClaim({ proposalId });
  if (!prepared?.claimable || !prepared.escrowAddress) {
    throw new Error(prepared?.message || "This wallet has no refund to claim yet.");
  }
  const adapters = createWagmiEscrowAdapters();
  const transactionHash = await adapters.writeContract({
    address: prepared.escrowAddress, abi: AUDIT_REGISTRY_CONFIG.escrow.escrowAbi,
    functionName: "claimRefund", args: [], account, chainId: prepared.chainId,
  });
  return confirmEscrowTransaction(transactionHash);
}

/** Called only from a user action. Never retries a write or signs with a server key. */
export async function writeEscrowAction({ proposal, account, action, amount, evidence, evidenceHash, selectionId, approve, reason,
  onProgress, adapters = createWagmiEscrowAdapters(), config = AUDIT_REGISTRY_CONFIG }) {
  onProgress?.({ status: "preparing", action });
  const usingConfiguredDeployment = config === AUDIT_REGISTRY_CONFIG;
  if (usingConfiguredDeployment) {
    config = await resolveAuditDeployment(proposal, { getTransaction: adapters.getTransaction, activeConfig: AUDIT_REGISTRY_CONFIG });
    if (!["claimRefund", "expire", "refundInvalidated"].includes(action)) assertActiveAuditDeployment(config, AUDIT_REGISTRY_CONFIG);
  }
  const isHistorical = usingConfiguredDeployment && !isActiveAuditDeployment(config, AUDIT_REGISTRY_CONFIG);
  const walletAddress = requireAddress(account, "Connected wallet");
  const snapshot = await (VERIFIED_USER_ACTIONS.has(action) ? readUserAction : readEscrowSnapshot)({
    proposal, account: walletAddress, action, adapters, config, isHistorical,
  });
  if (!Object.hasOwn(snapshot.can, action) || !snapshot.can[action]) throw new Error("This escrow action is not available to the connected wallet in the current state. Refresh and try again.");
  const send = async (functionName, args, { address = snapshot.address, abi = config.escrow.escrowAbi, label = functionName } = {}) => {
    let transactionHash;
    try {
      onProgress?.({ status: "preparing", action: label });
      transactionHash = await adapters.writeContract({ address, abi, functionName, args, account: walletAddress, chainId: config.chainId }, {
        onWalletRequest: () => onProgress?.({ status: "awaiting_signature", action: label }),
      });
      onProgress?.({ status: "pending", action: label, transactionHash });
      const result = await confirmEscrowTransaction(transactionHash, { adapters, config });
      const { receipt } = result;
      transactionHash = result.transactionHash;
      onProgress?.({ status: "confirmed", action: label, transactionHash });
      return { transactionHash, receipt };
    } catch (cause) {
      const error = new Error(escrowErrorMessage(cause), { cause });
      if (transactionHash) error.transactionHash = transactionHash;
      if (cause.terminal !== undefined) { error.terminal = cause.terminal; error.outcome = cause.outcome; }
      if (cause.transactionSettled) error.transactionSettled = true;
      throw error;
    }
  };
  if (action === "deposit") {
    const units = fundingAmountUnits(amount, snapshot.decimals);
    const invalid = contributionError({ amount, decimals: snapshot.decimals, symbol: snapshot.symbol, remaining: snapshot.remaining, balance: snapshot.wallet.balance });
    if (invalid) throw new Error(invalid);
    if (snapshot.wallet.allowance < units) {
      // Zero first supports tokens that require clearing an existing allowance.
      if (snapshot.wallet.allowance > 0n) await send("approve", [snapshot.address, 0n], { address: snapshot.token, abi: erc20Abi, label: "resetAllowance" });
      await send("approve", [snapshot.address, units], { address: snapshot.token, abi: erc20Abi });
    }
    return send("deposit", [units]);
  }
  if (action === "lockSelection") {
    const selected = assertBytes32(selectionId, "Selection id");
    if (same(selected, ZERO_HASH)) throw new Error("A nonzero selection id is required.");
    return send(action, [selected, snapshot.proposalOwner]);
  }
  if (action === "approveSelection" || action === "release") {
    if (selectionId && !same(selectionId, snapshot.selectionId)) throw new Error("The selected proposal changed. Refresh before continuing.");
    return send(action, [snapshot.selectionId]);
  }
  if (action === "rejectSelection") {
    if (selectionId && !same(selectionId, snapshot.selectionId)) throw new Error("The selected proposal changed. Refresh before continuing.");
    return send(action, [snapshot.selectionId, hashEscrowSelectionRejection(reason)]);
  }
  if (action === "submitMilestone") {
    const digest = hashEscrowEvidence(evidence);
    if (evidenceHash && !same(evidenceHash, digest)) throw new Error("Delivery evidence differs from the saved evidence hash.");
    if (same(digest, snapshot.currentMilestone.evidenceHash)) throw new Error("This delivery evidence is already submitted. Confirm completion or provide revised evidence.");
    const result = await send(action, [BigInt(snapshot.currentTranche), digest]);
    return { ...result, evidenceHash: digest };
  }
  if (["approveMilestone", "voteMilestone", "releaseMilestone"].includes(action)) {
    const digest = assertBytes32(evidenceHash, "Reviewed evidence hash");
    if (!same(digest, snapshot.currentMilestone.evidenceHash)) throw new Error("Delivery evidence changed. Review the latest evidence before continuing.");
    if (selectionId && !same(selectionId, snapshot.selectionId)) throw new Error("The selection changed. Refresh before continuing.");
    if (action === "voteMilestone") {
      if (typeof approve !== "boolean") throw new Error("Choose approve or reject for the funder vote.");
      return send(action, [BigInt(snapshot.currentTranche), digest, approve]);
    }
    return send(action, [snapshot.selectionId, BigInt(snapshot.currentTranche), digest]);
  }
  return send(action, []); // claimRefund, expire, refundInvalidated
}
