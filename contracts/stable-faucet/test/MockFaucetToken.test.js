import { expect } from "chai";
import { network } from "hardhat";

describe("MockFaucetToken", function () {
  async function deployFixture() {
    const { ethers } = await network.create();
    const [owner, recipient, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("MockFaucetToken");
    const token = await Factory.deploy("Mock USD Coin", "USDC", owner.address);
    await token.waitForDeployment();
    return { ethers, token, owner, recipient, other };
  }

  it("uses six decimals and mints exactly 10,000 tokens", async function () {
    const { token, recipient } = await deployFixture();
    await token.faucetMint(recipient.address);
    expect(await token.decimals()).to.equal(6);
    expect(await token.COOLDOWN()).to.equal(60n * 60n);
    expect(await token.balanceOf(recipient.address)).to.equal(10_000_000_000n);
  });

  it("enforces a per-recipient cooldown", async function () {
    const { token, recipient } = await deployFixture();
    await token.faucetMint(recipient.address);
    await expect(token.faucetMint(recipient.address)).to.be.revertedWithCustomError(
      token,
      "CooldownActive"
    );
  });

  it("allows another claim after one hour", async function () {
    const { ethers, token, recipient } = await deployFixture();
    await token.faucetMint(recipient.address);
    await ethers.provider.send("evm_increaseTime", [60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await token.faucetMint(recipient.address);
    expect(await token.balanceOf(recipient.address)).to.equal(20_000_000_000n);
  });

  it("rejects calls from anyone except the owner", async function () {
    const { token, recipient, other } = await deployFixture();
    await expect(token.connect(other).faucetMint(recipient.address))
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
      .withArgs(other.address);
  });
});
