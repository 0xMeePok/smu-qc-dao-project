import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpsError } from "firebase-functions/v2/https";
import { handleDueSandbox, sandboxDevCommandsAllowed } from "../dueSandboxFunctions.js";
import { memoryDb } from "./memoryDb.mjs";

const uid = `0x${"ab".repeat(20)}`;
const apiKey = "sandbox-key-123";

function database() {
  return memoryDb({
    [`users/${uid}`]: { email: "member@example.com", fullName: "Ada Member", role: 0 },
  });
}

function harness() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || "GET" });
    if (path === "/v1/accounts") return json({ id: "acct_1" });
    if (path === "/v1/wallets") return json({ id: "wlt_1" });
    if (path.endsWith("/approve")) return json({ status: "approved" });
    if (path === "/v1/channels") return json({ channels: [
      { rail: "ach", currencyCode: "USD", type: "deposit" },
      { rail: "arbitrum-sepolia", currencyCode: "USDC", type: "withdrawal" },
    ] });
    if (path === "/v1/transfers/quote") return json({
      token: "quote-token-1234567890",
      source: { rail: "ach", currency: "USD", amount: "100.00", fee: "0.50" },
      destination: { rail: "arbitrum-sepolia", currency: "USDC", amount: "99.50", fee: "0" },
      fxRate: "1.00",
      expiresAt: "2026-11-03T00:02:00.000Z",
    });
    if (path === "/v1/transfers/tf_1") return json({
      id: "tf_1", status: "awaiting_funds",
      source: { rail: "ach", currency: "USD", amount: "100.00" },
      transferInstructions: { memo: "SIM-tf_1" },
    });
    if (path === "/dev/payin") return json({ ok: true });
    return json({});
  };
  return { calls, fetchImpl };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function request(data) {
  return { auth: { uid, token: { auth_time: 100 } }, data };
}

describe("Due sandbox dev commands", () => {
  it("treats only the functions emulator as allowed to run them", () => {
    assert.equal(sandboxDevCommandsAllowed({ FUNCTIONS_EMULATOR: "true", DUE_SANDBOX_DEV_COMMANDS: "true" }), true);
    assert.equal(sandboxDevCommandsAllowed({}), false);
    assert.equal(sandboxDevCommandsAllowed({ DUE_SANDBOX_DEV_COMMANDS: "true" }), false);
  });

  it("does not approve KYC or simulate a pay-in when deployed", async () => {
    const { calls, fetchImpl } = harness();
    const db = database();
    const quoted = await handleDueSandbox(request({ action: "quote", direction: "onramp", currency: "USD", amount: "100" }), {
      db, apiKey, fetchImpl, allowDevCommands: false,
    });
    assert.equal(quoted.quote.destination.amount, "99.50");
    assert.equal(calls.some((call) => call.path.includes("/approve")), false);
    await assert.rejects(
      () => handleDueSandbox(request({ action: "payin", transferId: "tf_1" }), { db, apiKey, fetchImpl, allowDevCommands: false }),
      (error) => error instanceof HttpsError && error.code === "permission-denied" && /local emulator/.test(error.message),
    );
    assert.equal(calls.some((call) => call.path === "/dev/payin"), false);
  });

  it("approves sandbox KYC and accepts a pay-in simulation in the emulator", async () => {
    const { calls, fetchImpl } = harness();
    const db = database();
    await handleDueSandbox(request({ action: "quote", direction: "onramp", currency: "USD", amount: "100" }), {
      db, apiKey, fetchImpl, allowDevCommands: true,
    });
    assert.equal(calls.some((call) => call.method === "POST" && call.path === "/dev/sumsub/applicants/acct_1/approve"), true);
    const paid = await handleDueSandbox(request({ action: "payin", transferId: "tf_1" }), {
      db, apiKey, fetchImpl, allowDevCommands: true,
    });
    assert.equal(calls.some((call) => call.method === "POST" && call.path === "/dev/payin"), true);
    assert.equal(paid.transfer.id, "tf_1");
  });
});
