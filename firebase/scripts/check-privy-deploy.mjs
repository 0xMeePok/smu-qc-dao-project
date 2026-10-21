import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const MISSING_APP_ID = "Cloud Functions needs a valid public PRIVY_APP_ID in functions/.env or functions/.env.<project-id>. Set it to the frontend's VITE_PRIVY_APP_ID before deploying. Keep PRIVY_SECRET in Secret Manager.";

/** Firebase deploy overlays .env.<project-id> onto .env; .env.local is emulator-only. */
export function requireDeploymentPrivyAppId({ projectId, functionsDirectory }) {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
    throw new Error("Use an explicit Firebase project ID (6–30 lowercase letters, digits or hyphens), not a project alias.");
  }
  let environment = {};
  for (const name of [".env", `.env.${projectId}`]) {
    let contents;
    try {
      contents = readFileSync(path.join(functionsDirectory, name), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error("Could not read the Cloud Functions deployment environment. Check functions/.env and functions/.env.<project-id>.");
    }
    try {
      environment = { ...environment, ...parseEnv(contents) };
    } catch {
      // Parser errors can contain environment values. Never echo them.
      throw new Error("Could not parse the Cloud Functions deployment environment. Check functions/.env and functions/.env.<project-id>.");
    }
  }
  const raw = environment.PRIVY_APP_ID;
  const appId = typeof raw === "string" ? raw.trim() : "";
  if (!appId || /[\r\n]/.test(raw) || /[^A-Za-z0-9_-]/.test(appId)) {
    throw new Error(MISSING_APP_ID);
  }
  return appId;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    requireDeploymentPrivyAppId({
      projectId: process.argv[2],
      functionsDirectory: path.resolve("functions"),
    });
    console.log("Privy sign-in app ID is configured for Cloud Functions.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
