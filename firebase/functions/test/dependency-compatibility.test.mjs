import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { PrivyClient, verifyAccessToken } from "@privy-io/node";
import { parseTransaction, recoverTransactionAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Public, deterministic test key; the expected transaction was independently
// serialized and signed with ethers 6.17.0, not calculated by the code under test.
test("dependency updates preserve the Arbitrum Sepolia signing vector", async () => {
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const serializedTransaction = await account.signTransaction({
    type: "eip1559", chainId: 421614, nonce: 3,
    to: `0x${"22".repeat(20)}`, value: 1_000_000n, gas: 21_000n,
    maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    data: "0x",
  });
  assert.equal(serializedTransaction, "0x02f87083066eee03843b9aca008477359400825208942222222222222222222222222222222222222222830f424080c080a0a46028be24f3e273b445b6791cbec8c4d7a35efd1bbf2cbf056f491ba6aa4c5ea03c071c7324a0953fb4c596768a8592048fa7dee3807bdd7e95f800644b7d3eb1");
  assert.equal(await recoverTransactionAddress({ serializedTransaction }), account.address);
  const parsed = parseTransaction(serializedTransaction);
  assert.equal(parsed.chainId, 421614);
  assert.equal(parsed.nonce, 3);
  assert.equal(parsed.value, 1_000_000n);
});

test("the installed Privy SDK retains the server session API", () => {
  const client = new PrivyClient({ appId: "dependency-test-app", appSecret: "test-only-secret" });
  assert.equal(typeof client.utils().auth().verifyAccessToken, "function");
  assert.equal(typeof client.users()._get, "function");
});

// Exercise the real SDK/JWT library with local keys, without mocking verification
// or making a request to Privy. Production keys and credentials are never used.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const verificationKey = publicKey.export({ type: "spki", format: "pem" });
function jwt(overrides = {}, key = privateKey, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", ...headerOverrides })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "privy.io", aud: "dependency-test-app", sub: "did:privy:dependency-test",
    sid: "dependency-test-session", iat: now - 10, exp: now + 300, ...overrides,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
const verify = token => verifyAccessToken({
  access_token: token, app_id: "dependency-test-app", verification_key: verificationKey,
});

test("the real Privy verifier accepts a correctly signed app-scoped JWT", async () => {
  const claims = await verify(jwt());
  assert.equal(claims.user_id, "did:privy:dependency-test");
  assert.equal(claims.app_id, "dependency-test-app");
  assert.equal(claims.session_id, "dependency-test-session");
});

for (const [label, changes] of [
  ["foreign issuer", { iss: "untrusted.invalid" }],
  ["another application", { aud: "another-app" }],
  ["expired token", { exp: 1 }],
  ["future not-before", { nbf: 4_102_444_800 }],
]) {
  test(`the real Privy verifier rejects ${label}`, async () => {
    await assert.rejects(verify(jwt(changes)));
  });
}

test("the real Privy verifier rejects an unrelated signing key and algorithm", async () => {
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await assert.rejects(verify(jwt({}, other.privateKey)));
  await assert.rejects(verify(jwt({}, privateKey, { alg: "HS256" })));
});
