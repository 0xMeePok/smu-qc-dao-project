import { httpsCallable } from "firebase/functions";
import { erc20Abi, formatUnits } from "viem";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { AUDIT_REGISTRY_CHAIN_ID, AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { opportunityEntityId } from "../../../firebase/functions/auditCanonical.js";
import { auditErrorMessage, isRpcQuotaExceeded, isRpcUnreachable } from "./errors.js";
import { normalizeWalletWriteError } from "./auditRegistry.js";
import independentConfig from "../config/independentFunding.contract.json" with { type: "json" };
import { INDEPENDENT_FUNDING_LABELS, INDEPENDENT_FUNDING_STATE as S } from "../config/workflowStatus.js";

async function call(name, payload = {}) {
  requireFirebase();
  return (await httpsCallable(functions, name)(payload)).data;
}
export const getIndependentFundingState = payload => call("getIndependentFundingState", payload);
/** Administrator-only: asks the platform signer to pay the funder-approved final 50%. */
export const releaseIndependentFundingCompletion = payload => call("releaseIndependentFundingCompletion", payload);
export const prepareIndependentFundingAction = payload => call("prepareIndependentFundingAction", payload);
export const syncIndependentFunding = payload => call("syncIndependentFunding", payload);
export const independentFundingExplorer = (type, value) => `https://sepolia.arbiscan.io/${type}/${value}`;
export const independentFundingConfigured = (config = independentConfig) => config.enabled !== false
  && /^0x[0-9a-f]{40}$/i.test(config.factoryAddress ?? "") && !/^0x0{40}$/i.test(config.factoryAddress);
export const independentFundingDeploymentKey = () => `${independentConfig.chainId}:${independentConfig.factoryAddress ?? "unconfigured"}`;
export function independentFundingError(error, { transactionHash, reading = false } = {}) {
  if ((transactionHash || error?.transactionHash) && !error?.transactionSettled) {
    return "Your wallet transaction was submitted, but its crowdfunding status could not be confirmed. Retry confirmation to check the same transaction.";
  }
  if (reading && (isRpcQuotaExceeded(error) || isRpcUnreachable(error))) {
    return "Crowdfunding status is temporarily unavailable. Refresh to verify current balances and available actions.";
  }
  // A confirmed approval may precede a competing deposit. The final deposit
  // simulation exposes the contract's specific error through adapter wrappers.
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) {
    const policyMessage = {
      AmountPrecisionExceeded: "Use at most 2 decimal places for funding amounts.",
      ContributionBelowMinimum: "Contribute at least 1 token, or fund the exact remaining balance.",
      ContributionLeavesDust: "This contribution would leave less than 1 token still needed. Enter a smaller amount or fund the exact remaining balance.",
    }[cause.data?.errorName ?? cause.auditErrorName];
    if (policyMessage) return policyMessage;
    if ((cause.data?.errorName ?? cause.auditErrorName) === "FundingTargetExceeded") {
      return "That contribution exceeds the funding still needed. Refresh funding status and enter the remaining amount or less.";
    }
  }
  const code = String(error?.code ?? "").split("/").at(-1);
  if (["invalid-argument", "failed-precondition", "permission-denied", "unauthenticated"].includes(code)) return error.message;
  return auditErrorMessage(error);
}
export async function confirmIndependentFundingTransaction(transactionHash, options) {
  const { confirmEscrowTransaction } = await import("./escrow.js");
  return options === undefined ? confirmEscrowTransaction(transactionHash) : confirmEscrowTransaction(transactionHash, options);
}

const units = value => { try { return BigInt(value ?? 0); } catch { return 0n; } };
export function independentFundingAmount(value, decimals = 6, symbol = "") {
  if (value == null || !Number.isInteger(decimals)) return "—";
  try { return `${formatUnits(BigInt(value), decimals)} ${symbol}`.trim(); } catch { return "—"; }
}
export function independentFundingStarted(snapshot) {
  return units((snapshot?.summary ?? snapshot)?.totalDeposited) > 0n;
}
export function independentFundingLocked(snapshot) {
  return snapshot?.exists === true || snapshot?.activated === true || snapshot?.locked === true
    || snapshot?.summary?.activated === true || snapshot?.summary?.locked === true || independentFundingStarted(snapshot);
}
export function independentFundingStatus(snapshot) {
  const summary = snapshot?.summary ?? snapshot;
  if (!snapshot) return { label: "Crowdfunding", detail: "Open crowdfunding to verify the current funding status.", tone: "neutral" };
  if (snapshot.exists === false) return { label: "Funding activation required", detail: "The researcher can activate crowdfunding from this listing.", tone: "neutral" };
  const target = units(summary.fundingTarget ?? summary.target), deposited = units(summary.totalDeposited);
  const ready = summary.state === S.OPEN && target > 0n && deposited >= target;
  return { label: ready ? "Target reached" : INDEPENDENT_FUNDING_LABELS[summary.state] ?? "Crowdfunding",
    detail: ready ? "Waiting for the researcher to accept or decline funding." : "50% on researcher acceptance; 50% after funder approval.", tone: "neutral" };
}

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const same = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());
const isAddress = value => /^0x[0-9a-f]{40}$/i.test(value ?? "") && !same(value, ZERO_ADDRESS);
/** Member wallet actions and the contract function each one may call. */
const ACTIONS = Object.freeze({ activate: "createEscrow", deposit: "deposit", accept: "acceptFunding", decline: "declineFunding",
  submitEvidence: "submitEvidence", vote: "voteCompletion", expire: "expire", claimRefund: "claimRefund" });
const MISMATCH = "The funding transaction does not match the configured deployment. Refresh before continuing.";

function expectedListingId(proposalId, proposal, action) {
  // The escrow is keyed by the listing's opportunity ID, not its child proposal ID.
  // A refund pays only its caller, so the dashboard can still show it with an ID-only shell.
  if (action === "claimRefund" && !proposal?.researcherId) return null;
  if (proposal?.id !== proposalId || !isAddress(proposal.researcherId)) throw new Error(MISMATCH);
  return opportunityEntityId(proposalId, { hashScheme: 2,
    actor: AUDIT_REGISTRY_CONFIG.entityIdScheme === 2 ? proposal.researcherId : undefined });
}

/**
 * The server prepares the call, but the wallet signs only against contracts this bundle can
 * prove: the configured factory, or the one escrow that factory deployed for the listing
 * (read on-chain), with the bundled ABI. An approval goes only to that escrow and only for
 * the token the escrow itself holds, so a tampered callable response cannot redirect funds.
 */
async function verifiedTarget({ prepared, action, proposalId, proposal, adapters, config = independentConfig }) {
  if (!independentFundingConfigured(config)) throw new Error("Independent crowdfunding is awaiting its contract deployment.");
  if (prepared.chainId !== AUDIT_REGISTRY_CHAIN_ID || prepared.chainId !== config.chainId) {
    throw new Error("This funding transaction was prepared for the wrong network. Refresh the app and try again.");
  }
  const functionName = ACTIONS[action];
  if (!functionName || prepared.functionName !== functionName) throw new Error(MISMATCH);
  const abi = action === "activate" ? config.factoryAbi : config.escrowAbi;
  const spec = abi.find(item => item.type === "function" && item.name === functionName);
  if (!spec || !Array.isArray(prepared.args) || spec.inputs.length !== prepared.args.length) {
    throw new Error("The funding transaction could not be prepared. Refresh and retry.");
  }
  const read = (address, contractAbi, name, args = []) => adapters.readContract({ address, abi: contractAbi, functionName: name, args, chainId: config.chainId });
  const listing = expectedListingId(proposalId, proposal, action);
  if (action === "activate") {
    if (!same(prepared.address, config.factoryAddress) || (listing && !same(prepared.args[0], listing))) throw new Error(MISMATCH);
    return { address: config.factoryAddress, abi, spec };
  }
  if (!isAddress(prepared.address)) throw new Error(MISMATCH);
  const listingId = await read(prepared.address, config.escrowAbi, "listingId");
  if (listing && !same(listingId, listing)) throw new Error(MISMATCH);
  const canonical = await read(config.factoryAddress, config.factoryAbi, "escrowForListing", [listingId]);
  if (!same(canonical, prepared.address)) throw new Error(MISMATCH);
  if (action === "deposit") {
    const [escrowToken, decimals] = await Promise.all([read(canonical, config.escrowAbi, "token"), read(canonical, config.escrowAbi, "tokenDecimals")]);
    const listed = (config.tokens ?? []).find(token => same(token.address, escrowToken));
    if (!same(prepared.tokenAddress, escrowToken) || !listed || Number(decimals) !== listed.decimals || prepared.tokenDecimals !== listed.decimals) {
      throw new Error("The token or amount changed. Refresh before continuing.");
    }
  }
  return { address: canonical, abi, spec };
}

function abiValue(value, input) {
  if (/^(u?int)(\d+)?$/.test(input.type)) return BigInt(value);
  if (input.type.endsWith("[]")) return value.map(item => abiValue(item, { ...input, type: input.type.slice(0, -2) }));
  if (input.type === "tuple") return input.components.map((component, index) => abiValue(value?.[component.name] ?? value?.[index], component));
  return value;
}

/** The server prepares the calldata; `verifiedTarget` proves the target on-chain before signing. */
export async function writeIndependentFundingAction({ proposalId, proposal, action, account, amount, evidence, evidenceHash, approve, reason,
  adapters, prepare = prepareIndependentFundingAction, onChange }) {
  if (!account) throw new Error("Sign in with your email to use your QC DAO wallet.");
  onChange?.({ status: "preparing", action });
  const { createWalletEscrowAdapters, confirmEscrowTransaction, hashEscrowEvidence } = await import("./escrow.js");
  adapters ??= createWalletEscrowAdapters();
  const hash = action === "submitEvidence" ? hashEscrowEvidence(evidence) : evidenceHash;
  const declineReason = action === "decline" ? String(reason ?? "").trim().normalize("NFC") : null;
  if (declineReason !== null && (declineReason.length < 10 || declineReason.length > 2000)) {
    throw new Error("Enter a decline reason of 10–2,000 characters.");
  }
  const prepared = await prepare({ proposalId, action, ...(amount !== undefined ? { amount } : {}),
    ...(hash ? { evidenceHash: hash } : {}), ...(evidence ? { evidence } : {}), ...(approve !== undefined ? { approve } : {}),
    ...(declineReason !== null ? { reason: declineReason } : {}) });
  const target = await verifiedTarget({ prepared, action, proposalId, proposal, adapters });
  const { spec } = target;
  const send = async (request, step) => {
    onChange?.({ status: "preparing", action: step });
    let transactionHash;
    try {
      transactionHash = await adapters.writeContract({ ...request, account, chainId: prepared.chainId }, {
        onWalletRequest: () => onChange?.({ status: "awaiting_signature", action: step }),
        onSubmitted: (details) => onChange?.({ status: "pending", action: step, ...details }),
      });
      onChange?.({ status: "pending", action: step, transactionHash });
      const confirmed = await confirmEscrowTransaction(transactionHash, { adapters });
      onChange?.({ status: "confirmed", action: step, transactionHash });
      return confirmed;
    } catch (cause) {
      const error = normalizeWalletWriteError(cause);
      if (!error.transactionHash && transactionHash) error.transactionHash = transactionHash;
      error.action = step;
      throw error;
    }
  };
  if (action === "deposit") {
    const amountBaseUnits = BigInt(prepared.amountBaseUnits);
    const tokenRequest = { address: prepared.tokenAddress, abi: erc20Abi, chainId: prepared.chainId };
    const [balance, allowance] = await Promise.all([
      adapters.readContract({ ...tokenRequest, functionName: "balanceOf", args: [account] }),
      adapters.readContract({ ...tokenRequest, functionName: "allowance", args: [account, target.address] }),
    ]);
    if (amountBaseUnits <= 0n || amountBaseUnits > BigInt(balance)) throw new Error("Enter a positive contribution within your wallet's token balance.");
    if (BigInt(allowance) < amountBaseUnits) {
      if (BigInt(allowance) > 0n) await send({ address: prepared.tokenAddress, abi: erc20Abi,
        functionName: "approve", args: [target.address, 0n] }, "resetAllowance");
      await send({ address: prepared.tokenAddress, abi: erc20Abi,
        functionName: "approve", args: [target.address, amountBaseUnits] }, "approve");
    }
  }
  return send({ address: target.address, abi: target.abi, functionName: prepared.functionName,
    args: prepared.args.map((value, index) => abiValue(value, spec.inputs[index])) }, action);
}

/** Called only after the listing has been successfully saved and attested. */
export async function activateIndependentFunding(proposalId, { account, adapters, onProgress } = {}) {
  const result = await writeIndependentFundingAction({ proposalId, proposal: { id: proposalId, researcherId: account },
    action: "activate", account, adapters, onChange: onProgress });
  try { await syncIndependentFunding({ proposalId, transactionHash: result.transactionHash }); }
  catch (error) { error.transactionHash = result.transactionHash; error.action = "activate"; throw error; }
  return result;
}
