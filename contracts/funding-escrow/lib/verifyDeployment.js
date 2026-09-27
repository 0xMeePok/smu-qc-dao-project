import { Interface, getAddress, keccak256 } from "ethers";

function address(value) {
  const result = getAddress(value);
  if (/^0x0{40}$/i.test(result)) throw new Error("A nonzero deployment address is required.");
  return result;
}

/** Ignore only compiler-declared immutable slots, requiring each repeated slot to agree. */
export function runtimeMatches(code, artifact) {
  if (!/^0x[0-9a-f]+$/i.test(code) || code.length !== artifact.deployedBytecode?.length) return false;
  const actual = Buffer.from(code.slice(2), "hex");
  const expected = Buffer.from(artifact.deployedBytecode.slice(2), "hex");
  if (actual.length === 0 || actual.length > 24576) return false;
  const covered = new Set();
  for (const refs of Object.values(artifact.immutableReferences ?? {})) {
    let value;
    for (const { start, length } of refs) {
      if (!Number.isInteger(start) || start < 0 || length !== 32 || start + length > actual.length) return false;
      const bytes = actual.subarray(start, start + length).toString("hex");
      if (value !== undefined && bytes !== value) return false;
      value = bytes;
      for (let i = start; i < start + length; i++) {
        if (covered.has(i)) return false;
        covered.add(i);
      }
      actual.fill(0, start, start + length);
      expected.fill(0, start, start + length);
    }
  }
  return actual.equals(expected);
}

/** Read-only deployment identity checks; never creates a signer or submits a transaction. */
export async function verifyEscrowDeployment(provider, record, artifacts) {
  if (record.contractName !== "EscrowAuditRegistry" || record.entityIdScheme !== 2 || record.chainId !== 421614
      || record.status !== "ready" || record.registry?.status !== "confirmed" || record.factory?.status !== "confirmed"
      || record.wiring?.status !== "confirmed") throw new Error("A confirmed, fully wired escrow deployment record is required.");
  if (Number((await provider.getNetwork()).chainId) !== record.chainId) throw new Error("Wrong network.");
  const registryAddress = address(record.registry.address), factoryAddress = address(record.factory.address);
  const platform = address(record.platformSigner);
  if (artifacts.registry.contractName !== "EscrowAuditRegistry" || artifacts.factory.contractName !== "FundingEscrowFactory") {
    throw new Error("Incorrect registry or factory artifact.");
  }
  const [registryCode, factoryCode] = await Promise.all([provider.getCode(registryAddress), provider.getCode(factoryAddress)]);
  if (!runtimeMatches(registryCode, artifacts.registry) || !runtimeMatches(factoryCode, artifacts.factory)) {
    throw new Error("Deployed registry or factory bytecode mismatch.");
  }
  const read = async (target, artifact, name, args = []) => {
    const abi = new Interface(artifact.abi);
    const result = await provider.call({ to: target, data: abi.encodeFunctionData(name, args) });
    return abi.decodeFunctionResult(name, result)[0];
  };
  const [factory, registry, signer, registryOwner, factoryOwner, feeBps] = await Promise.all([
    read(registryAddress, artifacts.registry, "fundingFactory"), read(factoryAddress, artifacts.factory, "auditRegistry"),
    read(factoryAddress, artifacts.factory, "platformSigner"), read(registryAddress, artifacts.registry, "owner"),
    read(factoryAddress, artifacts.factory, "owner"), read(factoryAddress, artifacts.factory, "feeBps"),
  ]);
  if (address(factory) !== factoryAddress || address(registry) !== registryAddress || address(signer) !== platform) {
    throw new Error("Registry/factory wiring or platform signer mismatch.");
  }
  return { contractName: "EscrowAuditRegistry", address: registryAddress, factoryAddress,
    chainId: record.chainId, bytecodeMatches: true, wiringMatches: true, platformSigner: signer,
    registryOwner, factoryOwner, feeBps: Number(feeBps),
    registryCodeHash: keccak256(registryCode), factoryCodeHash: keccak256(factoryCode), readOnly: true };
}
