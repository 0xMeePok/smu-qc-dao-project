import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

class CspPropagationError extends Error {}

/** Check exact directive sources, rather than accepting an origin in a URL prefix. */
export function validateDeployedCsp(policy) {
  if (!policy) throw new CspPropagationError("The deployed response has no Content-Security-Policy header");
  assert.equal(policy.includes("*.cloudfunctions.net"), false, "Cloud Functions wildcard remains live");
  assert.equal(policy.includes("*.googleapis.com"), false, "Google APIs wildcard remains live");
  assert.equal(/\*\.(?:rpc\.)?privy\./.test(policy), false, "Privy wildcard remains live");
  const directives = new Map();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    assert.equal(directives.has(name), false, `The deployed CSP repeats ${name}`);
    directives.set(name, new Set(sources));
  }
  for (const [directive, origin, message] of [
    ["connect-src", "https://asia-southeast1-qcdao-a0c7a.cloudfunctions.net", "The deployed CSP does not allow the QC DAO function endpoint"],
    ["connect-src", "https://firebasestorage.googleapis.com", "The deployed CSP does not allow Cloud Storage, so posting attachments cannot upload or download"],
    ["connect-src", "https://auth.privy.io", "The deployed CSP blocks Privy's API, so nobody can sign in with email"],
    ["connect-src", "https://arbitrum-sepolia.rpc.privy.systems", "The deployed CSP blocks the embedded wallet's RPC, so wallet transactions cannot be sent"],
    ["frame-src", "https://auth.privy.io", "The deployed CSP blocks Privy's wallet iframe, so the embedded wallet cannot sign"],
  ]) {
    if (!directives.get(directive)?.has(origin)) throw new CspPropagationError(message);
  }
}

/** Hosting releases can briefly return a previous policy while CDN edges update. */
export async function checkDeployedCsp(url, {
  fetchImpl = globalThis.fetch, wait = sleep, maxAttempts = 7, delayMs = 5_000,
  requestTimeoutMs = 10_000, now = Date.now, onRetry = () => {},
} = {}) {
  const endpoint = new URL(url);
  assert.ok(Number.isInteger(maxAttempts) && maxAttempts > 0, "At least one CSP check attempt is required");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const requestUrl = new URL(endpoint);
    requestUrl.searchParams.set("__qcdao_csp_check", `${now()}-${attempt}`);
    try {
      let response;
      try {
        response = await fetchImpl(requestUrl, {
          redirect: "follow", cache: "no-store",
          headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        throw new CspPropagationError("Hosting CSP request could not reach the deployed site", { cause: error });
      }
      // Only response headers are needed; do not retain the HTML stream across retries.
      await response.body?.cancel();
      if (response.status === 429 || response.status >= 500) {
        throw new CspPropagationError(`Hosting smoke request failed with HTTP ${response.status}`);
      }
      assert.equal(response.ok, true, `Hosting smoke request failed with HTTP ${response.status}`);
      validateDeployedCsp(response.headers.get("content-security-policy") ?? "");
      return;
    } catch (error) {
      // Unsafe wildcard policies and malformed directives fail immediately.
      if (!(error instanceof CspPropagationError) || attempt === maxAttempts) throw error;
      onRetry(`CSP check ${attempt}/${maxAttempts}: ${error.message}; retrying after ${delayMs} ms.`);
      await wait(delayMs);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.argv[2];
  if (!url) throw new Error("Usage: node scripts/check-csp.mjs <deployed-url>");
  try {
    await checkDeployedCsp(url, { onRetry: console.log });
    console.log("Deployed CSP is present and restricted to documented endpoints.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
