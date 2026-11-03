import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleDueSandbox } from "../dueSandboxFunctions.js";
import { memoryDb } from "./memoryDb.mjs";

const uid = `0x${"ab".repeat(20)}`;

function request(data) {
  return { auth: { uid, token: { auth_time: 100 } }, data };
}

describe("mocked Due ramp", () => {
  it("creates a mock account and completes a buy without calling Due", async () => {
    const db = memoryDb({ [`users/${uid}`]: { email: "member@example.com", fullName: "Ada Member", role: 0 } });
    const calls = [];
    const quoted = await handleDueSandbox(request({ action: "quote", direction: "onramp", currency: "USD", amount: "100" }), {
      db, fetchImpl: async () => { calls.push(true); },
    });
    assert.equal(quoted.accountId, "acct_mock_abababab");
    assert.equal(quoted.quote.destination.amount, "99.50");
    const created = await handleDueSandbox(request({
      action: "create", direction: "onramp", currency: "USD", quoteToken: quoted.quote.token,
    }), { db });
    assert.equal(created.transfer.details.accountNumber, "0000000000");
    const paid = await handleDueSandbox(request({ action: "payin", transferId: created.transfer.id }), { db });
    assert.equal(paid.transfer.status, "payment_processed");
    assert.equal(calls.length, 0);
  });
});
