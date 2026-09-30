import { expect } from "chai";
import { fixture, at, assertAccounting, State } from "./helpers.js";

// Reproducible model-based sequences, not nondeterministic Math.random tests.
function generator(seed) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value; };
}

describe("FundingEscrow: model-based accounting", function () {
  for (const seed of [1, 37, 109, 110, 113, 65537]) {
    for (const outcome of ["release", "refund"]) {
      it(`preserves cumulative deposits and conservation through ${outcome}, seed ${seed}`, async function () {
        const c = await fixture({ target: 100000n, feeBps: seed % 10001 });
        const random = generator(seed);
        const actors = [c.alice, c.bob, c.other];
        const balances = [0n, 0n, 0n];
        const counts = [0n, 0n, 0n];
        let deposited = 0n;
        for (let step = 0; step < 30; step++) {
          const index = random() % actors.length;
          const amount = BigInt(random() % 2000 + 1);
          await c.escrow.connect(actors[index]).deposit(amount);
          balances[index] += amount; counts[index]++; deposited += amount;
          expect(await c.escrow.totalDeposited()).to.equal(deposited);
          expect(await c.escrow.contributions(actors[index].address)).to.equal(balances[index]);
          expect(await c.escrow.depositCounts(actors[index].address)).to.equal(counts[index]);
          await assertAccounting(c);
        }
        if (outcome === "release") {
          const remainder = c.target - deposited;
          await c.escrow.connect(c.alice).deposit(remainder);
          balances[0] += remainder; counts[0]++;
          await c.escrow.lockSelection(c.selectionId, c.solution.address);
          await c.escrow.connect(c.owner).approveSelection(c.selectionId);
          await c.escrow.connect(c.solution).approveSelection(c.selectionId);
          await c.escrow.release(c.selectionId);
          const fee = c.target * BigInt(seed % 10001) / 10000n;
          expect(await c.token.balanceOf(c.admin.address)).to.equal(fee);
          expect(await c.token.balanceOf(c.solution.address)).to.equal(c.target - fee);
          expect(await c.escrow.state()).to.equal(State.Released);
        } else {
          if (seed % 2) await c.escrow.cancel(c.reason);
          await at(c, c.expiresAt);
          // Deterministically vary claimant order; each must receive its full sum.
          const order = seed % 3 === 0 ? [2, 0, 1] : [1, 2, 0];
          for (const index of order) {
            const before = await c.token.balanceOf(actors[index].address);
            await c.escrow.connect(actors[index]).claimRefund();
            expect(await c.token.balanceOf(actors[index].address)).to.equal(before + balances[index]);
            expect(await c.escrow.refundedAmounts(actors[index].address)).to.equal(balances[index]);
            await assertAccounting(c);
          }
          expect(await c.escrow.state()).to.equal(State.Refunded);
        }
        for (let index = 0; index < actors.length; index++) {
          const summary = await c.escrow.depositorSummary(actors[index].address);
          expect(summary.deposited).to.equal(balances[index]);
          expect(summary.depositCount).to.equal(counts[index]);
          expect(summary.claimable).to.equal(0n);
        }
        expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
        expect(await c.escrow.outstandingBalance()).to.equal(0n);
        await assertAccounting(c);
      });
    }
  }
});
