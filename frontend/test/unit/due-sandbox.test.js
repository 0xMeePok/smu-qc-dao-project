import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DUE_RAMP_SWAP_POINT,
  LOCAL_DUE_SANDBOX_KEY,
  createDueSandboxTransfer,
  quoteDueSandbox,
  simulateDueSandboxFunding,
  startDueSandbox,
} from "../../src/lib/dueSandbox.js";

const address = `0x${"ab".repeat(20)}`;
const now = Date.parse("2026-11-03T00:00:00.000Z");
const start = (apiKey = LOCAL_DUE_SANDBOX_KEY) => startDueSandbox({ address, email: "funder@example.com", apiKey, now });

test("the local credential is not a Due host, and a different key is refused", () => {
  const session = start();
  assert.equal(session.apiBase, "local://due-sandbox");
  assert.equal(session.kyc.status, "approved");
  assert.equal(session.chainId, 421614);
  assert.equal(DUE_RAMP_SWAP_POINT.component, "frontend/src/components/DueOnOffRamp.jsx");
  assert.throws(() => start("due_live_key"), /rejected this credential/);
  assert.throws(() => startDueSandbox({ address: "0x123", email: "", apiKey: LOCAL_DUE_SANDBOX_KEY }), /embedded wallet/);
});

test("quotes use integer fees and never call the network", () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(args); throw new Error("fetch"); };
  try {
    const onramp = quoteDueSandbox({ session: start(), direction: "onramp", methodId: "ach", amount: "100.00", now });
    assert.equal(onramp.quote.source.fee, "0.50");
    assert.equal(onramp.quote.destination.amount, "99.500000");
    assert.equal(onramp.quote.destination.rail, "arbitrum-sepolia");
    assert.equal(onramp.quote.token.startsWith("local."), true);
    const euro = quoteDueSandbox({ session: start(), direction: "onramp", methodId: "sepa", amount: "10.00", now });
    assert.equal(euro.quote.destination.amount, "10.326086");
    const offramp = quoteDueSandbox({ session: start(), direction: "offramp", methodId: "fast", amount: "100.00", now });
    assert.equal(offramp.quote.source.fee, "0.500000");
    assert.equal(offramp.quote.destination.amount, "134.32");
    assert.equal(offramp.quote.destination.currency, "SGD");
    assert.equal(calls.length, 0);
    assert.equal(JSON.stringify(offramp).includes("due.network"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("rejects amounts and assets before a transfer exists", () => {
  const session = start();
  assert.throws(() => quoteDueSandbox({ session, direction: "onramp", methodId: "ach", amount: "0", now }), /0\.01 to 100000/);
  assert.throws(() => quoteDueSandbox({ session, direction: "onramp", methodId: "ach", amount: "0.50", now }), /larger amount/);
  assert.throws(() => quoteDueSandbox({ session, direction: "offramp", methodId: "ach", amount: "0.50", now }), /larger amount/);
  assert.throws(() => quoteDueSandbox({ session, direction: "onramp", asset: "USDT", methodId: "ach", amount: "10", now }), /only uses USDC/);
});

test("an off-ramp funding reference is not an address, and a late deposit expires", () => {
  const quoted = quoteDueSandbox({ session: start(), direction: "offramp", methodId: "ach", amount: "25.00", now });
  const created = createDueSandboxTransfer({ session: quoted.session, quoteId: quoted.quote.id, now });
  const reference = created.transfer.transferInstructions.details.reference;
  assert.equal(reference, "sandbox-funding:tf_1");
  assert.equal(/^0x[\da-f]{40}$/i.test(reference), false);
  assert.equal(JSON.stringify(created.transfer.transferInstructions).includes("0x"), false);
  assert.throws(() => createDueSandboxTransfer({ session: created.session, quoteId: quoted.quote.id, now }), /already used/);
  const expired = simulateDueSandboxFunding({ session: created.session, transferId: created.transfer.id, now: now + 120_000 });
  assert.equal(expired.transfer.status, "expired");
  const fresh = createDueSandboxTransfer({
    session: quoteDueSandbox({ session: start(), direction: "onramp", methodId: "ach", amount: "20", now }).session,
    quoteId: "quo_1",
    now,
  });
  const done = simulateDueSandboxFunding({ session: fresh.session, transferId: fresh.transfer.id, now });
  assert.deepEqual(done.transfer.statusLog, ["awaiting_funds", "approved", "payment_submitted", "payment_processed"]);
  const again = simulateDueSandboxFunding({ session: done.session, transferId: done.transfer.id, now });
  assert.equal(again.transfer, done.transfer);
});

test("an expired quote cannot create a transfer", () => {
  const quoted = quoteDueSandbox({ session: start(), direction: "onramp", methodId: "ach", amount: "20", now });
  assert.throws(() => createDueSandboxTransfer({ session: quoted.session, quoteId: "quo_1", now: now + 120_000 }), /expired/);
});
