import assert from "node:assert/strict";
import { it } from "node:test";
import { encodeFunctionData, parseAbi } from "viem";
import { openFundingSupported, writeOpenFundingAction } from "../../src/lib/openFunding.js";
import { escrowConfig } from "../../../firebase/functions/test/fixtures/escrowConfigFixture.js";

const pool = `0x${"7".repeat(40)}`, account = `0x${"8".repeat(40)}`, hash = `0x${"9".repeat(64)}`;
const config = { ...escrowConfig, escrow: { ...escrowConfig.escrow,
  factoryAbi: parseAbi(["function createOpenFundingPool(bytes32 postingId, address token) returns (address)"]),
  openFundingPoolAbi: parseAbi(["function deposit(uint256 amount)", "function selectProposal(bytes32 proposalId)",
    "function acceptProposal(bytes32 proposalId)", "function expireProposal(bytes32 proposalId)", "function withdrawAvailable(uint256 amount)"]),
} };
function fixture(overrides = {}) {
  const writes = [], progress = [], waits = [];
  const prepared = { poolAddress: pool, chainId: config.chainId, tokenAddress: config.escrow.tokens[0].address,
    tokenSymbol: config.escrow.tokens[0].symbol, tokenDecimals: 6,
    request: { address: pool, functionName: "deposit", args: ["1250000"] }, ...overrides.prepared };
  const adapters = {
    readContract: async ({ functionName }) => functionName === "balanceOf" ? overrides.balance ?? 10_000_000n : overrides.allowance ?? 0n,
    writeContract: async request => { encodeFunctionData(request); writes.push(request); return hash; },
    waitForTransactionReceipt: async request => { waits.push(request); if (overrides.failure) throw overrides.failure; return { transactionHash: hash, status: "success" }; },
  };
  const options = { problemId: "grant", account, action: "deposit", amount: "1.25", decimals: 6,
    config, adapters, prepare: async () => prepared, onProgress: value => progress.push(value) };
  return { writes, progress, waits, options };
}

it("keeps grant actions disabled for the existing deployment without pool capability", async () => {
  assert.equal(openFundingSupported(escrowConfig), false);
  const { options, writes } = fixture();
  await assert.rejects(writeOpenFundingAction({ ...options, config: escrowConfig }), /deployment/);
  assert.equal(writes.length, 0);
});
it("approves exactly the entered amount before depositing, with every call bound to the user's wallet", async () => {
  const { options, writes, waits } = fixture();
  await writeOpenFundingAction(options);
  assert.deepEqual(writes.map(row => [row.functionName, row.args]), [["approve", [pool, 1_250_000n]], ["deposit", [1_250_000n]]]);
  assert.ok(writes.every(row => row.account === account && row.chainId === config.chainId));
  assert.ok(waits.every(row => row.confirmations === 2));
});
it("keeps a mined grant transaction pending until its successor block confirms", async () => {
  const { options, writes, progress, waits } = fixture({ allowance: 2_000_000n });
  let confirmSuccessor;
  options.adapters.waitForTransactionReceipt = async request => {
    waits.push(request);
    return new Promise(resolve => { confirmSuccessor = () => resolve({ transactionHash: hash, status: "success" }); });
  };
  const pending = writeOpenFundingAction(options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1); assert.equal(waits[0].confirmations, 2);
  assert.equal(progress.some(row => row.status === "confirmed"), false);
  confirmSuccessor(); await pending;
  assert.equal(progress.at(-1).status, "confirmed"); assert.equal(writes.length, 1);
});
it("resets partial allowance first and skips approval if sufficient", async () => {
  const partial = fixture({ allowance: 1n }); await writeOpenFundingAction(partial.options);
  assert.deepEqual(partial.writes.map(row => row.functionName), ["approve", "approve", "deposit"]);
  assert.equal(partial.writes[0].args[1], 0n);
  const enough = fixture({ allowance: 2_000_000n }); await writeOpenFundingAction(enough.options);
  assert.deepEqual(enough.writes.map(row => row.functionName), ["deposit"]);
});
it("does not sign a changed contract, amount, method, decimals or chain", async () => {
  for (const prepared of [{ chainId: 1 }, { tokenDecimals: 18 },
    { request: { address: account, functionName: "deposit", args: ["1250000"] } },
    { request: { address: pool, functionName: "acceptProposal", args: [hash] } },
    { request: { address: pool, functionName: "deposit", args: ["2500000"] } }]) {
    const { options, writes } = fixture({ prepared });
    await assert.rejects(writeOpenFundingAction(options), /changed|match/);
    assert.equal(writes.length, 0);
  }
});
it("does not request approval when the token balance is insufficient", async () => {
  const { options, writes } = fixture({ balance: 0n });
  await assert.rejects(writeOpenFundingAction(options), /balance/); assert.equal(writes.length, 0);
});
it("retains a submitted hash if confirmation is unavailable and never retries a wallet write", async () => {
  const { options, writes } = fixture({ allowance: 2_000_000n, failure: new Error("RPC offline") });
  await assert.rejects(writeOpenFundingAction(options), err => err.transactionHash === hash);
  assert.equal(writes.length, 1);
});
it("accepts a prepared researcher offer using its canonical proposal reference", async () => {
  const { options, writes } = fixture({ prepared: { request: { address: pool, functionName: "acceptProposal", args: [hash] } } });
  await writeOpenFundingAction({ ...options, action: "accept", proposalId: "proposal" });
  assert.deepEqual(writes.map(row => row.functionName), ["acceptProposal"]);
  assert.equal(writes[0].args[0], hash);
});
it("withdraws exact token base units from the canonical pool without a token approval", async () => {
  const { options, writes, waits } = fixture({ prepared: { request: { address: pool, functionName: "withdrawAvailable", args: ["1250000"] } } });
  let requested;
  const prepare = options.prepare;
  await writeOpenFundingAction({ ...options, action: "withdraw", prepare: async request => { requested = request; return prepare(request); } });
  assert.equal(requested.amountBaseUnits, "1250000");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].address, pool);
  assert.deepEqual(writes[0].args, [1_250_000n]);
  assert.equal(encodeFunctionData(writes[0]), encodeFunctionData({ abi: config.escrow.openFundingPoolAbi,
    functionName: "withdrawAvailable", args: [1_250_000n] }));
  assert.ok(waits.every(row => row.confirmations === 2));
});
it("rejects nonpositive and imprecise withdrawals before requesting a wallet signature", async () => {
  for (const amount of ["0", "-1", "1.0000001"]) {
    const { options, writes } = fixture({ prepared: { request: { address: pool, functionName: "withdrawAvailable", args: ["1250000"] } } });
    await assert.rejects(writeOpenFundingAction({ ...options, action: "withdraw", amount }), /positive|decimal/);
    assert.equal(writes.length, 0);
  }
});
