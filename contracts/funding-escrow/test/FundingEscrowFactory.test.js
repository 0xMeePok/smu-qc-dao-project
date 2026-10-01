import { expect } from "chai";
import { fixture, createProposal, scopedId, terms, at, approve, fund, assertAccounting, Status } from "./helpers.js";

describe("FundingEscrowFactory: configuration and proposal isolation", function () {
  it("rejects invalid factory configuration", async function () {
    const c = await fixture();
    const Factory = await c.ethers.getContractFactory("FundingEscrowFactory");
    await expect(Factory.deploy(c.ethers.ZeroAddress, c.platform.address, [c.tokenAddress], 0, c.registryAddress)).to.be.revertedWithCustomError(c.factory, "OwnableInvalidOwner");
    for (const [signer, tokens, bps] of [
      [c.ethers.ZeroAddress, [c.tokenAddress], 0], [c.platform.address, [], 0],
      [c.platform.address, [c.ethers.ZeroAddress], 0], [c.platform.address, [c.other.address], 0],
      [c.platform.address, [c.tokenAddress, c.tokenAddress], 0], [c.platform.address, [c.tokenAddress], 10001],
    ]) {
      await expect(Factory.deploy(c.admin.address, signer, tokens, bps, c.registryAddress)).to.be.revertedWithCustomError(c.factory, "InvalidInput");
    }
  });

  it("rejects invalid immutable escrow terms", async function () {
    const c = await fixture();
    const Escrow = await c.ethers.getContractFactory("FundingEscrow");
    const valid = { postingId: c.postingId, proposalId: c.proposalId, token: c.tokenAddress,
      platformSigner: c.platform.address, problemOwner: c.owner.address, proposalOwner: c.solution.address,
      target: c.target, expiresAt: c.expiresAt, feeRecipient: c.admin.address, feeBps: 0,
      factory: await c.factory.getAddress(), auditRegistry: c.registryAddress, funderVoting: false };
    const now = (await c.ethers.provider.getBlock("latest")).timestamp;
    for (const [key, value] of [
      ["postingId", c.ethers.ZeroHash], ["proposalId", c.ethers.ZeroHash], ["token", c.ethers.ZeroAddress],
      ["token", c.other.address], ["platformSigner", c.ethers.ZeroAddress], ["problemOwner", c.ethers.ZeroAddress],
      ["proposalOwner", c.ethers.ZeroAddress], ["proposalOwner", c.owner.address], ["target", 0n],
      ["expiresAt", BigInt(now)], ["feeRecipient", c.ethers.ZeroAddress], ["feeBps", 10001],
      ["factory", c.ethers.ZeroAddress], ["factory", c.other.address], ["auditRegistry", c.other.address],
    ]) {
      await expect(Escrow.deploy({ ...valid, [key]: value }, [10000], [86400], [c.reason]))
        .to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    }
  });

  it("prevents ID squatting, unsupported tokens and duplicate proposals", async function () {
    const c = await fixture();
    const next = scopedId(c, c.solution, "proposal-2");
    await expect(c.factory.connect(c.other).createEscrow(next, terms(c)))
      .to.be.revertedWithCustomError(c.factory, "AccessDenied");
    const unsupported = await c.ethers.deployContract("EscrowTestToken", [6]);
    await expect(createProposal(c, "proposal-2", { token: await unsupported.getAddress() }))
      .to.be.revertedWithCustomError(c.factory, "UnsupportedToken");
    await expect(createProposal(c, "proposal-1")).to.be.revertedWithCustomError(c.registry, "InvalidInput");
    expect(await c.factory.escrowForProposal(next)).to.equal(c.ethers.ZeroAddress);
  });

  it("keeps creation-helper authority separate from the canonical escrow factory", async function () {
    const c = await fixture();
    const factoryAddress = await c.factory.getAddress();
    const helper = await c.ethers.getContractAt("FundingEscrowDeployer", await c.factory.escrowDeployer());
    const init = { postingId: c.postingId, proposalId: scopedId(c, c.solution, "helper-bypass"), token: c.tokenAddress,
      platformSigner: c.platform.address, problemOwner: c.owner.address, proposalOwner: c.solution.address,
      target: c.target, expiresAt: c.expiresAt, feeRecipient: c.admin.address, feeBps: 0,
      factory: factoryAddress, auditRegistry: c.registryAddress, funderVoting: false };
    await expect(helper.connect(c.other).deploy(init, terms(c))).to.be.revertedWithCustomError(helper, "AccessDenied");
    expect(await helper.factory()).to.equal(factoryAddress);
    expect(await c.escrow.tokenRegistry()).to.equal(factoryAddress);
    expect(await c.escrow.auditRegistry()).to.equal(c.registryAddress);
    expect(await c.escrow.feeRecipient()).to.equal(c.admin.address);
    expect(await c.factory.escrowForProposal(c.proposalId)).to.equal(c.escrowAddress);
  });

  it("does not reserve a proposal ID if creation fails", async function () {
    const c = await fixture();
    const next = scopedId(c, c.solution, "proposal-2");
    await expect(createProposal(c, "proposal-2", { target: 0n }))
      .to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    expect(await c.factory.escrowForProposal(next)).to.equal(c.ethers.ZeroAddress);
    await expect(c.registry.getProposal(next)).to.be.revertedWithCustomError(c.registry, "InvalidInput");
    await createProposal(c, "proposal-2");
    expect(await c.factory.escrowForProposal(next)).not.to.equal(c.ethers.ZeroAddress);
  });

  it("supports each configured token in separate escrows without mixing decimal units", async function () {
    const c = await fixture();
    const token18 = await c.ethers.deployContract("EscrowTestToken", [18]);
    await c.factory.connect(c.admin).setTokenAllowed(await token18.getAddress(), true);
    for (const [token, target, label] of [[c.token, 10n ** 6n, "six"], [token18, 10n ** 18n, "eighteen"]]) {
      const proposalId = scopedId(c, c.solution, label);
      await createProposal(c, label, { token: await token.getAddress(), target });
      const escrow = await c.ethers.getContractAt("FundingEscrow", await c.factory.escrowForProposal(proposalId));
      await token.mint(c.alice.address, target);
      await token.connect(c.alice).approve(await escrow.getAddress(), target);
      await escrow.connect(c.alice).deposit(target);
      expect(await escrow.totalDeposited()).to.equal(target);
      expect(await escrow.token()).to.equal(await token.getAddress());
    }
  });

  it("keeps one user's top-ups, release and refund status separate across proposals in a posting", async function () {
    const c = await fixture();
    const secondId = scopedId(c, c.solution, "proposal-2");
    await createProposal(c, "proposal-2", { target: 500n });
    const secondAddress = await c.factory.escrowForProposal(secondId);
    const second = await c.ethers.getContractAt("FundingEscrow", secondAddress);
    await c.token.connect(c.alice).approve(secondAddress, 500n);
    await second.connect(c.alice).deposit(75n);
    await second.connect(c.alice).deposit(125n);
    await approve(c); await c.escrow.release(c.selectionId);
    expect(await c.token.balanceOf(secondAddress)).to.equal(200n);
    expect((await second.depositorSummary(c.alice.address)).depositCount).to.equal(2n);
    await at(c, c.expiresAt); await second.connect(c.alice).claimRefund();
    expect([...(await second.depositorSummary(c.alice.address))]).to.deep.equal([200n, 2n, 200n, 0n, 0n, Status.Refunded]);
    expect((await c.escrow.depositorSummary(c.alice.address)).status).to.equal(Status.Released);
    expect(await c.escrow.contributions(c.alice.address)).to.equal(1000n);
    const registryEvents = await c.factory.queryFilter(c.factory.filters.EscrowCreated(c.postingId));
    expect(registryEvents.map(log => log.args.proposalId)).to.deep.equal([c.proposalId, secondId]);
    await assertAccounting(c);
  });

  it("allows only the contract owner to list and delist deployed token contracts", async function () {
    const c = await fixture();
    const next = await c.ethers.deployContract("EscrowTestToken", [6]);
    const nextAddress = await next.getAddress();
    expect(await c.factory.getAllowedTokens()).to.deep.equal([c.tokenAddress]);
    for (const who of [c.platform, c.owner, c.alice]) {
      await expect(c.factory.connect(who).setTokenAllowed(nextAddress, true))
        .to.be.revertedWithCustomError(c.factory, "OwnableUnauthorizedAccount");
    }
    for (const invalid of [c.ethers.ZeroAddress, c.other.address]) {
      await expect(c.factory.connect(c.admin).setTokenAllowed(invalid, true)).to.be.revertedWithCustomError(c.factory, "InvalidInput");
    }
    await expect(c.factory.connect(c.admin).setTokenAllowed(nextAddress, true)).to.emit(c.factory, "TokenListingChanged").withArgs(nextAddress, true, 6);
    expect(await c.factory.getAllowedTokens()).to.have.members([c.tokenAddress, nextAddress]);
    await expect(c.factory.connect(c.admin).setTokenAllowed(nextAddress, true)).to.be.revertedWithCustomError(c.factory, "InvalidInput");
    await expect(c.factory.connect(c.admin).setTokenAllowed(nextAddress, false)).to.emit(c.factory, "TokenListingChanged").withArgs(nextAddress, false, 6);
    expect(await c.factory.getAllowedTokens()).to.deep.equal([c.tokenAddress]);
    await expect(c.factory.connect(c.admin).setTokenAllowed(nextAddress, false)).to.be.revertedWithCustomError(c.factory, "InvalidInput");
    await expect(c.factory.connect(c.admin).setTokenAllowed(c.ethers.ZeroAddress, false)).to.be.revertedWithCustomError(c.factory, "InvalidInput");
    await c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, false);
    expect(await c.factory.getAllowedTokens()).to.deep.equal([]);
  });

  it("delisting blocks new escrows and top-ups; relisting restores funding without losing history", async function () {
    const c = await fixture();
    await c.escrow.connect(c.alice).deposit(50n);
    await c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, false);
    await expect(c.escrow.connect(c.alice).deposit(50n)).to.be.revertedWithCustomError(c.escrow, "TokenNotListed");
    await expect(createProposal(c, "next"))
      .to.be.revertedWithCustomError(c.factory, "UnsupportedToken");
    expect(await c.escrow.contributions(c.alice.address)).to.equal(50n);
    expect(await c.escrow.depositCounts(c.alice.address)).to.equal(1n);
    await c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, true);
    await c.escrow.connect(c.alice).deposit(50n);
    expect(await c.escrow.contributions(c.alice.address)).to.equal(100n);
    expect(await c.escrow.depositCounts(c.alice.address)).to.equal(2n);
  });

  for (const outcome of ["release", "refund"]) {
    it(`delisting never prevents ${outcome} of existing custody`, async function () {
      const c = await fixture({ feeBps: 10 });
      if (outcome === "release") await approve(c); else await fund(c);
      await c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, false);
      if (outcome === "release") {
        await c.escrow.release(c.selectionId);
        expect(await c.token.balanceOf(c.solution.address)).to.equal(999n);
        expect(await c.token.balanceOf(c.admin.address)).to.equal(1n);
      } else {
        await at(c, c.expiresAt); await c.escrow.connect(c.alice).claimRefund();
        expect(await c.escrow.refundedAmounts(c.alice.address)).to.equal(c.target);
      }
      await assertAccounting(c);
    });
  }
});
