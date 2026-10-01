import { expect } from "chai";
import fs from "node:fs";
import { fixture } from "../test/helpers.js";
import { runtimeMatches, verifyEscrowDeployment } from "../lib/verifyDeployment.js";
import { creationHelpersFromFactoryBuild, loadEscrowDeploymentArtifacts } from "../lib/deploymentArtifacts.js";

const load = name => JSON.parse(fs.readFileSync(new URL(`../artifacts/contracts/${name}.sol/${name}.json`, import.meta.url)));

async function setup() {
  const c = await fixture();
  const record = { contractName: "EscrowAuditRegistry", entityIdScheme: 2, chainId: 421614, status: "ready",
    registry: { address: c.registryAddress, status: "confirmed" },
    factory: { address: await c.factory.getAddress(), status: "confirmed" },
    wiring: { status: "confirmed" }, platformSigner: c.platform.address };
  // All execution stays on the isolated Hardhat chain; only the reported chain
  // identifier is adapted to exercise the verifier's Arbitrum Sepolia policy.
  const provider = { getNetwork: async () => ({ chainId: 421614n }),
    getCode: address => c.ethers.provider.getCode(address), call: request => c.ethers.provider.call(request) };
  const artifacts = await loadEscrowDeploymentArtifacts();
  return { c, record, provider, artifacts };
}

describe("Read-only linked registry deployment verifier", function () {
  it("verifies actual locally deployed registry/factory bytecode, immutable addresses and wiring without transactions", async function () {
    const { c, record, provider, artifacts } = await setup();
    const nonce = await c.ethers.provider.getTransactionCount(c.admin.address);
    const result = await verifyEscrowDeployment(provider, record, artifacts);
    expect(result.bytecodeMatches).to.equal(true);
    expect(result.wiringMatches).to.equal(true);
    expect(result.readOnly).to.equal(true);
    expect(result.factoryAddress).to.equal(await c.factory.getAddress());
    expect(result.openFundingGrants).to.equal(true);
    expect(result.escrowDeployer).to.equal(await c.factory.escrowDeployer());
    expect(await c.ethers.provider.getTransactionCount(c.admin.address)).to.equal(nonce);
  });
  it("rejects the wrong chain and incomplete deployment records", async function () {
    const { record, provider, artifacts } = await setup();
    await expect(verifyEscrowDeployment({ ...provider, getNetwork: async () => ({ chainId: 1n }) }, record, artifacts)).to.be.rejectedWith("Wrong network");
    for (const patch of [{ status: "started" }, { entityIdScheme: 1 }, { wiring: { status: "broadcast" } }]) {
      await expect(verifyEscrowDeployment(provider, { ...record, ...patch }, artifacts)).to.be.rejectedWith("confirmed");
    }
  });
  it("rejects a different factory, wrong platform signer and altered runtime code", async function () {
    const { c, record, provider, artifacts } = await setup();
    const another = await c.ethers.deployContract("FundingEscrowFactory", [c.admin.address, c.platform.address,
      [c.tokenAddress], 0, c.registryAddress]);
    await expect(verifyEscrowDeployment(provider, { ...record, factory: { ...record.factory, address: await another.getAddress() } }, artifacts)).to.be.rejectedWith("wiring");
    await expect(verifyEscrowDeployment(provider, { ...record, platformSigner: c.alice.address }, artifacts)).to.be.rejectedWith("signer mismatch");
    const changed = { ...provider, getCode: async address => {
      const code = await provider.getCode(address);
      return address === record.factory.address ? `0x00${code.slice(4)}` : code;
    } };
    await expect(verifyEscrowDeployment(changed, record, artifacts)).to.be.rejectedWith("bytecode mismatch");
  });
  it("does not ignore inconsistent repeated immutable values", async function () {
    const { provider, record, artifacts } = await setup();
    const code = await provider.getCode(record.factory.address);
    const refs = Object.values(artifacts.factory.immutableReferences).find(items => items.length > 1);
    expect(refs).to.not.equal(undefined);
    const offset = 2 + (refs[0].start + 31) * 2;
    const byte = code.slice(offset, offset + 2) === "00" ? "01" : "00";
    const changed = code.slice(0, offset) + byte + code.slice(offset + 2);
    expect(runtimeMatches(changed, artifacts.factory)).to.equal(false);
    expect(runtimeMatches(code, artifacts.factory)).to.equal(true);
  });
  it("reports legitimate fee changes without confusing them with bytecode changes", async function () {
    const { c, record, provider, artifacts } = await setup();
    await c.factory.connect(c.admin).setFeeBps(10);
    expect((await verifyEscrowDeployment(provider, record, artifacts)).feeBps).to.equal(10);
  });
  it("rejects unverified or mismatched creation helpers", async function () {
    const { c, record, provider, artifacts } = await setup();
    await expect(verifyEscrowDeployment(provider, record, { ...artifacts, escrowDeployer: undefined }))
      .to.be.rejectedWith("helper artifacts");
    await expect(verifyEscrowDeployment(provider, { ...record, openFundingPoolDeployer: { address: c.other.address } }, artifacts))
      .to.be.rejectedWith("helper deployment record mismatch");
    const helper = await c.factory.openFundingPoolDeployer();
    const changed = { ...provider, getCode: async address => address === helper ? "0x00" : provider.getCode(address) };
    await expect(verifyEscrowDeployment(changed, record, artifacts)).to.be.rejectedWith("helper bytecode or wiring mismatch");
  });
  it("keeps the staged application ABIs identical to the compiled production interfaces", function () {
    const staged = JSON.parse(fs.readFileSync(new URL("../../../firebase/functions/escrowRegistry.abis.json", import.meta.url)));
    expect(staged.registry).to.deep.equal(load("EscrowAuditRegistry").abi);
    expect(staged.factory).to.deep.equal(load("FundingEscrowFactory").abi);
    expect(staged.escrow).to.deep.equal(load("FundingEscrow").abi);
    expect(staged.openFundingPool).to.deep.equal(load("OpenFundingPool").abi);
  });
  it("verifies embedded helper metadata from the factory compilation without discarding metadata bytes", async function () {
    const { c, artifacts } = await setup();
    const code = await c.ethers.provider.getCode(await c.factory.escrowDeployer());
    expect(runtimeMatches(code, artifacts.escrowDeployer)).to.equal(true);
    const offset = artifacts.escrowDeployer.deployedBytecode.length - 30;
    const changed = code.slice(0, offset) + (code.slice(offset, offset + 2) === "00" ? "01" : "00") + code.slice(offset + 2);
    expect(runtimeMatches(changed, artifacts.escrowDeployer)).to.equal(false);
    const output = JSON.parse(fs.readFileSync(new URL(`../artifacts/build-info/${artifacts.factory.buildInfoId}.output.json`, import.meta.url)));
    expect(() => creationHelpersFromFactoryBuild({ ...artifacts.factory, bytecode: "0x00" }, output)).to.throw("does not match");
    const missing = structuredClone(output);
    delete missing.output.contracts["project/contracts/FundingEscrowDeployer.sol"];
    expect(() => creationHelpersFromFactoryBuild(artifacts.factory, missing)).to.throw("missing");
  });
});
