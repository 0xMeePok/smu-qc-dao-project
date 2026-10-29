import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { resolveConfig } from "vite";
import { assertPublicPrivyEnvironment } from "../../scripts/privy-build-config.mjs";

it("permits the public app ID and Firebase client config, without rejecting server-only secrets", () => {
  assert.doesNotThrow(() => assertPublicPrivyEnvironment({
    VITE_PRIVY_APP_ID: "public-app-id", VITE_FIREBASE_API_KEY: "public-firebase-key", PRIVY_SECRET: "server-only",
  }));
});

it("rejects public Privy secret, token and private-key names without printing their values", () => {
  for (const name of ["VITE_PRIVY_SECRET", "VITE_PRIVY_APP_SECRET", "VITE_PRIVY_CLIENT_SECRET", "VITE_PRIVY_WALLET_PRIVATE_KEY", "VITE_PRIVY_AUTHORIZATION_KEY", "VITE_PRIVY_API_KEY", "VITE_PRIVY_ACCESS_TOKEN"]) {
    assert.throws(() => assertPublicPrivyEnvironment({ [name]: "private-sentinel-148" }), error => {
      assert.ok(error.message.includes(name));
      assert.equal(error.message.includes("private-sentinel-148"), false);
      return true;
    });
  }
});

it("the real Vite config rejects a credential loaded from a production environment file before building", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qc-privy-build-"));
  try {
    await writeFile(path.join(directory, ".env.production.local"), "VITE_PRIVY_APP_SECRET=dummy\n");
    await assert.rejects(resolveConfig({
      root: directory,
      configFile: fileURLToPath(new URL("../../vite.config.js", import.meta.url)),
      logLevel: "silent",
    }, "build", "production"), /Privy server credentials cannot use the public VITE_ prefix: VITE_PRIVY_APP_SECRET/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects public OpenAI credentials without printing them while allowing the server secret", () => {
  assert.doesNotThrow(() => assertPublicPrivyEnvironment({ OPENAI_API_KEY: "server-only" }));
  for (const name of ["VITE_OPENAI_API_KEY", "VITE_OPENAI_SECRET", "VITE_OPENAI_ACCESS_TOKEN"]) {
    assert.throws(() => assertPublicPrivyEnvironment({ [name]: "private-openai-sentinel" }), error => {
      assert.ok(error.message.includes(name));
      assert.equal(error.message.includes("private-openai-sentinel"), false);
      return true;
    });
  }
});
