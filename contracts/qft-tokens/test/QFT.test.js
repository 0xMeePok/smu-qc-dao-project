import { expect } from "chai";
import { network } from "hardhat";

describe("QFT fixed-supply token", function () {
  async function deployFixture() {
    const { ethers } = await network.create();
    const [deployer, holder, recipient, spender, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("QFT");
    const supply = ethers.parseUnits("1000000", 18);
    const token = await Factory.deploy(holder.address, supply);
    await token.waitForDeployment();
    return { ethers, Factory, token, supply, deployer, holder, recipient, spender, other };
  }

  it("assigns the entire fixed supply to the requested holder with QFT metadata", async function () {
    const { token, supply, deployer, holder } = await deployFixture();
    expect(await token.name()).to.equal("QFT");
    expect(await token.symbol()).to.equal("QFT");
    expect(await token.decimals()).to.equal(18);
    expect(await token.totalSupply()).to.equal(supply);
    expect(await token.balanceOf(holder.address)).to.equal(supply);
    expect(await token.balanceOf(deployer.address)).to.equal(0n);
  });

  it("conserves supply and balances when a holder transfers tokens", async function () {
    const { token, supply, holder, recipient } = await deployFixture();
    const amount = 123_456_789_012_345_678_901n;
    await expect(token.connect(holder).transfer(recipient.address, amount))
      .to.emit(token, "Transfer").withArgs(holder.address, recipient.address, amount);
    expect(await token.balanceOf(holder.address)).to.equal(supply - amount);
    expect(await token.balanceOf(recipient.address)).to.equal(amount);
    expect(await token.totalSupply()).to.equal(supply);
  });

  it("rejects transfers above the caller's balance without changing custody", async function () {
    const { token, supply, holder, recipient } = await deployFixture();
    await expect(token.connect(holder).transfer(recipient.address, supply + 1n))
      .to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientBalance"
      )
      .withArgs(holder.address, supply, supply + 1n);
    expect(await token.balanceOf(holder.address)).to.equal(supply);
    expect(await token.balanceOf(recipient.address)).to.equal(0n);
    expect(await token.totalSupply()).to.equal(supply);
  });

  it("lets only an approved spender transfer tokens and consumes the allowance", async function () {
    const { token, supply, holder, recipient, spender } = await deployFixture();
    await expect(token.connect(holder).approve(spender.address, 100n))
      .to.emit(token, "Approval").withArgs(holder.address, spender.address, 100n);
    await expect(token.connect(spender).transferFrom(holder.address, recipient.address, 40n))
      .to.emit(token, "Transfer").withArgs(holder.address, recipient.address, 40n);
    expect(await token.allowance(holder.address, spender.address)).to.equal(60n);
    expect(await token.balanceOf(holder.address)).to.equal(supply - 40n);
    expect(await token.balanceOf(recipient.address)).to.equal(40n);
    expect(await token.totalSupply()).to.equal(supply);
  });

  it("rejects an unapproved third party even when another spender is approved", async function () {
    const { token, supply, holder, recipient, spender, other } = await deployFixture();
    await token.connect(holder).approve(spender.address, 100n);
    await expect(token.connect(other).transferFrom(holder.address, recipient.address, 1n))
      .to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientAllowance"
      )
      .withArgs(other.address, 0n, 1n);
    expect(await token.allowance(holder.address, spender.address)).to.equal(100n);
    expect(await token.balanceOf(holder.address)).to.equal(supply);
    expect(await token.balanceOf(recipient.address)).to.equal(0n);
  });

  it("rejects spending above the allowance without consuming it or moving tokens", async function () {
    const { token, supply, holder, recipient, spender } = await deployFixture();
    await token.connect(holder).approve(spender.address, 100n);
    await expect(token.connect(spender).transferFrom(holder.address, recipient.address, 101n))
      .to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientAllowance"
      )
      .withArgs(spender.address, 100n, 101n);
    expect(await token.allowance(holder.address, spender.address)).to.equal(100n);
    expect(await token.balanceOf(holder.address)).to.equal(supply);
    expect(await token.balanceOf(recipient.address)).to.equal(0n);
  });

  it("honors an allowance revocation before a previously approved spender can spend", async function () {
    const { token, supply, holder, recipient, spender } = await deployFixture();
    await token.connect(holder).approve(spender.address, 100n);
    await token.connect(holder).approve(spender.address, 0n);
    await expect(token.connect(spender).transferFrom(holder.address, recipient.address, 1n))
      .to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientAllowance"
      )
      .withArgs(spender.address, 0n, 1n);
    expect(await token.allowance(holder.address, spender.address)).to.equal(0n);
    expect(await token.balanceOf(holder.address)).to.equal(supply);
    expect(await token.balanceOf(recipient.address)).to.equal(0n);
  });

  it("rejects a zero initial supply", async function () {
    const { Factory, holder } = await deployFixture();
    await expect(Factory.deploy(holder.address, 0n))
      .to.be.revertedWithCustomError(Factory, "ZeroInitialSupply");
  });

  it("rejects the zero address as the initial holder", async function () {
    const { ethers, Factory, supply } = await deployFixture();
    await expect(Factory.deploy(ethers.ZeroAddress, supply))
      .to.be.revertedWithCustomError(Factory, "ERC20InvalidReceiver")
      .withArgs(ethers.ZeroAddress);
  });

  it("rejects ETH attached to deployment", async function () {
    const { ethers, Factory, holder, supply } = await deployFixture();
    await expect(Factory.deploy(holder.address, supply, { value: 1n })).to.revert(ethers);
  });

  it("rejects direct ETH transfers without altering token balances", async function () {
    const { ethers, token, supply, deployer, holder } = await deployFixture();
    const address = await token.getAddress();
    await expect(deployer.sendTransaction({ to: address, value: 1n })).to.revert(ethers);
    expect(await ethers.provider.getBalance(address)).to.equal(0n);
    expect(await token.balanceOf(holder.address)).to.equal(supply);
    expect(await token.totalSupply()).to.equal(supply);
  });
});
