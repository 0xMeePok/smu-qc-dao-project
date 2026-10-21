import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { requireDeploymentPrivyAppId } from "../scripts/check-privy-deploy.mjs";

const projectId = "qcdao-test-148";
const checker = fileURLToPath(new URL("../scripts/check-privy-deploy.mjs", import.meta.url));

async function fixture(t, files = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qc-privy-deploy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const functionsDirectory = path.join(directory, "functions");
  await mkdir(functionsDirectory);
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(functionsDirectory, name), value);
  return { directory, functionsDirectory };
}

it("refuses a deployment without a functions app ID", async (t) => {
  const { functionsDirectory } = await fixture(t);
  assert.throws(() => requireDeploymentPrivyAppId({ projectId, functionsDirectory }), /needs a valid public PRIVY_APP_ID/);
});

it("accepts the public ID from the base dotenv file", async (t) => {
  const { functionsDirectory } = await fixture(t, { ".env": "PRIVY_APP_ID=public-base-id\n" });
  assert.equal(requireDeploymentPrivyAppId({ projectId, functionsDirectory }), "public-base-id");
});

it("uses the project-specific override and understands quotes, export and comments", async (t) => {
  const { functionsDirectory } = await fixture(t, {
    ".env": "PRIVY_APP_ID=public-base-id\n",
    [`.env.${projectId}`]: "export PRIVY_APP_ID = 'public-project-id' # public setting\n",
  });
  assert.equal(requireDeploymentPrivyAppId({ projectId, functionsDirectory }), "public-project-id");
});

it("does not fall back to the base ID when the project override is empty", async (t) => {
  const { functionsDirectory } = await fixture(t, {
    ".env": "PRIVY_APP_ID=public-base-id\n",
    [`.env.${projectId}`]: 'PRIVY_APP_ID=""\n',
  });
  assert.throws(() => requireDeploymentPrivyAppId({ projectId, functionsDirectory }), /needs a valid public PRIVY_APP_ID/);
});

it("ignores emulator and frontend configuration", async (t) => {
  const { functionsDirectory } = await fixture(t, {
    ".env.local": "PRIVY_APP_ID=emulator-only-id\n",
    ".env": "VITE_PRIVY_APP_ID=frontend-only-id\n",
  });
  assert.throws(() => requireDeploymentPrivyAppId({ projectId, functionsDirectory }), /needs a valid public PRIVY_APP_ID/);
});

it("rejects multiline and invalid public IDs without reporting their values", async (t) => {
  for (const value of ['"private-sentinel-148\\nsecond-line"', '"private-sentinel-148\nsecond-line"', '"private-sentinel-148/invalid"']) {
    const { functionsDirectory } = await fixture(t, { ".env": `PRIVY_APP_ID=${value}\n` });
    assert.throws(() => requireDeploymentPrivyAppId({ projectId, functionsDirectory }), error => {
      assert.match(error.message, /needs a valid public PRIVY_APP_ID/);
      assert.equal(error.message.includes("private-sentinel-148"), false);
      return true;
    });
  }
});

it("the CLI ignores shell app IDs and keeps credential values out of diagnostics", async (t) => {
  for (const assignment of ["", "PRIVY_APP_ID=invalid/private-id-sentinel-148\n"]) {
    const { directory } = await fixture(t, {
      ".env": `PRIVY_SECRET=dummy\n${assignment}`,
      ".env.local": "PRIVY_APP_ID=emulator-only-id\n",
    });
    const result = spawnSync(process.execPath, [checker, projectId], {
      cwd: directory,
      env: { ...process.env, PRIVY_APP_ID: "shell-only-id", VITE_PRIVY_APP_ID: "shell-frontend-id" },
      encoding: "utf8", maxBuffer: 4096,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs a valid public PRIVY_APP_ID/);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("dummy"), false);
    assert.equal(result.stderr.includes("private-id-sentinel-148"), false);
    assert.equal(result.stderr.includes("shell-only-id"), false);
  }
});

it("the CLI reports successful configuration without printing the app ID", async (t) => {
  const { directory } = await fixture(t, { [`.env.${projectId}`]: "PRIVY_APP_ID=public-project-id\n" });
  const result = spawnSync(process.execPath, [checker, projectId], { cwd: directory, encoding: "utf8", maxBuffer: 4096 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /configured for Cloud Functions/);
  assert.equal(result.stdout.includes("public-project-id"), false);
  assert.equal(result.stderr, "");
});

it("rejects invalid project IDs before reading an environment file", () => {
  for (const invalid of [undefined, "../other-project", "UPPERCASE", "short"]) {
    assert.throws(() => requireDeploymentPrivyAppId({ projectId: invalid, functionsDirectory: "/does-not-exist" }), /explicit Firebase project ID/);
  }
});
