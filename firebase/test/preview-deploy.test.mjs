import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deployPreviewBackend, functionsEnvWithPrivyAppId, previewPrivyAppId } from "../scripts/preview-config.mjs";

test("preview uses one validated public app ID from the built artifact", () => {
  assert.equal(previewPrivyAppId('VITE_PRIVY_APP_ID:"built-app"; VITE_PRIVY_APP_ID:"built-app"'), "built-app");
  for (const bundle of ["", 'VITE_PRIVY_APP_ID:""', 'VITE_PRIVY_APP_ID:"one"; VITE_PRIVY_APP_ID:"two"',
    'VITE_PRIVY_APP_ID:"bad=id"']) {
    assert.throws(() => previewPrivyAppId(bundle), /one configured/);
  }
});

test("updating the public ID preserves RPC values, comments, CRLF and unrelated dotenv entries", () => {
  const current = "# retain comments\r\nARBITRUM_SEPOLIA_RPC_URL=https://rpc.example\r\n"
    + "export PRIVY_APP_ID='stale'\r\nKEEP=unchanged\r\nPRIVY_APP_ID=duplicate\r\n";
  const desired = functionsEnvWithPrivyAppId(current, "built-app");
  assert.equal(desired, current.replace("export PRIVY_APP_ID='stale'", "PRIVY_APP_ID=built-app")
    .replace("PRIVY_APP_ID=duplicate", "PRIVY_APP_ID=built-app"));
  assert.equal(functionsEnvWithPrivyAppId(desired, "built-app"), desired);
  assert.equal(functionsEnvWithPrivyAppId("KEEP=unchanged", "built-app"), "KEEP=unchanged\nPRIVY_APP_ID=built-app\n");
  assert.equal(functionsEnvWithPrivyAppId("", "built-app"), "PRIVY_APP_ID=built-app\n");
  assert.throws(() => functionsEnvWithPrivyAppId(current, "bad\nOTHER=value"), /Invalid/);
});

test("assignment-like lines inside unrelated quoted multiline values remain byte-for-byte intact", () => {
  for (const quote of ["'", '"', "`"]) {
    const unrelated = `# preserve comment\r\nOTHER=${quote}first\r\nPRIVY_APP_ID=inside-unrelated-value\r\nlast${quote} # retain trailing comment\r\n`;
    assert.equal(functionsEnvWithPrivyAppId(unrelated + "PRIVY_APP_ID=old # public ID\r\n", "built-app"),
      unrelated + "PRIVY_APP_ID=built-app # public ID\r\n");
    assert.equal(functionsEnvWithPrivyAppId(unrelated, "built-app"), unrelated + "PRIVY_APP_ID=built-app\r\n");
  }
  const escaped = 'OTHER="first \\"quoted\\"\nPRIVY_APP_ID=inside-unrelated-value\nlast"\n';
  assert.equal(functionsEnvWithPrivyAppId(escaped + "PRIVY_APP_ID=old", "built-app"),
    escaped + "PRIVY_APP_ID=built-app");
});

test("replaces complete multiline public ID assignments and all actual duplicate entries", () => {
  for (const quote of ["'", '"']) {
    const current = `export PRIVY_APP_ID = ${quote}old\nmultiline-id${quote} # retain comment\n`
      + "OTHER=keep # preserve unquoted comment\nPRIVY_APP_ID=duplicate # second ID\n";
    assert.equal(functionsEnvWithPrivyAppId(current, "built-app"),
      "PRIVY_APP_ID=built-app # retain comment\nOTHER=keep # preserve unquoted comment\nPRIVY_APP_ID=built-app # second ID\n");
  }
});

test("unterminated quoted configuration fails before writing or deploying and never echoes its contents", () => {
  for (const quote of ["'", '"']) {
    const unexpected = () => assert.fail("Invalid dotenv must not be written or deployed");
    assert.throws(() => deployPreviewBackend({
      withBackend: true, appId: "built-app",
      readEnvironment: () => `PRIVY_APP_ID=old\nOTHER=${quote}private-sentinel`,
      writeEnvironment: unexpected, deployRules: unexpected, deployFunctions: unexpected,
    }), error => {
      assert.match(error.message, /unterminated quoted value/);
      assert.equal(error.message.includes("private-sentinel"), false);
      return true;
    });
  }
});

test("frontend-only backend preparation performs no environment reads, writes or deployments", () => {
  const unexpected = () => assert.fail("A frontend-only preview must not touch the backend");
  deployPreviewBackend({ withBackend: false, appId: "built-app", readEnvironment: unexpected,
    writeEnvironment: unexpected, deployRules: unexpected, deployFunctions: unexpected });
});

function previewFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qcdao-preview-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["firebase/scripts", "firebase/public/assets", "firebase/functions", "frontend", "bin"]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
  for (const name of ["preview-deploy.mjs", "preview-config.mjs"]) {
    copyFileSync(path.join(scripts, name), path.join(root, "firebase/scripts", name));
  }
  writeFileSync(path.join(root, "firebase/public/assets/main.js"),
    '({VITE_FIREBASE_USE_EMULATORS:"false",VITE_FIREBASE_PROJECT_ID:"qcdao-a0c7a",VITE_PRIVY_APP_ID:"built-app"});');
  writeFileSync(path.join(root, "firebase/storage.cors.json"), JSON.stringify([{ origin: ["https://qcdao-a0c7a.web.app"] }]));
  const environmentFile = path.join(root, "firebase/functions/.env.qcdao-a0c7a");
  const originalEnvironment = "# existing runtime config\nARBITRUM_SEPOLIA_RPC_URL=https://rpc.example\nPRIVY_APP_ID=server-stale\nKEEP=unchanged\n";
  writeFileSync(environmentFile, originalEnvironment);
  // The build has already resolved these inputs. Neither is authoritative over
  // the shipped artifact when the server configuration is prepared afterwards.
  writeFileSync(path.join(root, "frontend/.env"), "VITE_PRIVY_APP_ID=base-stale\n");
  writeFileSync(path.join(root, "frontend/.env.local"), "VITE_PRIVY_APP_ID=local-stale\n");
  writeFileSync(path.join(root, "frontend/.env.production.local"), "VITE_PRIVY_APP_ID=mode-stale\n");
  const commandLog = path.join(root, "commands.log");
  for (const command of ["npm", "npx", "gcloud"]) {
    const executable = path.join(root, "bin", command);
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PREVIEW_TEST_COMMAND_LOG, JSON.stringify([${JSON.stringify(command)}, ...args]) + '\\n');
if (${JSON.stringify(command)} === 'npx' && args.includes('functions') && process.env.PREVIEW_TEST_FAIL_FUNCTIONS) process.exit(1);
if (args.includes('hosting:channel:deploy')) console.log('https://qcdao-a0c7a--audit-example.web.app');
if (args.includes('hosting:channel:list')) console.log(JSON.stringify({result:{channels:[]}}));
if (${JSON.stringify(command)} === 'gcloud') console.log(JSON.stringify({cors_config:[{origin:['https://qcdao-a0c7a.web.app']}]}));
`);
    chmodSync(executable, 0o755);
  }
  return {
    environmentFile,
    originalEnvironment,
    run: (args, extraEnv = {}) => execFileSync(process.execPath,
      [path.join(root, "firebase/scripts/preview-deploy.mjs"), "audit", ...args], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 4000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
          PREVIEW_TEST_COMMAND_LOG: commandLog, VITE_PRIVY_APP_ID: "shell-stale", PRIVY_APP_ID: "server-shell-stale", ...extraEnv },
      }),
    commands: () => readFileSync(commandLog, "utf8").trim().split("\n").map(line => JSON.parse(line)),
  };
}

test("backend preview synchronizes the built ID and deploys rules and functions before hosting", (t) => {
  const fixture = previewFixture(t);
  fixture.run(["--backend"]);
  assert.equal(readFileSync(fixture.environmentFile, "utf8"),
    fixture.originalEnvironment.replace("PRIVY_APP_ID=server-stale", "PRIVY_APP_ID=built-app"));
  const commands = fixture.commands();
  const rules = commands.findIndex(args => args.includes("firestore:rules,firestore:indexes,storage"));
  const functions = commands.findIndex(args => args.includes("functions"));
  const hosting = commands.findIndex(args => args.includes("hosting:channel:deploy"));
  assert.ok(rules >= 0 && rules < functions && functions < hosting);
});

test("frontend-only preview and backend dry-run leave runtime environment untouched", (t) => {
  const fixture = previewFixture(t);
  fixture.run([]);
  fixture.run(["--backend", "--dry-run"]);
  assert.equal(readFileSync(fixture.environmentFile, "utf8"), fixture.originalEnvironment);
  assert.equal(fixture.commands().filter(args => args.includes("deploy")).length, 0);
  assert.equal(fixture.commands().filter(args => args.includes("hosting:channel:deploy")).length, 1);
});

test("a failed backend deployment never publishes the preview", (t) => {
  const fixture = previewFixture(t);
  assert.throws(() => fixture.run(["--backend"], { PREVIEW_TEST_FAIL_FUNCTIONS: "true" }));
  assert.ok(fixture.commands().some(args => args.includes("functions")));
  assert.ok(fixture.commands().every(args => !args.includes("hosting:channel:deploy")));
});
