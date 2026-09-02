/**
 * Seeds the sample postings before `npm run dev`, when that makes sense.
 *
 * Runs as npm's `predev` hook. It must NEVER stop the dev server starting: a
 * missing emulator or an uninstalled functions dependency is a reason to skip
 * seeding, not a reason to be unable to work on the frontend. Every failure path
 * here warns and exits 0.
 *
 * It also refuses to touch anything but the emulators. Seeding is a convenience
 * for local work; writing sample postings into the shared project because someone
 * ran the dev server would be a surprise nobody asked for.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "..");
const SEEDER = path.resolve(FRONTEND, "../firebase/functions/scripts/mock_data.mjs");

function skip(reason) {
  console.log(`[seed] skipped — ${reason}`);
  process.exit(0);
}

/**
 * Mirrors Vite's precedence: .env first, then .env.local on top. Only the one
 * flag is needed, so this stays a few lines rather than pulling in dotenv.
 */
function readEnvFlag(name) {
  let value;
  for (const file of [".env", ".env.local"]) {
    const full = path.join(FRONTEND, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && match[1] === name) value = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return value;
}

function portIsOpen(port, host = "127.0.0.1", timeout = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

if (readEnvFlag("VITE_FIREBASE_USE_EMULATORS") !== "true") {
  skip("VITE_FIREBASE_USE_EMULATORS is not true, so this build talks to the live project");
}

if (!existsSync(SEEDER)) skip("the seed script is missing");

const [firestoreUp, storageUp] = await Promise.all([portIsOpen(8080), portIsOpen(9199)]);
if (!firestoreUp || !storageUp) {
  const missing = [!firestoreUp && "Firestore :8080", !storageUp && "Storage :9199"]
    .filter(Boolean).join(" and ");
  skip(
    `${missing} not reachable. Start them with:\n`
    + "        cd firebase && npx firebase emulators:start "
    + "--only functions,firestore,auth,storage --project qcdao-a0c7a",
  );
}

console.log("[seed] populating the emulators with sample postings…");
const result = spawnSync(process.execPath, [SEEDER], {
  stdio: "inherit",
  env: { ...process.env, MOCK_TARGET: "emulator" },
});

if (result.status !== 0) {
  // Most likely the PDF fixtures or the functions dependencies are absent. The
  // seeder has already printed which; do not let it hold up the dev server.
  console.warn("[seed] seeding did not complete. Continuing to the dev server anyway.");
}
process.exit(0);
