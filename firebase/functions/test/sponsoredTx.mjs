// Builds what a Privy-sponsored (EIP-7702 + ERC-4337) transaction looks like on chain.
import { concat, encodeAbiParameters, encodeEventTopics, encodeFunctionData, numberToHex, pad, parseAbi } from "viem";
import { ENTRY_POINT_ABI, ENTRY_POINTS } from "../memberCall.js";

export const ENTRY_POINT = ENTRY_POINTS[0];
export const BUNDLER = `0x${"b0".repeat(20)}`;
const ACCOUNT_ABI = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function execute(bytes32 mode, bytes executionCalldata)",
]);

export function accountCallData({ to, input, value = 0n, erc7579 = false, mode = "0x00" }) {
  if (!erc7579) return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execute", args: [to, value, input] });
  return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execute",
    args: [pad(mode, { dir: "right", size: 32 }), concat([to, numberToHex(value, { size: 32 }), input])] });
}

/** `calls`: [{ sender, to, input, success?, erc7579?, mode? }]. Returns { transaction, receipt }. */
export function sponsoredTransaction({ hash, calls, chainId = 421614, blockHash, blockNumber = 10n, logs = [] }) {
  const ops = calls.map((call, index) => ({
    sender: call.sender, nonce: BigInt(index), initCode: "0x", callData: call.callData ?? accountCallData(call),
    accountGasLimits: pad("0x01", { size: 32 }), preVerificationGas: 1n, gasFees: pad("0x01", { size: 32 }),
    paymasterAndData: "0x", signature: "0x",
  }));
  const events = ops.map((op, index) => ({
    address: ENTRY_POINT,
    topics: encodeEventTopics({ abi: ENTRY_POINT_ABI, eventName: "UserOperationEvent",
      args: { userOpHash: pad(numberToHex(index + 1), { size: 32 }), sender: op.sender, paymaster: BUNDLER } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
      [op.nonce, calls[index].success ?? true, 1n, 1n]),
  }));
  return {
    transaction: { hash, from: BUNDLER, to: ENTRY_POINT, chainId, blockHash, blockNumber, value: 0n,
      input: encodeFunctionData({ abi: ENTRY_POINT_ABI, functionName: "handleOps", args: [ops, BUNDLER] }) },
    receipt: { transactionHash: hash, status: "success", from: BUNDLER, to: ENTRY_POINT, blockHash, blockNumber, logs: [...logs, ...events] },
  };
}
