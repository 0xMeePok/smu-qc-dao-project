import assert from "node:assert/strict";
import { it } from "node:test";
import { submitFundingApproachAnchor, submitFundingApproachDecisions } from "../../src/lib/fundingApproach.js";

const account = `0x${"a".repeat(40)}`, hash = `0x${"1".repeat(64)}`, id = `0x${"2".repeat(64)}`;
const calls = [
  ["approach", submitFundingApproachAnchor, { approachAnchorId: id, recordHash: hash }],
  ["decision", submitFundingApproachDecisions, [{ decisionAnchorId: id, recordHash: hash }]],
];

for (const [label, submit, record] of calls) {
  for (const walletOutcome of ["pending", "reverted"]) it(`preserves a nested sponsored ${label} anchor ${walletOutcome}`, async () => {
    const pendingSponsoredTransaction = { id: "anchor-operation", transactionHash: hash, phase: "unresolved" };
    const provider = Object.assign(new Error(`Sponsored anchor ${walletOutcome}`), {
      walletOutcome, transactionHash: hash, pendingSponsoredTransaction,
    });
    let sends = 0, waits = 0;
    await assert.rejects(submit(record, { account, adapters: {
      writeContract: async () => { sends++; throw new Error("viem wrapped", { cause: new Error("provider wrapped", { cause: provider }) }); },
      waitForTransactionReceipt: async () => { waits++; throw new Error("Unexpected receipt poll"); },
    } }), error => {
      assert.equal(error.walletOutcome, walletOutcome);
      assert.equal(error.transactionHash, hash);
      assert.equal(error.pendingSponsoredTransaction, pendingSponsoredTransaction);
      assert.equal(error.transactionSettled, walletOutcome === "reverted" ? true : undefined);
      assert.equal(error.terminal, walletOutcome === "reverted" ? true : undefined);
      return true;
    });
    assert.equal(sends, 1);
    assert.equal(waits, 0);
  });
}
