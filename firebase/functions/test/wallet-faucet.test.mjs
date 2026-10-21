import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { HttpsError } from "firebase-functions/v2/https";
import { privateKeyToAccount } from "viem/accounts";
import { claimWalletTokens, registerWalletFaucetFunctions } from "../walletFaucetFunctions.js";
import { memoryDb } from "./memoryDb.mjs";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const otherAccount = privateKeyToAccount(`0x${"22".repeat(32)}`);
const uid = account.address.toLowerCase();
const NOW = 1_800_000_000_000;
const issuedAt = NOW / 1000;
const txHash = `0x${"ab".repeat(32)}`;
const endpoint = "https://smu-qc-dao-project.vercel.app/api/faucet";
const hasCode = code => error => error instanceof HttpsError && error.code === code;

function message(token = "USDC", recipient = account.address, timestamp = issuedAt) {
  return ["TAP Faucet Mint", `Token: ${token}`, `Recipient: ${recipient}`,
    "Chain ID: 421614", `Issued At: ${timestamp}`].join("\n");
}

async function request(token = "USDC", timestamp = issuedAt, signer = account) {
  return { auth: { uid, token: { auth_time: 100 } },
    data: { token, issuedAt: timestamp, signature: await signer.signMessage({ message: message(token, account.address, timestamp) }) } };
}

function confirmation(overrides = {}) {
  return { token: "USDC", recipient: account.address, amount: "10000", decimals: 6, txHash, ...overrides };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fixture({ profile = { role: 0 }, records = {}, fetchImpl = async () => json(confirmation()), now = () => NOW } = {}) {
  const db = memoryDb({ ...(profile === null ? {} : { [`users/${uid}`]: profile }), ...records });
  const calls = [];
  return { db, calls, deps: { db, now, fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); } } };
}

describe("authenticated wallet test-token faucet relay", () => {
  it("posts only the signed TAP payload to the fixed endpoint and returns a validated confirmation", async () => {
    const state = fixture();
    const signed = await request();
    assert.deepEqual(await claimWalletTokens(signed, state.deps), confirmation());
    assert.equal(state.calls.length, 1);
    const [url, options] = state.calls[0];
    assert.equal(url, endpoint);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { "content-type": "application/json", accept: "application/json" });
    assert.deepEqual(JSON.parse(options.body), { ...signed.data, recipient: account.address });
    assert.ok(!("authorization" in options.headers));
  });

  it("accepts each configured test token independently", async () => {
    for (const token of ["XSGD", "USDT", "USDC"]) {
      const state = fixture({ fetchImpl: async () => json(confirmation({ token })) });
      assert.equal((await claimWalletTokens(await request(token), state.deps)).token, token);
    }
  });

  it("refuses signed-out, malformed, suspended, incomplete and revoked accounts before relay", async () => {
    const signed = await request();
    for (const auth of [undefined, { uid: "not-a-wallet" }, { uid: otherAccount.address }]) {
      const state = fixture();
      await assert.rejects(claimWalletTokens({ ...signed, auth }, state.deps), hasCode("unauthenticated"));
      assert.equal(state.calls.length, 0);
    }
    for (const profile of [null, { suspended: true }]) {
      const state = fixture({ profile });
      await assert.rejects(claimWalletTokens(signed, state.deps), hasCode("permission-denied"));
      assert.equal(state.calls.length, 0);
    }
    for (const options of [
      { profile: { role: 0, sessionsValidAfterEpoch: 100 } },
      { records: { [`sessionRevocations/${uid}`]: { sessionsValidAfterEpoch: 100 } } },
    ]) {
      const state = fixture(options);
      await assert.rejects(claimWalletTokens(signed, state.deps), hasCode("unauthenticated"));
      assert.equal(state.calls.length, 0);
    }
  });

  it("never accepts a browser-selected recipient, URL or unrelated request fields", async () => {
    const signed = await request();
    for (const extra of [{ recipient: otherAccount.address }, { recipient: account.address },
      { url: "https://attacker.example/faucet" }, { endpoint }, { amount: "1000000" }]) {
      const state = fixture();
      await assert.rejects(claimWalletTokens({ ...signed, data: { ...signed.data, ...extra } }, state.deps), hasCode("invalid-argument"));
      assert.equal(state.calls.length, 0);
    }
  });

  it("rejects unsupported tokens, malformed signatures and expired or future requests", async () => {
    const signed = await request();
    for (const data of [undefined, [], { ...signed.data, token: "ETH" }, { ...signed.data, token: "__proto__" },
      { ...signed.data, signature: "0x12" }, { ...signed.data, signature: `0x${"g".repeat(130)}` },
      { ...signed.data, issuedAt: "1800000000" }, { ...signed.data, issuedAt: issuedAt - 301 },
      { ...signed.data, issuedAt: issuedAt + 61 }]) {
      const state = fixture();
      await assert.rejects(claimWalletTokens({ ...signed, data }, state.deps), hasCode("invalid-argument"));
      assert.equal(state.calls.length, 0);
    }
  });

  it("verifies the exact checksummed recipient, token and timestamp against the authenticated signing key", async () => {
    const signed = await request();
    const lowercasedSignature = await account.signMessage({ message: message("USDC", uid) });
    for (const candidate of [await request("USDC", issuedAt, otherAccount),
      { ...signed, data: { ...signed.data, token: "XSGD" } },
      { ...signed, data: { ...signed.data, issuedAt: issuedAt - 1 } },
      { ...signed, data: { ...signed.data, signature: lowercasedSignature } }]) {
      const state = fixture();
      await assert.rejects(claimWalletTokens(candidate, state.deps), hasCode("permission-denied"));
      assert.equal(state.calls.length, 0);
    }
  });

  it("preserves an upstream cooldown message as resource-exhausted", async () => {
    const cooldown = "This wallet can claim USDC again at 2027-01-15T09:00:00.000Z.";
    const state = fixture({ fetchImpl: async () => json({ error: cooldown }, 429) });
    await assert.rejects(claimWalletTokens(await request(), state.deps), error => {
      assert.ok(hasCode("resource-exhausted")(error));
      assert.equal(error.message, cooldown);
      return true;
    });
  });

  it("rejects mismatched or malformed mint confirmations without exposing upstream contents", async () => {
    for (const overrides of [{ token: "XSGD" }, { amount: "10001" }, { amount: 10000 }, { decimals: 18 },
      { recipient: otherAccount.address }, { recipient: "private-sentinel" }, { txHash: "0x12" }]) {
      const state = fixture({ fetchImpl: async () => json(confirmation(overrides)) });
      await assert.rejects(claimWalletTokens(await request(), state.deps), hasCode("unavailable"));
    }
  });

  it("bounds declared and streamed response bytes and rejects invalid response types/JSON", async () => {
    let cancelled = false;
    const factories = [
      () => json(confirmation(), 200, { "content-length": "1000000" }),
      () => new Response("<html>private-sentinel</html>", { status: 502, headers: { "content-type": "text/html" } }),
      () => new Response("not-json-private-sentinel", { headers: { "content-type": "application/json" } }),
      () => json([confirmation()]),
      () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(5000)); controller.enqueue(new Uint8Array(5000)); },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "application/json" } }),
    ];
    for (const response of factories) {
      const state = fixture({ fetchImpl: async () => response() });
      await assert.rejects(claimWalletTokens(await request(), state.deps), error => {
        assert.ok(hasCode("unavailable")(error));
        assert.equal(error.message.includes("private-sentinel"), false);
        return true;
      });
    }
    assert.equal(cancelled, true);
  });

  it("returns a clear uncertain-confirmation timeout and performs no automatic retry", async () => {
    const state = fixture({ fetchImpl: async (_url, { signal }) => {
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.equal(signal.aborted, true);
      throw new Error("aborted private-sentinel");
    } });
    await assert.rejects(claimWalletTokens(await request(), { ...state.deps, timeoutMs: 1 }), error => {
      assert.ok(hasCode("deadline-exceeded")(error));
      assert.match(error.message, /Check your wallet balance before retrying/);
      return true;
    });
    assert.equal(state.calls.length, 1);
  });

  it("limits authenticated signed attempts and reopens the window after one minute", async () => {
    let clock = NOW;
    const state = fixture({ now: () => clock, fetchImpl: async () => json({ error: "Try later" }, 503) });
    const signed = await request();
    for (let i = 0; i < 10; i++) await assert.rejects(claimWalletTokens(signed, state.deps), hasCode("unavailable"));
    await assert.rejects(claimWalletTokens(signed, state.deps), hasCode("resource-exhausted"));
    assert.equal(state.calls.length, 10);
    clock += 60_000;
    await assert.rejects(claimWalletTokens(signed, state.deps), hasCode("unavailable"));
    assert.equal(state.calls.length, 11);
    assert.equal(state.db.records.get(`walletFaucetAttempts/${uid}`).count, 1);
  });

  it("invalid signatures never consume an authenticated member's relay budget", async () => {
    const state = fixture();
    await assert.rejects(claimWalletTokens(await request("USDC", issuedAt, otherAccount), state.deps), hasCode("permission-denied"));
    assert.equal(state.db.records.has(`walletFaucetAttempts/${uid}`), false);
  });

  it("the real callable wrapper requires App Check outside emulators", async () => {
    const previous = process.env.FUNCTIONS_EMULATOR;
    try {
      for (const emulator of ["false", "true"]) {
        process.env.FUNCTIONS_EMULATOR = emulator;
        const callable = registerWalletFaucetFunctions({ db: memoryDb(), region: "asia-southeast1" }).claimWalletTokens;
        assert.deepEqual(callable.__endpoint.region, ["asia-southeast1"]);
        const headers = new Map();
        const response = Object.assign(new EventEmitter(), {
          setHeader: (name, value) => headers.set(name, value),
          getHeader: name => headers.get(name),
          status(code) { this.statusCode = code; return this; },
          send(body) { this.body = body; this.emit("finish"); return this; },
        });
        await callable({ method: "POST", headers: {}, body: { data: {} },
          header: name => name.toLowerCase() === "content-type" ? "application/json" : undefined }, response);
        assert.equal(response.statusCode, 401);
        // With enforcement on, the SDK refuses missing App Check before our
        // handler. The emulator reaches the handler's separate sign-in guard.
        assert.equal(response.body.error.message, emulator === "false" ? "Unauthenticated"
          : "Sign in with your email to get test tokens.");
      }
    } finally {
      if (previous === undefined) delete process.env.FUNCTIONS_EMULATOR;
      else process.env.FUNCTIONS_EMULATOR = previous;
    }
  });
});
