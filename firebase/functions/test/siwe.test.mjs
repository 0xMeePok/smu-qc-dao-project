/**
 * Adversarial tests for server-side wallet verification.
 *
 * Run with the emulators up:
 *   cd firebase && npx firebase emulators:start --only functions,firestore,auth --project qc-dao-demo
 *   cd firebase/functions && npm test
 *
 * These are the tests that make "fool proof" a claim rather than a hope: every case
 * below is a way a browser could try to obtain a session for a wallet it does not
 * control.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const BASE =
  process.env.FUNCTIONS_BASE_URL ??
  "http://127.0.0.1:5001/qc-dao-demo/asia-southeast1";

async function call(fn, data) {
  const res = await fetch(`${BASE}/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ data }),
  });
  return res.json().catch(() => ({}));
}

const victim = privateKeyToAccount(generatePrivateKey());
const attacker = privateKeyToAccount(generatePrivateKey());

before(async () => {
  const probe = await call("getSiweNonce", { address: victim.address });
  assert.ok(
    probe.result?.message,
    `Functions emulator is not reachable at ${BASE}. Start the emulators first.`,
  );
});

describe("honest sign-in", () => {
  it("issues a message, verifies the signature and mints a token for that address", async () => {
    const { result: nonce } = await call("getSiweNonce", { address: victim.address });
    assert.ok(nonce.message.includes(victim.address.toLowerCase()));
    assert.ok(nonce.message.includes(`Nonce: ${nonce.nonce}`));

    const signature = await victim.signMessage({ message: nonce.message });
    const { result } = await call("verifySiweSignature", {
      address: victim.address,
      signature,
    });

    assert.ok(result.token, "a valid signature should mint a custom token");
    assert.equal(result.address, victim.address.toLowerCase());
  });
});

describe("attacks that must fail", () => {
  it("rejects a replayed signature", async () => {
    const { result: nonce } = await call("getSiweNonce", { address: victim.address });
    const signature = await victim.signMessage({ message: nonce.message });

    const first = await call("verifySiweSignature", { address: victim.address, signature });
    assert.ok(first.result?.token, "first use should succeed");

    const second = await call("verifySiweSignature", { address: victim.address, signature });
    assert.equal(second.result?.token, undefined, "the nonce must be single use");
  });

  it("rejects a signature produced by a different key", async () => {
    const { result: nonce } = await call("getSiweNonce", { address: victim.address });
    const signature = await attacker.signMessage({ message: nonce.message });
    const res = await call("verifySiweSignature", { address: victim.address, signature });
    assert.equal(res.result?.token, undefined);
  });

  it("rejects a fabricated signature", async () => {
    await call("getSiweNonce", { address: victim.address });
    const res = await call("verifySiweSignature", {
      address: victim.address,
      signature: `0x${"11".repeat(65)}`,
    });
    assert.equal(res.result?.token, undefined);
  });

  it("rejects a real signature over a message the server never issued", async () => {
    await call("getSiweNonce", { address: victim.address });
    const signature = await victim.signMessage({ message: "I agree to give away everything" });
    const res = await call("verifySiweSignature", { address: victim.address, signature });
    assert.equal(res.result?.token, undefined);
  });

  it("rejects verification when no nonce was ever requested", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const res = await call("verifySiweSignature", {
      address: stranger.address,
      signature: `0x${"22".repeat(65)}`,
    });
    assert.equal(res.result?.token, undefined);
  });

  it("rejects a malformed address", async () => {
    const res = await call("getSiweNonce", { address: "not-an-address" });
    assert.equal(res.result?.message, undefined);
  });
});
