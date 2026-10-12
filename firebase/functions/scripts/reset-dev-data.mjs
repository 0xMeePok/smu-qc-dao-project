/**
 * Wipes development data: every Firestore root collection (and the
 * subcollections under it), every Storage object, and every Firebase Auth user.
 *
 * Dry run is the default. Nothing is deleted unless --confirm equals the
 * project id.
 *
 * Emulator (the only target exercised in this repo's tests):
 *   cd firebase/functions
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *   FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199 \
 *   node scripts/reset-dev-data.mjs --project qcdao-a0c7a
 *   node scripts/reset-dev-data.mjs --project qcdao-a0c7a --confirm qcdao-a0c7a
 *
 * Live project (operator only; do not point this at anything but qcdao-a0c7a):
 *   node scripts/reset-dev-data.mjs --target production --project qcdao-a0c7a
 *   node scripts/reset-dev-data.mjs --target production --project qcdao-a0c7a --confirm qcdao-a0c7a
 *
 * Production uses Application Default Credentials. Emulator host variables
 * must be unset for that path, or the script refuses: those variables would
 * send the wipe at the emulator while the flag says production.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const LIVE_PROJECT = "qcdao-a0c7a";

export function parseArgs(argv) {
  const args = { target: "emulator", confirm: null, project: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--target") args.target = argv[++i];
    else if (arg === "--confirm") args.confirm = argv[++i];
    else if (arg === "--project") args.project = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.target) throw new Error("--target needs a value.");
  if (args.target !== "emulator" && args.target !== "production") {
    throw new Error("--target must be emulator or production.");
  }
  if (argv.includes("--confirm") && !args.confirm) throw new Error("--confirm needs the project id.");
  if (argv.includes("--project") && !args.project) throw new Error("--project needs a project id.");
  return args;
}

export function resolveTarget({ env = process.env, args }) {
  const emulatorHosts = {
    FIRESTORE_EMULATOR_HOST: env.FIRESTORE_EMULATOR_HOST,
    FIREBASE_AUTH_EMULATOR_HOST: env.FIREBASE_AUTH_EMULATOR_HOST,
    FIREBASE_STORAGE_EMULATOR_HOST: env.FIREBASE_STORAGE_EMULATOR_HOST,
  };
  const emulatorConfigured = Object.values(emulatorHosts).some(Boolean);
  const projectId = args.project || env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || LIVE_PROJECT;
  const execute = args.confirm != null;
  if (execute && args.confirm !== projectId) {
    throw new Error(`Refusing to delete. --confirm must be the project id (${projectId}).`);
  }
  if (args.target === "production") {
    if (emulatorConfigured) {
      throw new Error("Refusing a production reset while emulator host variables are set. Unset them first.");
    }
    if (projectId !== LIVE_PROJECT) {
      throw new Error(`Refusing to reset ${projectId}. The only live project this script will touch is ${LIVE_PROJECT}.`);
    }
    return { projectId, emulator: false, execute };
  }
  if (!emulatorConfigured) {
    throw new Error(
      "No emulator host is set, so this would talk to the live project. "
      + `Pass --target production --project ${LIVE_PROJECT} to inspect it. Nothing is deleted without --confirm.`,
    );
  }
  if (execute) {
    const missing = Object.entries(emulatorHosts).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`Refusing a partial wipe. Set ${missing.join(", ")} so Auth, Firestore and Storage are all the emulator.`);
    }
  }
  return { projectId, emulator: true, execute };
}

export function formatPlan(plan, { projectId, emulator, execute }) {
  const where = emulator ? `${projectId} (emulator)` : projectId;
  const lines = [
    `${execute ? "Deleting" : "Dry run"} for ${where}`,
    `Firestore root documents: ${plan.firestoreDocuments}`,
    ...(plan.collections.length
      ? plan.collections.map((row) => `  ${row.id}: ${row.count}`)
      : ["  (no collections)"]),
    "Subcollections under those documents are included in a delete.",
    `Storage objects: ${plan.storageFiles}`,
    `Auth users: ${plan.authUsers}`,
  ];
  if (!execute) {
    lines.push(`Nothing was deleted. Re-run with --confirm ${projectId} to delete.`);
  }
  return lines.join("\n");
}

async function countDocuments(collection) {
  let count = 0;
  let last = null;
  for (;;) {
    let query = collection.orderBy(FieldPath.documentId()).limit(1000);
    if (last) query = query.startAfter(last);
    const snap = await query.get();
    count += snap.size;
    if (snap.size < 1000) return count;
    last = snap.docs.at(-1);
  }
}

async function listFirestore(db) {
  const collections = await db.listCollections();
  const rows = [];
  for (const collection of collections) {
    rows.push({ id: collection.id, count: await countDocuments(collection), ref: collection });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

export async function listAuthUsers(auth) {
  const users = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

export async function listStorageFiles(bucket) {
  const files = [];
  let pageToken;
  do {
    const [batch, next] = await bucket.getFiles({ autoPaginate: false, maxResults: 1000, pageToken });
    files.push(...batch);
    pageToken = next?.pageToken;
  } while (pageToken);
  return files;
}

export async function describeReset({ db, auth, bucket }) {
  const [collections, users, files] = await Promise.all([
    listFirestore(db),
    listAuthUsers(auth),
    listStorageFiles(bucket),
  ]);
  return {
    collections: collections.map(({ id, count }) => ({ id, count })),
    firestoreDocuments: collections.reduce((sum, row) => sum + row.count, 0),
    authUsers: users.length,
    storageFiles: files.length,
  };
}

async function deleteAuthUsers(auth, users) {
  const uids = users.map((user) => user.uid);
  for (let i = 0; i < uids.length; i += 1000) {
    const slice = uids.slice(i, i + 1000);
    if (slice.length > 0) await auth.deleteUsers(slice);
  }
}

async function deleteStorageFiles(files) {
  for (let i = 0; i < files.length; i += 25) {
    await Promise.all(files.slice(i, i + 25).map((file) => file.delete({ ignoreNotFound: true })));
  }
}

export async function executeReset({ db, auth, bucket }) {
  const users = await listAuthUsers(auth);
  const files = await listStorageFiles(bucket);
  const collections = await db.listCollections();
  await deleteAuthUsers(auth, users);
  await deleteStorageFiles(files);
  for (const collection of collections) await db.recursiveDelete(collection);
  return {
    authUsers: users.length,
    storageFiles: files.length,
    collections: collections.map((collection) => collection.id).sort(),
  };
}

export function openAdmin(projectId) {
  const app = initializeApp({
    projectId,
    storageBucket: `${projectId}.firebasestorage.app`,
    ...(process.env.GOOGLE_APPLICATION_CREDENTIALS ? { credential: applicationDefault() } : {}),
  });
  return { db: getFirestore(app), auth: getAuth(app), bucket: getStorage(app).bucket() };
}

const HELP = `Usage: node scripts/reset-dev-data.mjs [--target emulator|production] [--project <id>] [--confirm <id>]

Dry run unless --confirm equals the project id.`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const target = resolveTarget({ args });
  const services = openAdmin(target.projectId);
  return describeReset(services).then(async (plan) => {
    console.log(formatPlan(plan, target));
    if (!target.execute) return;
    const deleted = await executeReset(services);
    console.log(`Deleted ${deleted.authUsers} auth user(s), ${deleted.storageFiles} storage object(s), and ${deleted.collections.length} collection(s).`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
