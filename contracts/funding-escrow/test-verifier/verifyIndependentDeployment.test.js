import { expect } from "chai";
import { network } from "hardhat";
import { loadIndependentArtifacts, verifyIndependentDeployment, independentConfig } from "../lib/independentDeployment.js";

// Coverage instrumentation changes deployed bytecode. Run this strict identity
// check separately against the production build, alongside the existing verifier.
describe("Read-only independent funding deployment verifier", function () {
  it("verifies actual deployed runtime immutable slots and exports only confirmed deployment configs", async function () {
    const { ethers } = await network.create({ override: { chainId: 421614 } });
    const [platform, owner] = await ethers.getSigners();
    const token = await ethers.deployContract("EscrowTestToken", [6]);
    const tokenAddress = await token.getAddress();
    const registry = await ethers.deployContract("EscrowAuditRegistry", [owner.address]);
    const registryAddress = await registry.getAddress();
    const policy = await ethers.deployContract("FundingEscrowFactory", [owner.address, platform.address, [tokenAddress], 0, registryAddress]);
    await registry.connect(owner).setFundingFactory(await policy.getAddress());
    const factory = await ethers.deployContract("IndependentFundingFactory", [await policy.getAddress()]);
    const deployment = await factory.deploymentTransaction().wait();
    const artifacts = await loadIndependentArtifacts();
    const record = { contractName: "IndependentFundingFactory", chainId: 421614, status: "ready",
      deploymentBlock: deployment.blockNumber, factoryAddress: await factory.getAddress(),
      registryAddress, tokenRegistryAddress: await policy.getAddress(), platformSigner: platform.address,
      tokens: [{ address: tokenAddress, decimals: 6, symbol: "TEST" }] };
    const nonce = await ethers.provider.getTransactionCount(owner.address);
    record.runtimeVerification = await verifyIndependentDeployment(ethers.provider, record, artifacts);
    expect(record.runtimeVerification.bytecodeMatches).to.equal(true);
    expect(record.runtimeVerification.readOnly).to.equal(true);
    expect(await ethers.provider.getTransactionCount(owner.address)).to.equal(nonce);
    expect(independentConfig(record, artifacts).enabled).to.equal(true);
    expect(() => independentConfig({ ...record, runtimeVerification: null }, artifacts)).to.throw(/verified/);
    await expect(verifyIndependentDeployment(ethers.provider, { ...record, platformSigner: owner.address }, artifacts))
      .to.be.rejectedWith("mismatch");
  });
});
