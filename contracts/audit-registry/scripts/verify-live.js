import fs from "node:fs";
import { Interface, JsonRpcProvider, concat, dataSlice, keccak256, toUtf8Bytes } from "ethers";
import "dotenv/config";

// Read-only checks: eth_getCode and eth_call, never a signed transaction.
const deployment = JSON.parse(fs.readFileSync(new URL("../manifests/arbitrumSepolia.json", import.meta.url)));
const artifact = JSON.parse(fs.readFileSync(new URL("../artifacts/contracts/AuditRegistry.sol/AuditRegistry.json", import.meta.url)));
const rpc = new JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);
try {
  if (Number((await rpc.getNetwork()).chainId) !== 421614) throw new Error("Wrong network");
  if (keccak256(await rpc.getCode(deployment.address)) !== keccak256(artifact.deployedBytecode)) throw new Error("Deployed bytecode mismatch");
  const abi = new Interface(artifact.abi), owner = deployment.deployer;
  const attacker = "0x1111111111111111111111111111111111111111";
  const id = concat([owner, dataSlice(keccak256(toUtf8Bytes("QCDAO replacement registry read-only check")), 0, 12)]);
  const latest = await rpc.getBlock("latest");
  const data = abi.encodeFunctionData("commitOpportunity", [id, 0, keccak256(toUtf8Bytes("read-only content")), latest.timestamp + 3600]);
  await rpc.call({ to: deployment.address, from: owner, data });
  let denied = false;
  try { await rpc.call({ to: deployment.address, from: attacker, data }); }
  catch (error) { denied = error.data?.slice(0, 10) === abi.getError("AccessDenied").selector; }
  if (!denied) throw new Error("Foreign actor was not rejected with AccessDenied");
  console.log(JSON.stringify({ address: deployment.address, chainId: 421614, bytecodeMatches: true, intendedActorAccepted: true, foreignActorRejected: true, readOnly: true }));
} catch {
  console.error("Live registry verification failed. No transaction was submitted.");
  process.exitCode = 1;
} finally { rpc.destroy(); }
