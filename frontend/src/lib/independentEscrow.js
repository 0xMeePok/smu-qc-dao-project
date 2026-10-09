import { httpsCallable } from "firebase/functions";
import { erc20Abi, formatUnits } from "viem";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { AUDIT_REGISTRY_CHAIN_ID } from "../config/auditRegistry.js";
import { auditErrorMessage, isRpcQuotaExceeded, isRpcUnreachable } from "./errors.js";
import independentConfig from "../config/independentFunding.contract.json" with { type: "json" };
import { INDEPENDENT_FUNDING_LABELS, INDEPENDENT_FUNDING_STATE as S } from "../config/workflowStatus.js";

async function call(name, payload = {}) {
  requireFirebase();
  return (await httpsCallable(functions, name)(payload)).data;
}
export const getIndependentFundingState = payload => call("getIndependentFundingState", payload);
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

function abiValue(value, input) {
  if (/^(u?int)(\d+)?$/.test(input.type)) return BigInt(value);
  if (input.type.endsWith("[]")) return value.map(item => abiValue(item, { ...input, type: input.type.slice(0, -2) }));
  if (input.type === "tuple") return input.components.map((component, index) => abiValue(value?.[component.name] ?? value?.[index], component));
  return value;
}

/** All calldata comes from the server's verified listing/escrow preparation. */
export async function writeIndependentFundingAction({ proposalId, action, account, amount, evidence, evidenceHash, approve, reason,
  adapters, prepare = prepareIndependentFundingAction, onChange }) {
  if (!account) throw new Error("Connect the wallet you are signed in with.");
  onChange?.({ status: "preparing", action });
  const { createWagmiEscrowAdapters, confirmEscrowTransaction, hashEscrowEvidence } = await import("./escrow.js");
  adapters ??= createWagmiEscrowAdapters();
  const hash = action === "submitEvidence" ? hashEscrowEvidence(evidence) : evidenceHash;
  const declineReason = action === "decline" ? String(reason ?? "").trim().normalize("NFC") : null;
  if (declineReason !== null && (declineReason.length < 10 || declineReason.length > 2000)) {
    throw new Error("Enter a decline reason of 10–2,000 characters.");
  }
  const prepared = await prepare({ proposalId, action, ...(amount !== undefined ? { amount } : {}),
    ...(hash ? { evidenceHash: hash } : {}), ...(evidence ? { evidence } : {}), ...(approve !== undefined ? { approve } : {}),
    ...(declineReason !== null ? { reason: declineReason } : {}) });
  if (prepared.chainId !== AUDIT_REGISTRY_CHAIN_ID) throw new Error("Switch your wallet to Arbitrum Sepolia.");
  const spec = prepared.abi?.find(item => item.type === "function" && item.name === prepared.functionName);
  if (!spec || !Array.isArray(prepared.args) || spec.inputs.length !== prepared.args.length) throw new Error("The funding transaction could not be prepared. Refresh and retry.");
  const send = async (request, step) => {
    onChange?.({ status: "preparing", action: step });
    const transactionHash = await adapters.writeContract({ ...request, account, chainId: prepared.chainId }, {
      onWalletRequest: () => onChange?.({ status: "awaiting_signature", action: step }),
    });
    onChange?.({ status: "pending", action: step, transactionHash });
    try {
      const confirmed = await confirmEscrowTransaction(transactionHash, { adapters });
      onChange?.({ status: "confirmed", action: step, transactionHash });
      return confirmed;
    } catch (error) { error.action = step; throw error; }
  };
  if (action === "deposit") {
    const amountBaseUnits = BigInt(prepared.amountBaseUnits);
    const tokenRequest = { address: prepared.tokenAddress, abi: erc20Abi, chainId: prepared.chainId };
    const [balance, allowance] = await Promise.all([
      adapters.readContract({ ...tokenRequest, functionName: "balanceOf", args: [account] }),
      adapters.readContract({ ...tokenRequest, functionName: "allowance", args: [account, prepared.address] }),
    ]);
    if (amountBaseUnits <= 0n || amountBaseUnits > BigInt(balance)) throw new Error("Enter a positive contribution within your wallet's token balance.");
    if (BigInt(allowance) < amountBaseUnits) {
      if (BigInt(allowance) > 0n) await send({ address: prepared.tokenAddress, abi: erc20Abi,
        functionName: "approve", args: [prepared.address, 0n] }, "resetAllowance");
      await send({ address: prepared.tokenAddress, abi: erc20Abi,
        functionName: "approve", args: [prepared.address, amountBaseUnits] }, "approve");
    }
  }
  return send({ address: prepared.address, abi: prepared.abi, functionName: prepared.functionName,
    args: prepared.args.map((value, index) => abiValue(value, spec.inputs[index])) }, action);
}

/** Called only after the listing has been successfully saved and attested. */
export async function activateIndependentFunding(proposalId, { account, adapters, onProgress } = {}) {
  const result = await writeIndependentFundingAction({ proposalId, action: "activate", account, adapters, onChange: onProgress });
  try { await syncIndependentFunding({ proposalId, transactionHash: result.transactionHash }); }
  catch (error) { error.transactionHash = result.transactionHash; error.action = "activate"; throw error; }
  return result;
}
