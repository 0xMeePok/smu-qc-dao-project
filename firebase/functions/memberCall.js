import { decodeEventLog, decodeFunctionData, hexToBigInt, parseAbi, size, slice } from "viem";

/**
 * Who called which contract with which calldata, whether the member sent the
 * transaction themselves or Privy sponsored its gas.
 *
 * A sponsored transaction (EIP-7702 + ERC-4337 paymaster) is sent by a bundler
 * to the EntryPoint as handleOps(...). The member's wallet is the user
 * operation's `sender`, and the real call is inside the account's
 * execute(...). The EntryPoint only runs an operation the member's wallet has
 * validated, and the target contract still sees the member as msg.sender, so
 * the unwrapped call proves the same facts as a direct transaction: this
 * wallet called this contract with this calldata. Anything else (several
 * calls, a try-mode execution, an unknown account) is refused, not guessed.
 */

// The canonical ERC-4337 EntryPoints that share the PackedUserOperation ABI.
export const ENTRY_POINTS = Object.freeze([
  "0x0000000071727de22e5e9d8baf0edac6f37da032", // v0.7
  "0x4337084d9e255ff0702461cf8895ce9e3b5ff108", // v0.8
  "0x433709009b8330fda32311df1c2afa402ed8d009", // v0.9
]);

export const ENTRY_POINT_ABI = parseAbi([
  "function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

const ACCOUNT_ABI = parseAbi([
  // Simple7702Account, Alchemy Modular Account, Coinbase Smart Wallet.
  "function execute(address target, uint256 value, bytes data)",
  // ERC-7579 accounts.
  "function execute(bytes32 mode, bytes executionCalldata)",
]);

const same = (left, right) => Boolean(left && right) && String(left).toLowerCase() === String(right).toLowerCase();

export const isEntryPoint = (address) => ENTRY_POINTS.some((entryPoint) => same(entryPoint, address));

function accountCall(callData) {
  let decoded;
  try { decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data: callData }); } catch { return null; }
  if (decoded.functionName !== "execute") return null;
  const [first, second, third] = decoded.args;
  if (decoded.args.length === 3) return { to: first, value: second, input: third };
  // ERC-7579 mode: byte 0 is the call type, byte 1 the exec type. Only a single
  // call (0x00) with revert-on-failure (0x00) is accepted; a try-mode call
  // could fail inside an operation the EntryPoint still reports as successful.
  if (slice(first, 0, 1) !== "0x00" || slice(first, 1, 2) !== "0x00" || size(second) < 52) return null;
  return { to: slice(second, 0, 20), value: hexToBigInt(slice(second, 20, 52)), input: size(second) === 52 ? "0x" : slice(second, 52) };
}

function userOperations(transaction, sender) {
  if (!transaction || !isEntryPoint(transaction.to)) return null;
  let decoded;
  try { decoded = decodeFunctionData({ abi: ENTRY_POINT_ABI, data: transaction.input }); } catch { return []; }
  const ops = decoded.functionName === "handleOps" ? decoded.args[0] : [];
  return sender ? ops.filter((op) => same(op.sender, sender)) : ops;
}

/**
 * The outcome the EntryPoint logged for `sender`'s operation in `receipt`:
 * true or false, or null when the receipt holds no operation from `sender`
 * (an ordinary transaction). A failed operation still mines in a successful
 * transaction, so receipt.status alone cannot say whether the call ran.
 */
export function userOperationSucceeded(receipt, sender, { nonce } = {}) {
  let outcome = null;
  for (const log of receipt?.logs ?? []) {
    if (!isEntryPoint(log.address)) continue;
    let event;
    try { event = decodeEventLog({ abi: ENTRY_POINT_ABI, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
    if (event.eventName !== "UserOperationEvent" || !same(event.args.sender, sender)) continue;
    if (nonce !== undefined && event.args.nonce !== nonce) continue;
    if (!event.args.success) return false;
    outcome = true;
  }
  return outcome;
}

/**
 * The call a transaction made on the member's behalf, without checking it ran:
 * enough to tell which contract it addressed. `sender` picks the member's
 * operation when a bundler batched several.
 */
export function decodeMemberCall(transaction, { sender } = {}) {
  if (!transaction) return null;
  const ops = userOperations(transaction, sender);
  if (ops === null) {
    return { from: transaction.from, to: transaction.to, input: transaction.input, value: transaction.value ?? 0n,
      chainId: transaction.chainId, sponsored: false };
  }
  if (ops.length !== 1) return null;
  const call = accountCall(ops[0].callData);
  return call && { ...call, from: ops[0].sender, chainId: transaction.chainId, sponsored: true, nonce: ops[0].nonce };
}

/**
 * decodeMemberCall, and for a sponsored transaction also proof from the
 * receipt that the member's operation succeeded. Null when either fails, so
 * every caller's existing "does not belong to this wallet" refusal applies.
 */
export function memberCall(transaction, receipt, { sender } = {}) {
  const call = decodeMemberCall(transaction, { sender });
  if (!call?.sponsored) return call;
  if (!receipt || !same(receipt.transactionHash, transaction.hash)) return null;
  return userOperationSucceeded(receipt, call.from, { nonce: call.nonce }) === true ? call : null;
}

/**
 * The member's call (`from` and `to`) for checks that start from a receipt. A
 * direct transaction's receipt already names both, so the transaction is read
 * only when the receipt shows a sponsored EntryPoint call.
 */
export async function memberCallFromReceipt(client, receipt, { sender } = {}) {
  if (!receipt) return null;
  if (!isEntryPoint(receipt.to)) return { from: receipt.from, to: receipt.to, sponsored: false };
  const transaction = await client.getTransaction({ hash: receipt.transactionHash });
  return memberCall(transaction, receipt, { sender });
}
