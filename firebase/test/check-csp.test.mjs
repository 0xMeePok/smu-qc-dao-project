import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";
import { checkDeployedCsp, validateDeployedCsp } from "../scripts/check-csp.mjs";

const config = JSON.parse(fs.readFileSync(new URL("../firebase.json", import.meta.url), "utf8"));
const policy = config.hosting.headers.flatMap(entry => entry.headers)
  .find(header => header.key === "Content-Security-Policy").value;
const previousPolicy = policy.replaceAll(" https://auth.privy.io", "")
  .replaceAll(" https://arbitrum-sepolia.rpc.privy.systems", "");
const response = (csp, status = 200) => new Response("", {
  status, headers: csp ? { "Content-Security-Policy": csp } : {},
});

it("a previous Hosting policy is retried with fresh requests until Privy is available", async () => {
  const requests = [];
  const pauses = [];
  await checkDeployedCsp("https://hosting.example.test/?existing=keep", {
    maxAttempts: 3, now: () => 123, wait: async ms => pauses.push(ms),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(requests.length === 1 ? previousPolicy : policy);
    },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(pauses, [5_000]);
  assert.notEqual(requests[0].url.href, requests[1].url.href);
  assert.equal(requests[1].url.searchParams.get("existing"), "keep");
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(requests[0].options.headers["Cache-Control"], "no-cache");
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

it("a genuinely missing Privy origin still fails after the bounded retry window", async () => {
  let attempts = 0;
  await assert.rejects(checkDeployedCsp("https://hosting.example.test", {
    maxAttempts: 3, wait: async () => {}, fetchImpl: async () => {
      attempts += 1;
      return response(previousPolicy);
    },
  }), /blocks Privy's API/);
  assert.equal(attempts, 3);
});

it("unsafe wildcards fail immediately rather than hiding a bad deployment", async () => {
  for (const origin of ["https://*.cloudfunctions.net", "https://*.googleapis.com", "https://*.rpc.privy.systems"]) {
    let attempts = 0;
    await assert.rejects(checkDeployedCsp("https://hosting.example.test", {
      fetchImpl: async () => {
        attempts += 1;
        return response(`${policy}; child-src ${origin}`);
      },
      wait: async () => assert.fail("Unsafe policies must not be retried"),
    }), /wildcard remains live/);
    assert.equal(attempts, 1);
  }
});

it("required Privy sources must be exact origins in the correct directives", () => {
  assert.doesNotThrow(() => validateDeployedCsp(policy));
  assert.throws(() => validateDeployedCsp(policy.replaceAll("https://auth.privy.io", "https://auth.privy.io.attacker.example")), /blocks Privy's API/);
  assert.throws(() => validateDeployedCsp(policy.replace("frame-src https://www.google.com/recaptcha/ https://auth.privy.io", "frame-src https://www.google.com/recaptcha/")), /blocks Privy's wallet iframe/);
  assert.throws(() => validateDeployedCsp(`${policy}; connect-src https://auth.privy.io`), /repeats connect-src/);
});

it("temporary Hosting and network failures retry, while a wrong site fails immediately", async () => {
  let attempts = 0;
  await checkDeployedCsp("https://hosting.example.test", {
    maxAttempts: 3, wait: async () => {}, fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return response(policy, attempts === 2 ? 503 : 200);
    },
  });
  assert.equal(attempts, 3);
  await assert.rejects(checkDeployedCsp("https://hosting.example.test", {
    fetchImpl: async () => response(null, 404),
    wait: async () => assert.fail("HTTP 404 must not be retried"),
  }), /HTTP 404/);
});
