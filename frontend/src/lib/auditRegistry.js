import {
  estimateFeesPerGas as wagmiEstimateFeesPerGas,
  readContract as wagmiReadContract,
  waitForTransactionReceipt as wagmiWaitForTransactionReceipt,
  writeContract as wagmiWriteContract,
} from "wagmi/actions";
import {
  AUDIT_REGISTRY_ABI,
  AUDIT_REGISTRY_CHAIN_ID,
  getAuditRegistryAddress,
} from "../config/auditRegistry.js";
import { wagmiConfig } from "./wagmi.js";
import { isTransactionFeeTooLow } from "./errors.js";

export * from "../../../firebase/functions/auditCanonical.js";
import { MAX_AUDIT_RETRIES, MAX_ANCHOR_SCAN, assertBytes32, prepareOpportunityCommit, prepareProposalCommit, prepareProposalUpdate, prepareProposalWithdrawal } from "../../../firebase/functions/auditCanonical.js";

// Arbitrum has no priority auction, so estimateFeesPerGas legitimately returns a
// zero tip on Sepolia - and MetaMask then refuses to send, with "Priority fee must
// be greater than 0" in its own advanced-fee dialog. The transaction is fine; the
// wallet's validation is not satisfied by a zero. 0.01 gwei is the smallest value
// that clears it: at ~200k gas it costs about 2e-6 ETH of testnet funds.
const MIN_PRIORITY_FEE_WEI = 10_000_000n;

export function createWagmiAuditAdapters(config = wagmiConfig) {
  return {
    writeContract: async (request) => {
      const { maxFeePerGas, maxPriorityFeePerGas } = await wagmiEstimateFeesPerGas(config, {
        chainId: request.chainId,
        type: "eip1559",
      });
      if (typeof maxFeePerGas !== "bigint" || maxFeePerGas <= 0n
          || typeof maxPriorityFeePerGas !== "bigint" || maxPriorityFeePerGas < 0n
          || maxPriorityFeePerGas > maxFeePerGas) {
        throw new Error("Unable to estimate network fees. Please try again shortly.");
      }
      // Leave room for base-fee changes while the wallet confirmation is open.
      // This raises the spending cap, not the priority fee or gas units consumed.
      const feeCap = maxFeePerGas * 2n;
      // Never above the cap: a tip larger than the total fee is an invalid
      // transaction, which matters on a chain whose base fee is itself tiny.
      const priorityFee = maxPriorityFeePerGas > 0n
        ? maxPriorityFeePerGas
        : (MIN_PRIORITY_FEE_WEI < feeCap ? MIN_PRIORITY_FEE_WEI : feeCap);
      return wagmiWriteContract(config, {
        ...request,
        maxFeePerGas: feeCap,
        maxPriorityFeePerGas: priorityFee,
      });
    },
    waitForTransactionReceipt: (request) => wagmiWaitForTransactionReceipt(config, request),
    readContract: (request) => wagmiReadContract(config, request),
  };
}

function auditAdapters(adapters) {
  const resolved = adapters ?? createWagmiAuditAdapters();
  for (const method of ["writeContract", "waitForTransactionReceipt", "readContract"]) {
    if (typeof resolved[method] !== "function") {
      throw new TypeError(`Audit adapter is missing ${method}().`);
    }
  }
  return resolved;
}

function canonicalRegistryAddress(requestedAddress) {
  const configured = getAuditRegistryAddress();
  if (requestedAddress
      && String(requestedAddress).toLowerCase() !== configured.toLowerCase()) {
    throw new Error("AuditRegistry address does not match the configured deployment.");
  }
  return configured;
}

function cappedRetries(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.min(MAX_AUDIT_RETRIES, Math.trunc(Number(value))));
}

function errorText(error) {
  return [error?.name, error?.shortMessage, error?.message, error?.cause?.message]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function classifyAuditError(error, { attempt = 0, maxRetries = 0 } = {}) {
  const text = errorText(error);
  const code = error?.code ?? error?.cause?.code;
  let category = "unknown";
  if (code === 4001 || /userrejected|user rejected|denied transaction signature/.test(text)) {
    category = "user-rejected";
  } else if (isTransactionFeeTooLow(error)) {
    category = "fee-too-low";
  } else if (/contractfunctionreverted|execution reverted|revert|invalidinput|invalidstate|accessdenied/.test(text)) {
    category = "contract-reverted";
  } else if (/invalid address|missing or invalid|chain mismatch|unsupported chain|wrong network/.test(text)) {
    category = "configuration";
  } else if (/timeout|timed out|http|socket|network|fetch|rate limit|429|503|gateway/.test(text)) {
    category = "transient";
  }
  const retryLimit = cappedRetries(maxRetries);
  return Object.freeze({
    category,
    retryable: category === "transient" && attempt < retryLimit,
    attempt,
    maxRetries: retryLimit,
  });
}

async function retryRead(operation, maxRetries, onRetry) {
  const limit = cappedRetries(maxRetries);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const classification = classifyAuditError(error, { attempt, maxRetries: limit });
      if (!classification.retryable) {
        error.auditClassification = classification;
        throw error;
      }
      await onRetry?.({ attempt: attempt + 1, error, classification });
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

export async function waitForAuditReceipt({
  transactionHash,
  adapters,
  confirmations = 1,
  timeout = 120_000,
  maxRetries = 2,
  onRetry,
}) {
  const resolved = auditAdapters(adapters);
  const hash = assertBytes32(transactionHash, "Transaction hash");
  return retryRead(
    () => resolved.waitForTransactionReceipt({
      hash,
      chainId: AUDIT_REGISTRY_CHAIN_ID,
      confirmations,
      timeout,
    }),
    maxRetries,
    onRetry,
  );
}

async function status(onStatus, statusName, details = {}) {
  await onStatus?.(Object.freeze({ status: statusName, ...details }));
}

/** Writes once, then safely retries polling the same transaction hash. */
export async function executePreparedAudit(preparedAudit, {
  address,
  account,
  adapters,
  confirmations = 1,
  timeout = 120_000,
  maxReceiptRetries = 2,
  onStatus,
} = {}) {
  if (!preparedAudit?.__auditPrepared) throw new TypeError("A prepared audit operation is required.");
  const resolved = auditAdapters(adapters);
  const contractAddress = canonicalRegistryAddress(address);
  // Status callbacks are awaited in order. A caller may persist each transition;
  // letting those writes race can otherwise leave an older `pending` write landing
  // after `confirmed` and permanently regress the displayed receipt state.
  await status(onStatus, "queued", { prepared: preparedAudit });
  let transactionHash;
  try {
    transactionHash = await resolved.writeContract({
      address: contractAddress,
      abi: AUDIT_REGISTRY_ABI,
      functionName: preparedAudit.functionName,
      args: preparedAudit.args,
      account,
      chainId: AUDIT_REGISTRY_CHAIN_ID,
    });
  } catch (error) {
    await status(onStatus, "failed", { error, classification: classifyAuditError(error) });
    throw error;
  }

  await status(onStatus, "submitted", { transactionHash });
  await status(onStatus, "pending", { transactionHash });
  let receipt;
  try {
    receipt = await waitForAuditReceipt({
      transactionHash,
      adapters: resolved,
      confirmations,
      timeout,
      maxRetries: maxReceiptRetries,
      onRetry: (retry) => status(onStatus, "pending", { transactionHash, retry }),
    });
  } catch (error) {
    error.transactionHash = transactionHash;
    await status(onStatus, "failed", {
      transactionHash,
      error,
      classification: error.auditClassification ?? classifyAuditError(error),
    });
    throw error;
  }
  if (receipt?.status !== "success") {
    const error = new Error("AuditRegistry transaction reverted.");
    error.name = "AuditTransactionRevertedError";
    error.transactionHash = transactionHash;
    error.receipt = receipt;
    await status(onStatus, "failed", {
      transactionHash,
      error,
      classification: classifyAuditError(error),
    });
    throw error;
  }
  const result = Object.freeze({
    status: "confirmed",
    transactionHash,
    blockNumber: receipt.blockNumber,
    receipt,
    prepared: preparedAudit,
  });
  await status(onStatus, "confirmed", result);
  return result;
}

function asPrepared(input, prepare) {
  return input?.__auditPrepared ? input : prepare(input);
}

function preparedFor(input, prepare, functionName) {
  const operation = asPrepared(input, prepare);
  if (operation.functionName !== functionName) {
    throw new TypeError(`Expected a prepared ${functionName} operation.`);
  }
  return operation;
}

export function commitOpportunityAudit(input, options) {
  return executePreparedAudit(
    preparedFor(input, prepareOpportunityCommit, "commitOpportunity"),
    options,
  );
}

export function commitProposalAudit(input, options) {
  return executePreparedAudit(
    preparedFor(input, prepareProposalCommit, "commitProposal"),
    options,
  );
}

export function updateProposalAudit(input, options) {
  return executePreparedAudit(
    preparedFor(input, prepareProposalUpdate, "updateHashes"),
    options,
  );
}

export function withdrawProposalAudit(input, options) {
  return executePreparedAudit(
    preparedFor(input, prepareProposalWithdrawal, "withdrawProposal"),
    options,
  );
}

function tupleField(value, name, index) {
  return value?.[name] ?? value?.[index];
}

function sameHex(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function mismatch(mismatches, field, expected, actual, compare = Object.is) {
  if (!compare(expected, actual)) mismatches.push({ field, expected, actual });
}

async function readWithRetries(functionName, args, options) {
  const resolved = auditAdapters(options.adapters);
  const address = canonicalRegistryAddress(options.address);
  return retryRead(
    () => resolved.readContract({
      address,
      abi: AUDIT_REGISTRY_ABI,
      functionName,
      args,
      chainId: AUDIT_REGISTRY_CHAIN_ID,
    }),
    options.maxReadRetries ?? 2,
    options.onRetry,
  );
}

export async function readProposalIsAnchored(proposalId, options = {}) {
  const entityId = assertBytes32(proposalId, "Proposal id");
  try {
    return BigInt(await readWithRetries("revisionCount", [entityId], options)) > 0n;
  } catch (error) {
    if (/invalidinput|revert/i.test(error?.message ?? "")) return false;
    throw error;
  }
}

export async function readOpportunityRevisionIndex(opportunityId, options = {}) {
  const entityId = assertBytes32(opportunityId, "Opportunity id");
  const count = BigInt(await readWithRetries("opportunityRevisionCount", [entityId], options));
  if (count === 0n || count > 4_294_967_296n) {
    throw new Error("Opportunity has no supported revision.");
  }
  return Number(count - 1n);
}

async function findMatchingAnchor(entityId, expectedHash, options) {
  if (options.verifyAnchor === false) return null;
  const count = BigInt(await readWithRetries("anchorCount", [entityId], options));
  const scan = BigInt(Math.min(Number(count), MAX_ANCHOR_SCAN));
  for (let offset = 0n; offset < scan; offset += 1n) {
    const index = count - 1n - offset;
    const anchor = await readWithRetries("anchorAt", [entityId, index], options);
    if (sameHex(tupleField(anchor, "contentHash", 2), expectedHash)) {
      return {
        index,
        anchor,
      };
    }
  }
  return { anchor: null };
}

function verification(preparedAudit, actual, anchor, mismatches) {
  if (anchor && !anchor.anchor) {
    mismatches.push({ field: "anchor", expected: preparedAudit.anchorHash, actual: null });
  }
  return Object.freeze({
    verified: mismatches.length === 0,
    status: mismatches.length === 0 ? "verified" : "mismatch",
    mismatches: Object.freeze(mismatches),
    expected: preparedAudit,
    actual,
    anchor,
  });
}

export async function verifyOpportunityAudit(input, options = {}) {
  const expected = asPrepared(input, prepareOpportunityCommit);
  const actual = await readWithRetries("getOpportunity", [expected.entityId], options);
  const mismatches = [];
  if (expected.expectedOwner) {
    mismatch(mismatches, "owner", expected.expectedOwner,
      tupleField(actual, "owner", 0), sameHex);
  }
  mismatch(mismatches, "contentHash", expected.contentHash,
    tupleField(actual, "contentHash", 2), sameHex);
  mismatch(mismatches, "kind", Number(expected.args[1]),
    Number(tupleField(actual, "kind", 1)));
  mismatch(mismatches, "expiresAt", expected.args[3],
    BigInt(tupleField(actual, "expiresAt", 5)));
  const anchor = await findMatchingAnchor(
    expected.entityId, expected.anchorHash, options,
  );
  return verification(expected, actual, anchor, mismatches);
}

export async function verifyProposalAudit(input, options = {}) {
  const expected = asPrepared(input, prepareProposalCommit);
  const actual = await readWithRetries("getProposal", [expected.entityId], options);
  const mismatches = [];
  if (expected.expectedResearcher) {
    mismatch(mismatches, "researcher", expected.expectedResearcher, tupleField(actual, "researcher", 0), sameHex);
  }
  mismatch(mismatches, "opportunityId", expected.opportunityId,
    tupleField(actual, "opportunityId", 1), sameHex);
  mismatch(mismatches, "opportunityRevisionIndex", expected.expectedOpportunityRevisionIndex,
    Number(tupleField(actual, "opportunityRevisionIndex", 2)));
  mismatch(mismatches, "proposalHash", expected.proposalHash,
    tupleField(actual, "proposalHash", 4), sameHex);
  mismatch(mismatches, "solutionHash", expected.solutionHash,
    tupleField(actual, "solutionHash", 5), sameHex);
  const anchor = await findMatchingAnchor(
    expected.entityId, expected.anchorHash, options,
  );
  return verification(expected, actual, anchor, mismatches);
}
