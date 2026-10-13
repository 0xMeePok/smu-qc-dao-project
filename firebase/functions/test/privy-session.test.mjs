import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNamedAddress, embeddedWalletAddress, frontendPrivyAppId, privyAppId, PrivySessionError } from "../privySession.js";

const ADDRESS = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;

function user(accounts) {
  return { linked_accounts: accounts };
}

function email(address = "member@example.com") {
  return { type: "email", address };
}

function embedded(address, extra = {}) {
  return {
    type: "wallet",
    address,
    chain_type: "ethereum",
    connector_type: "embedded",
    wallet_client_type: "privy",
    ...extra,
  };
}

describe("embedded wallet resolution", () => {
  it("uses the embedded wallet Privy created for the email", () => {
    assert.equal(embeddedWalletAddress(user([email(), embedded(ADDRESS)])), ADDRESS);
  });

  it("ignores an external wallet and a browser-named address", () => {
    const resolved = embeddedWalletAddress(user([
      email(),
      embedded(ADDRESS),
      { type: "wallet", address: OTHER, chain_type: "ethereum", connector_type: "injected", wallet_client_type: "metamask" },
    ]));
    assert.equal(resolved, ADDRESS);
    assert.throws(() => assertNamedAddress(OTHER, resolved), (error) => error instanceof PrivySessionError && error.code === "permission-denied");
    assert.doesNotThrow(() => assertNamedAddress(`0x${"AB".repeat(20)}`, resolved));
    assert.doesNotThrow(() => assertNamedAddress(undefined, resolved));
  });

  it("refuses a session with no email, no embedded wallet, or two embedded wallets", () => {
    assert.throws(() => embeddedWalletAddress(user([embedded(ADDRESS)])), /email address/);
    assert.throws(() => embeddedWalletAddress(user([email()])), /not ready yet/);
    assert.throws(
      () => embeddedWalletAddress(user([email(), embedded(ADDRESS), embedded(OTHER)])),
      /more than one/,
    );
  });

  it("prefers the wallet Privy created over an imported one", () => {
    assert.equal(
      embeddedWalletAddress(user([email(), embedded(OTHER, { imported: true }), embedded(ADDRESS)])),
      ADDRESS,
    );
  });
});

describe("Privy app id", () => {
  const files = (map) => (name) => {
    if (!(name in map)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return map[name];
  };

  it("reads the frontend's VITE_PRIVY_APP_ID with Vite's precedence", () => {
    assert.equal(frontendPrivyAppId({ readFile: files({ ".env": "VITE_PRIVY_APP_ID=from-env\n" }) }), "from-env");
    assert.equal(frontendPrivyAppId({ readFile: files({ ".env": "VITE_PRIVY_APP_ID=from-env", ".env.local": "# local\nVITE_PRIVY_APP_ID=\"from-local\"\n" }) }), "from-local");
    assert.equal(frontendPrivyAppId({ readFile: files({ ".env.local": "VITE_PRIVY_APP_ID=", ".env": "VITE_PRIVY_APP_ID=from-env" }) }), "from-env");
    assert.equal(frontendPrivyAppId({ readFile: files({}) }), "");
  });

  it("uses the frontend's app id only in the emulator; deployed functions use PRIVY_APP_ID", () => {
    const readFrontend = () => "frontend-id";
    assert.equal(privyAppId({ env: { FUNCTIONS_EMULATOR: "true", PRIVY_APP_ID: "functions-id" }, readFrontend }), "frontend-id");
    assert.equal(privyAppId({ env: { FUNCTIONS_EMULATOR: "true", PRIVY_APP_ID: "functions-id" }, readFrontend: () => "" }), "functions-id");
    assert.equal(privyAppId({ env: { PRIVY_APP_ID: " functions-id " }, readFrontend }), "functions-id");
    assert.equal(privyAppId({ env: {}, readFrontend }), "");
  });
});
