import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PrivyClient } from "@privy-io/node";
import { exchangePrivySession, PrivySessionError } from "../privySession.js";
import { memoryDb } from "./memoryDb.mjs";

const ADDRESS = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const PRIVY_ID = "did:privy:upgraded-member";
const EMAIL = "member@example.com";
const ACCESS_TOKEN = "header.payload.signature";
const Timestamp = {
  now: () => Timestamp.fromMillis(Date.now()),
  fromMillis: (value) => ({ toMillis: () => value }),
};

function member() {
  return {
    id: PRIVY_ID,
    linked_accounts: [
      { type: "email", address: EMAIL },
      {
        type: "wallet", address: ADDRESS, chain_type: "ethereum",
        connector_type: "embedded", wallet_client_type: "privy-v2",
      },
    ],
  };
}

function productionExchange(t, { profile, verifyError, fetchUserError, claims = { user_id: PRIVY_ID } } = {}) {
  // Exercise the production SDK path even when the full suite is run inside
  // Firebase emulators. Restore every environment value for the next test.
  const environment = {
    FUNCTIONS_EMULATOR: "false", PRIVY_APP_ID: "test-app-id", PRIVY_SECRET: "test-app-secret",
    ADMIN_BOOTSTRAP_EMAILS: "",
  };
  for (const [name, value] of Object.entries(environment)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }

  const verifyToken = t.mock.fn(async () => {
    if (verifyError) throw verifyError;
    return claims;
  });
  const getUser = t.mock.fn(async () => {
    if (fetchUserError) throw fetchUserError;
    return member();
  });
  t.mock.method(PrivyClient.prototype, "utils", () => ({ auth: () => ({ verifyAccessToken: verifyToken }) }));
  t.mock.method(PrivyClient.prototype, "users", () => ({ _get: getUser }));
  const walletApi = t.mock.method(PrivyClient.prototype, "wallets", () => {
    throw new Error("Signing in must not request a wallet signature.");
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("The token exchange must not inspect wallet code or call ERC-1271.");
  });
  const createToken = t.mock.fn(async () => "firebase-custom-token");
  const db = memoryDb(profile ? { [`users/${ADDRESS}`]: profile } : {});
  const deps = { db, Timestamp, getAuth: () => ({ createCustomToken: createToken }) };
  const request = (data = {}) => ({
    data: { accessToken: ACCESS_TOKEN, ...data },
    rawRequest: { ip: "203.0.113.146", headers: {} },
  });
  return { db, deps, request, verifyToken, getUser, walletApi, fetch, createToken };
}

const hasCode = (code) => (error) => error instanceof PrivySessionError && error.code === code;

describe("Privy session exchange remains independent of embedded-wallet delegation", () => {
  it("keeps the server-bound address across returning sign-ins without a wallet signature or chain lookup", async (t) => {
    const state = productionExchange(t, {
      profile: { address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID, role: 0, fullName: "Returning member" },
    });

    // EIP-7702 changes the wallet's on-chain code, not its Privy identity or
    // address. The real upgrade/signature lifecycle is exercised by the local
    // EVM suite; this test guards the server's token-only boundary on both
    // exchanges, rather than pretending a metadata flag installs delegation.
    for (let exchange = 0; exchange < 2; exchange += 1) {
      assert.deepEqual(await exchangePrivySession(state.request(), state.deps), {
        token: "firebase-custom-token", address: ADDRESS,
      });
    }
    assert.deepEqual(state.verifyToken.mock.calls.map(({ arguments: args }) => args), [[ACCESS_TOKEN], [ACCESS_TOKEN]]);
    assert.deepEqual(state.getUser.mock.calls.map(({ arguments: args }) => args), [[PRIVY_ID], [PRIVY_ID]]);
    assert.deepEqual(state.createToken.mock.calls.map(({ arguments: args }) => args), [
      [ADDRESS, { wallet: ADDRESS, chainId: 421614 }],
      [ADDRESS, { wallet: ADDRESS, chainId: 421614 }],
    ]);
    assert.equal(state.db.records.get(`privyIdentities/${ADDRESS}`).privyUserId, PRIVY_ID);
    assert.equal(state.db.records.get(`users/${ADDRESS}`).fullName, "Returning member");
    assert.equal(state.walletApi.mock.callCount(), 0);
    assert.equal(state.fetch.mock.callCount(), 0);
  });

  it("rejects an invalid Privy token before fetching a user or minting a session", async (t) => {
    const state = productionExchange(t, { verifyError: new Error("Invalid access-token signature") });
    await assert.rejects(exchangePrivySession(state.request(), state.deps), hasCode("unauthenticated"));
    assert.equal(state.verifyToken.mock.callCount(), 1);
    assert.equal(state.getUser.mock.callCount(), 0);
    assert.equal(state.createToken.mock.callCount(), 0);
    assert.equal(state.db.records.has(`privyIdentities/${ADDRESS}`), false);
  });

  it("does not accept an emulator user header in the production token path", async (t) => {
    const state = productionExchange(t, { verifyError: new Error("Invalid token") });
    const request = state.request();
    request.rawRequest.headers["x-emulator-privy-user"] = JSON.stringify(member());
    await assert.rejects(exchangePrivySession(request, state.deps), hasCode("unauthenticated"));
    assert.equal(state.verifyToken.mock.callCount(), 1);
    assert.equal(state.createToken.mock.callCount(), 0);
  });

  it("rejects a substituted browser address despite a valid token", async (t) => {
    const state = productionExchange(t);
    await assert.rejects(exchangePrivySession(state.request({ address: OTHER }), state.deps), hasCode("permission-denied"));
    assert.equal(state.getUser.mock.callCount(), 1);
    assert.equal(state.createToken.mock.callCount(), 0);
    assert.equal(state.db.records.has(`privyIdentities/${OTHER}`), false);
    assert.equal(state.db.records.has(`privyIdentities/${ADDRESS}`), false);
  });

  it("still rejects a suspended returning member", async (t) => {
    const state = productionExchange(t, {
      profile: { address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID, suspended: true, role: 0 },
    });
    await assert.rejects(exchangePrivySession(state.request(), state.deps), hasCode("permission-denied"));
    assert.equal(state.verifyToken.mock.callCount(), 1);
    assert.equal(state.getUser.mock.callCount(), 1);
    assert.equal(state.createToken.mock.callCount(), 0);
  });

  it("fails closed when Privy cannot return the verified user", async (t) => {
    const state = productionExchange(t, { fetchUserError: new Error("Privy unavailable") });
    await assert.rejects(exchangePrivySession(state.request(), state.deps), hasCode("unavailable"));
    assert.equal(state.createToken.mock.callCount(), 0);
  });
});
