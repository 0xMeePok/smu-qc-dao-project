import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeMemberCall, memberCall, memberCallFromReceipt, userOperationSucceeded } from "../memberCall.js";
import { accountCallData, sponsoredTransaction } from "./sponsoredTx.mjs";

const member = `0x${"a1".repeat(20)}`, other = `0x${"c3".repeat(20)}`, registry = `0x${"e5".repeat(20)}`;
const hash = `0x${"1".repeat(64)}`, input = "0x12345678abcd";

describe("QCDAO-144 member calls through Privy gas sponsorship", () => {
  it("passes an ordinary transaction through unchanged", () => {
    const transaction = { hash, from: member, to: registry, input, value: 0n, chainId: 421614 };
    assert.deepEqual(memberCall(transaction, { transactionHash: hash, logs: [] }),
      { from: member, to: registry, input, value: 0n, chainId: 421614, sponsored: false });
  });

  for (const erc7579 of [false, true]) it(`unwraps a sponsored ${erc7579 ? "ERC-7579" : "execute(target, value, data)"} call to the member's own call`, () => {
    const { transaction, receipt } = sponsoredTransaction({ hash, calls: [{ sender: member, to: registry, input, erc7579 }] });
    const call = memberCall(transaction, receipt, { sender: member });
    assert.equal(call.from.toLowerCase(), member);
    assert.equal(call.to.toLowerCase(), registry);
    assert.equal(call.input, input);
    assert.equal(call.sponsored, true);
    assert.equal(userOperationSucceeded(receipt, member), true);
  });

  it("picks the member's operation from a bundle and refuses another wallet's", () => {
    const { transaction, receipt } = sponsoredTransaction({ hash, calls: [
      { sender: other, to: registry, input: "0xdeadbeef" }, { sender: member, to: registry, input }] });
    assert.equal(memberCall(transaction, receipt, { sender: member }).input, input);
    assert.equal(memberCall(transaction, receipt, { sender: `0x${"f".repeat(40)}` }), null);
    // Without a sender a bundle is ambiguous, so it is refused rather than guessed.
    assert.equal(decodeMemberCall(transaction), null);
  });

  it("refuses an operation that failed inside a mined transaction", () => {
    const { transaction, receipt } = sponsoredTransaction({ hash, calls: [{ sender: member, to: registry, input, success: false }] });
    assert.equal(receipt.status, "success");
    assert.equal(userOperationSucceeded(receipt, member), false);
    assert.equal(memberCall(transaction, receipt, { sender: member }), null);
    // Identifying the deployment does not need the outcome.
    assert.equal(decodeMemberCall(transaction, { sender: member }).to.toLowerCase(), registry);
  });

  it("refuses a missing or mismatched receipt, try-mode and batch executions and unknown accounts", () => {
    const sponsored = (call) => sponsoredTransaction({ hash, calls: [{ sender: member, to: registry, input, ...call }] });
    const { transaction, receipt } = sponsored({});
    assert.equal(memberCall(transaction, null, { sender: member }), null);
    assert.equal(memberCall(transaction, { ...receipt, transactionHash: `0x${"9".repeat(64)}` }, { sender: member }), null);
    assert.equal(memberCall(transaction, { ...receipt, logs: [] }, { sender: member }), null);
    for (const mode of ["0x0001", "0x0100"]) {
      const tried = sponsored({ erc7579: true, mode });
      assert.equal(memberCall(tried.transaction, tried.receipt, { sender: member }), null, mode);
    }
    const unknown = sponsored({ callData: "0xa9059cbb" + "0".repeat(128) });
    assert.equal(memberCall(unknown.transaction, unknown.receipt, { sender: member }), null);
    assert.ok(accountCallData({ to: registry, input }).startsWith("0xb61d27f6"));
  });

  it("reads the transaction only when a receipt shows a sponsored EntryPoint call", async () => {
    let reads = 0;
    const direct = await memberCallFromReceipt({ getTransaction: async () => { reads++; } }, { from: member, to: registry, transactionHash: hash });
    assert.deepEqual([direct.from, direct.to, reads], [member, registry, 0]);
    const { transaction, receipt } = sponsoredTransaction({ hash, calls: [{ sender: member, to: registry, input }] });
    const client = { getTransaction: async ({ hash: requested }) => { reads++; assert.equal(requested, hash); return transaction; } };
    assert.equal((await memberCallFromReceipt(client, receipt, { sender: member })).to.toLowerCase(), registry);
    assert.equal(reads, 1);
    assert.equal(await memberCallFromReceipt(client, receipt, { sender: other }), null);
  });
});
