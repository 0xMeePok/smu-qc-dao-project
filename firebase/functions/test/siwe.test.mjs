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

// `origin` is overridable (and omittable, via null) so the SIWE domain-binding tests
// below can pose as a browser on some other site.
async function call(fn, data, { origin = "http://localhost:5173" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin !== null) headers.Origin = origin;

  const res = await fetch(`${BASE}/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data }),
  });
  return res.json().catch(() => ({}));
}

// A fresh account per test, not one shared "victim" for the whole file: getSiweNonce
// now enforces a per-address cooldown (see NONCE_COOLDOWN_MS in index.js), so reusing
// one address across many tests run in quick succession would trip the very rate
// limit under test and fail every test after the first for reasons unrelated to what
// it's actually checking. Real users don't share a wallet either, so this is also the
// more faithful model.
const attacker = privateKeyToAccount(generatePrivateKey());

before(async () => {
  const probe = await call("getSiweNonce", { address: privateKeyToAccount(generatePrivateKey()).address });
  assert.ok(
    probe.result?.message,
    `Functions emulator is not reachable at ${BASE}. Start the emulators first.`,
  );
});

describe("honest sign-in", () => {
  it("issues a message, verifies the signature and mints a token for that address", async () => {
    const victim = privateKeyToAccount(generatePrivateKey());
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
    const victim = privateKeyToAccount(generatePrivateKey());
    const { result: nonce } = await call("getSiweNonce", { address: victim.address });
    const signature = await victim.signMessage({ message: nonce.message });

    const first = await call("verifySiweSignature", { address: victim.address, signature });
    assert.ok(first.result?.token, "first use should succeed");

    const second = await call("verifySiweSignature", { address: victim.address, signature });
    assert.equal(second.result?.token, undefined, "the nonce must be single use");
  });

  it("rejects a signature produced by a different key", async () => {
    const victim = privateKeyToAccount(generatePrivateKey());
    const { result: nonce } = await call("getSiweNonce", { address: victim.address });
    const signature = await attacker.signMessage({ message: nonce.message });
    const res = await call("verifySiweSignature", { address: victim.address, signature });
    assert.equal(res.result?.token, undefined);
  });

  it("rejects a fabricated signature", async () => {
    const victim = privateKeyToAccount(generatePrivateKey());
    await call("getSiweNonce", { address: victim.address });
    const res = await call("verifySiweSignature", {
      address: victim.address,
      signature: `0x${"11".repeat(65)}`,
    });
    assert.equal(res.result?.token, undefined);
  });

  it("rejects a real signature over a message the server never issued", async () => {
    const victim = privateKeyToAccount(generatePrivateKey());
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

describe("recovery after a failed attempt", () => {
  it("does not permanently burn the nonce when a bogus signature is submitted first", async () => {
    // The nonce is claimed inside a transaction before signature verification runs,
    // so a wrong signature used to leave it stuck "consumed" forever - anyone who
    // knew a target's PUBLIC address (profiles are readable by anyone) could grief
    // them out of signing in by submitting garbage for their address. The real
    // owner's already-signed message must still work afterwards.
    const victim = privateKeyToAccount(generatePrivateKey());
    const { result: nonce } = await call("getSiweNonce", { address: victim.address });

    const bogus = await attacker.signMessage({ message: nonce.message });
    const failed = await call("verifySiweSignature", { address: victim.address, signature: bogus });
    assert.equal(failed.result?.token, undefined, "the attacker's signature must not verify");

    const real = await victim.signMessage({ message: nonce.message });
    const recovered = await call("verifySiweSignature", { address: victim.address, signature: real });
    assert.ok(recovered.result?.token, "the legitimate holder must still be able to complete sign-in");
    assert.equal(recovered.result.address, victim.address.toLowerCase());
  });
});

describe("getSiweNonce rate limiting", () => {
  it("blocks a second nonce request for the same address while one is still pending", async () => {
    const fresh = privateKeyToAccount(generatePrivateKey());
    const first = await call("getSiweNonce", { address: fresh.address });
    assert.ok(first.result?.message, "the first request should succeed");

    const second = await call("getSiweNonce", { address: fresh.address });
    assert.equal(second.result?.message, undefined, "an immediate second request must be rejected");
    assert.equal(second.error?.status, "RESOURCE_EXHAUSTED");
  });

  it("does not let a rate-limited spam attempt invalidate a victim's pending nonce", async () => {
    // This is the actual attack the cooldown exists to stop: request a nonce for a
    // PUBLIC address (profiles are readable by anyone), then immediately request
    // another one for the same address before the real owner can sign - if that
    // second call succeeded, it would overwrite the nonce the victim already has
    // open in their wallet, and their real signature would stop matching anything.
    const fresh = privateKeyToAccount(generatePrivateKey());
    const { result: victimNonce } = await call("getSiweNonce", { address: fresh.address });

    const spam = await call("getSiweNonce", { address: fresh.address });
    assert.equal(spam.result?.message, undefined, "the spam request must be rejected, not overwrite the nonce");

    const signature = await fresh.signMessage({ message: victimNonce.message });
    const outcome = await call("verifySiweSignature", { address: fresh.address, signature });
    assert.ok(outcome.result?.token, "the victim's original nonce must still be valid and usable");
  });

  it("allows an immediate fresh nonce once the previous one has been consumed", async () => {
    const fresh = privateKeyToAccount(generatePrivateKey());
    const { result: nonce } = await call("getSiweNonce", { address: fresh.address });
    const signature = await fresh.signMessage({ message: nonce.message });
    const first = await call("verifySiweSignature", { address: fresh.address, signature });
    assert.ok(first.result?.token, "the first sign-in should succeed");

    // No cooldown wait here - a consumed nonce is not "pending", so a signed-out
    // user reconnecting right away must not be rate-limited against themselves.
    const again = await call("getSiweNonce", { address: fresh.address });
    assert.ok(again.result?.message, "a fresh nonce after consumption should not be rate-limited");
  });
});

describe("SIWE domain binding", () => {
  // The `domain` line in a SIWE message is what stops a signature collected on one
  // site being spent on another. When getSiweNonce echoed back the caller's Origin,
  // that binding was decided by the caller and therefore meant nothing: a request
  // carrying `Origin: https://evil.example` came back with "evil.example wants you
  // to sign in...", and a user tricked into signing it on that site handed over a
  // real session for THIS project. Verified against the deployed function before the
  // fix, so these tests cover a hole that was genuinely open, not a hypothetical.
  it("refuses to mint a signable message for an origin it does not serve", async () => {
    const fresh = privateKeyToAccount(generatePrivateKey());
    const res = await call(
      "getSiweNonce",
      { address: fresh.address },
      { origin: "https://totally-evil-phishing-site.example" },
    );

    assert.equal(res.result?.message, undefined, "an unknown origin must not receive a message");
    assert.equal(res.error?.status, "PERMISSION_DENIED");
  });

  it("never names an attacker-supplied domain in the message it signs", async () => {
    const fresh = privateKeyToAccount(generatePrivateKey());
    const res = await call(
      "getSiweNonce",
      { address: fresh.address },
      { origin: "https://evil.example" },
    );

    // Belt and braces: even if the call were somehow allowed, the attacker's domain
    // must never appear in a message this server produced.
    assert.ok(
      !JSON.stringify(res).includes("evil.example"),
      "the attacker's domain must not be reflected back anywhere in the response",
    );
  });

  it("serves an allow-listed development origin normally", async () => {
    const fresh = privateKeyToAccount(generatePrivateKey());
    const res = await call("getSiweNonce", { address: fresh.address });

    assert.ok(res.result?.message, "the app's own origin must still work");
    assert.ok(
      res.result.message.includes("localhost:5173"),
      "an allow-listed origin is still named accurately, so the user sees where they are signing in",
    );
  });

  it("falls back to this deployment's own domain when there is no Origin at all", async () => {
    // A request with no Origin cannot be a browser, so there is nothing to spoof and
    // nothing to validate - it should still produce a usable message rather than an
    // error, and that message must name this deployment.
    const fresh = privateKeyToAccount(generatePrivateKey());
    const res = await call("getSiweNonce", { address: fresh.address }, { origin: null });

    assert.ok(res.result?.message, "a non-browser caller should still get a message");
    assert.ok(
      !res.result.message.includes("localhost:5173"),
      "the no-Origin fallback must be the server's own domain, not a dev origin",
    );
  });

  it("still completes a real sign-in end to end from an allowed origin", async () => {
    // Guards against a fix that secures the domain by breaking sign-in.
    const fresh = privateKeyToAccount(generatePrivateKey());
    const { result: nonce } = await call("getSiweNonce", { address: fresh.address });
    const signature = await fresh.signMessage({ message: nonce.message });
    const outcome = await call("verifySiweSignature", { address: fresh.address, signature });

    assert.ok(outcome.result?.token, "a legitimate user must still be able to sign in");
  });
});
