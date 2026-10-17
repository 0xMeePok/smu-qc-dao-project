import { decodeFunctionData, encodeFunctionResult, multicall3Abi } from "viem";

function emptyAbiValue(parameter) {
  if (parameter.type === "tuple") return Object.fromEntries(parameter.components.map((item) => [item.name, emptyAbiValue(item)]));
  if (parameter.type === "bool") return false;
  if (parameter.type === "address") return `0x${"0".repeat(40)}`;
  if (parameter.type === "bytes32") return `0x${"0".repeat(64)}`;
  return 0n;
}

function encodeContractResult(abi, functionName, value) {
  const output = abi.find((item) => item.name === functionName)?.outputs?.[0];
  return encodeFunctionResult({
    abi, functionName,
    result: output?.type === "tuple" ? { ...emptyAbiValue(output), ...value } : value,
  });
}

/** Answer one eth_call, including a Multicall3 aggregate3 batch. */
export async function answerEthCall({ to, data, client, abiFor }) {
  let decoded = null;
  try { decoded = decodeFunctionData({ abi: multicall3Abi, data }); }
  catch { /* A direct contract call is decoded with the target ABI below. */ }
  if (decoded?.functionName === "aggregate3") {
    const results = [];
    for (const call of decoded.args[0]) {
      const abi = abiFor(call.target);
      const inner = decodeFunctionData({ abi, data: call.callData });
      const value = await client.readContract({ address: call.target, functionName: inner.functionName, args: inner.args });
      results.push({ success: true, returnData: encodeContractResult(abi, inner.functionName, value) });
    }
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
  }
  const abi = abiFor(to);
  const { functionName, args } = decodeFunctionData({ abi, data });
  const value = await client.readContract({ address: to, functionName, args });
  return encodeContractResult(abi, functionName, value);
}
