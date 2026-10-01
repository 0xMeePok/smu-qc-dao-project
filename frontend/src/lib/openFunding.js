import { httpsCallable } from "firebase/functions";
import { erc20Abi } from "viem";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { confirmEscrowTransaction, createWagmiEscrowAdapters, escrowErrorMessage } from "./escrow.js";
import { fundingAmountUnits } from "../../../firebase/functions/escrowProposalTerms.js";

async function call(name, payload = {}) {
  requireFirebase();
  return (await httpsCallable(functions, name)(payload)).data;
}

export const getOpenFundingSummary = payload => call("getOpenFundingSummary", payload);
export const prepareOpenFundingAction = payload => call("prepareOpenFundingAction", payload);
export const syncOpenFunding = payload => call("syncOpenFunding", payload);
export const getFunderDashboard = () => call("getFunderDashboard");
export const openFundingSupported = (config = AUDIT_REGISTRY_CONFIG) =>
  Boolean(config.escrow?.openFundingPoolAbi?.length && config.escrow?.factoryAbi?.some(item => item.name === "createOpenFundingPool"));

const ACTIONS = Object.freeze({ create: "createOpenFundingPool", deposit: "deposit", select: "selectProposal",
  accept: "acceptProposal", void: "expireProposal", withdraw: "withdrawAvailable" });
const same = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** Only a user action submits a transaction. Failed confirmation retains its hash. */
export async function writeOpenFundingAction({ problemId, proposalId, account, action, amount, tokenAddress,
  decimals, onProgress, adapters = createWagmiEscrowAdapters(), config = AUDIT_REGISTRY_CONFIG,
  prepare = prepareOpenFundingAction }) {
  if (!openFundingSupported(config)) throw new Error("Open funding pools are awaiting a contract deployment.");
  if (!Object.hasOwn(ACTIONS, action)) throw new Error("Unknown open funding action.");
  const amountBaseUnits = ["deposit", "withdraw"].includes(action) ? fundingAmountUnits(amount, decimals).toString() : undefined;
  const prepared = await prepare({ problemId, proposalId, action, amountBaseUnits, tokenAddress });
  const request = prepared.request ?? prepared;
  const abi = action === "create" ? config.escrow.factoryAbi : config.escrow.openFundingPoolAbi;
  const method = abi.find(item => item.type === "function" && item.name === ACTIONS[action]);
  if (prepared.chainId !== config.chainId || request.functionName !== ACTIONS[action] || !method
      || !/^0x[0-9a-f]{40}$/i.test(request.address ?? "")
      || (action === "create" && !same(request.address, config.escrow.factoryAddress))
      || (action !== "create" && !same(request.address, prepared.poolAddress))
      || !Array.isArray(request.args) || request.args.length !== method.inputs.length) {
    throw new Error("The funding transaction does not match the configured deployment. Refresh before continuing.");
  }
  const args = method.inputs.map((input, index) => input.type.startsWith("uint") ? BigInt(request.args[index]) : request.args[index]);
  if (amountBaseUnits && (prepared.tokenDecimals !== decimals || String(args[0]) !== amountBaseUnits)) {
    throw new Error("The token or amount changed. Refresh before continuing.");
  }
  const send = async (functionName, args, address = request.address, contractAbi = abi) => {
    let transactionHash;
    try {
      onProgress?.({ status: "awaiting_signature", action: functionName });
      transactionHash = await adapters.writeContract({ address, abi: contractAbi, functionName, args, account, chainId: config.chainId });
      onProgress?.({ status: "pending", action: functionName, transactionHash });
      const result = await confirmEscrowTransaction(transactionHash, { adapters, config, confirmations: 2 });
      onProgress?.({ status: "confirmed", action: functionName, transactionHash: result.transactionHash });
      return result;
    } catch (cause) {
      throw Object.assign(new Error(escrowErrorMessage(cause), { cause }), {
        transactionHash, terminal: cause.terminal, transactionSettled: cause.transactionSettled,
      });
    }
  };
  if (action === "deposit") {
    const units = BigInt(amountBaseUnits);
    const read = (functionName, args) => adapters.readContract({ address: prepared.tokenAddress, abi: erc20Abi,
      functionName, args, chainId: config.chainId });
    const [balance, allowance] = await Promise.all([read("balanceOf", [account]), read("allowance", [account, request.address])]);
    if (BigInt(balance) < units) throw new Error(`Your ${prepared.tokenSymbol} balance is too low for that deposit.`);
    if (BigInt(allowance) < units) {
      if (BigInt(allowance) > 0n) await send("approve", [request.address, 0n], prepared.tokenAddress, erc20Abi);
      await send("approve", [request.address, units], prepared.tokenAddress, erc20Abi);
    }
  }
  return send(request.functionName, args);
}
