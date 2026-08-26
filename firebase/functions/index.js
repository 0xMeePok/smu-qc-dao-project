import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { createPublicClient, http, verifyMessage } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { randomBytes } from "node:crypto";

initializeApp();

const db = getFirestore();
const NONCE_COLLECTION = "siweNonces";
const NONCE_TTL_MS = 5 * 60 * 1000;

// Minimum time between two nonces for the SAME address. `getSiweNonce` is
// unauthenticated by necessity (proving identity is the whole point of calling it),
// so nothing stops it being called repeatedly for one address - and every prior
// version of this function's `.set()` unconditionally overwrote whatever nonce was
// already pending. That is a real, currently-live griefing path, not a hypothetical
// one: request a nonce for a victim's PUBLIC address (profiles are readable by
// anyone) faster than they can sign it, and their in-flight sign-in breaks every
// time, because the message they already signed no longer matches what is stored.
// This also bounds Firestore write volume from address-spam at close to zero cost
// to legitimate traffic, since a real sign-in only ever calls this once.
const NONCE_COOLDOWN_MS = 3_000;

// Hard ceiling on concurrent instances. Bounds the worst-case cost and blast radius
// of a volumetric flood (many distinct addresses, one call each, so the per-address
// cooldown above does not apply) to a fixed number regardless of how much traffic
// arrives - once instances are saturated, Cloud Run queues or fails fast rather than
// autoscaling without limit. This adds no latency to normal traffic; a handful of
// concurrent sign-ins never gets close to it.
const NONCE_MAX_INSTANCES = 10;

// Must match FUNCTIONS_REGION in frontend/src/lib/firebase.js. Must ALSO match the
// Firestore database's own location (see `firebase firestore:databases:get
// "(default)" --project <id>`, and firebase/README.md for how to set it on a fresh
// project) - getSiweNonce does two sequential Firestore round trips per call (a read
// then a write), and every one of them crosses regions if this doesn't match. That
// was previously true here (functions in asia-southeast1, Firestore left on its
// default nam5/US location) and measured out to ~400ms-1.3s per sign-in from cross-
// Pacific latency alone, dwarfing everything else on the critical path. 
const REGION = "asia-southeast1";

const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(process.env.ARBITRUM_SEPOLIA_RPC_URL || undefined),
});

function normaliseAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new HttpsError("invalid-argument", "A valid wallet address is required.");
  }
  return value.toLowerCase();
}

/**
 * Builds the exact string the user signs.
 *
 * This lives ONLY on the server. The client never supplies a message: it asks for a
 * nonce, receives the finished message, and signs it verbatim. If the client could
 * choose the text, it could get a user to sign something harmless here and replay
 * that signature somewhere it means much more.
 */
function buildMessage({ address, nonce, issuedAt, domain }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to SMU QC DAO. This proves you control this wallet.",
    "It authorises no transaction, moves no funds and costs no gas.",
    "",
    `URI: https://${domain}`,
    "Version: 1",
    `Chain ID: ${arbitrumSepolia.id}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

// The SIWE `domain` field binds a signature to ONE site. Its whole purpose is to
// make a signature collected on one origin useless on another.
// Now the domain is server-controlled: an Origin is only honoured when it appears on
// an allow-list this deployment owns, and anything else is refused outright.
const SIWE_DOMAIN_FALLBACK = "smu-qc-dao";

// Cloud Functions sets GCLOUD_PROJECT; Firebase Hosting always provisions
// <project>.web.app and <project>.firebaseapp.com. Deriving them means the common
// deployment needs no configuration and still keeps the message accurate for real
// users, instead of a hardcoded guess that rots the moment the project is renamed.
function defaultAllowedHosts() {
  const projectId = (process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "").trim();
  return projectId ? [`${projectId}.web.app`, `${projectId}.firebaseapp.com`] : [];
}

// Dev origins are allowed ONLY under the emulator. Allow-listing localhost in
// production would reopen the hole: an attacker would forge `Origin:
// localhost:5173` and be handed a signable message again.
const DEV_HOSTS = ["localhost:5173", "127.0.0.1:5173"];

function canonicalDomain() {
  return (process.env.SIWE_DOMAIN || "").trim().toLowerCase()
    || defaultAllowedHosts()[0]
    || SIWE_DOMAIN_FALLBACK;
}

function allowedHosts() {
  const configured = (process.env.SIWE_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const hosts = [canonicalDomain(), ...defaultAllowedHosts(), ...configured];
  if (process.env.FUNCTIONS_EMULATOR === "true") hosts.push(...DEV_HOSTS);

  return new Set(hosts.filter(Boolean));
}

function resolveDomain(request) {
  const origin = request.rawRequest?.headers?.origin;

  // No Origin at all means this cannot be a browser (curl, a server, the test
  // suite). There is nothing to validate, so the message names this deployment -
  // which is the truthful answer and the one a phishing victim most needs to see.
  if (!origin) return canonicalDomain();

  let host;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    throw new HttpsError("permission-denied", "Sign-in is not available from this origin.");
  }

  // Fails CLOSED. An unrecognised Origin is a positive signal that a browser on a
  // site we do not serve is asking for a signable message, so it is refused rather
  // than quietly downgraded. Note this is deliberately NOT the shape of a check
  // that skips itself when the env var is unset - a security control that does
  // nothing until someone remembers to configure it is one that will be forgotten
  // exactly once, in production.
  if (!allowedHosts().has(host)) {
    throw new HttpsError("permission-denied", "Sign-in is not available from this origin.");
  }

  return host;
}

/**
 * Step 1 of sign-in. Issues a single-use nonce and returns the message to sign.
 * The nonce document is written with the Admin SDK, so it is unreachable from any
 * browser: firestore.rules denies the whole collection.
 */
export const getSiweNonce = onCall(
  { region: REGION, maxInstances: NONCE_MAX_INSTANCES },
  async (request) => {
    const address = normaliseAddress(request.data?.address);
    const ref = db.collection(NONCE_COLLECTION).doc(address);

    // Best-effort, not transactional: a plain read before the write below, not a
    // read-check-write wrapped in a transaction. A transaction would close a
    // negligible race (two calls for the same address landing in the same instant)
    // at the cost of serialising every nonce issuance through extra round trips -
    // real overhead on every legitimate sign-in to guard against a low-stakes edge
    // case. What actually matters here is stopping SUSTAINED repeated calls from
    // clobbering a live nonce, which this does.
    const existing = await ref.get();
    if (existing.exists) {
      const data = existing.data();
      const ageMs = Date.now() - data.createdAt.toMillis();
      if (!data.consumed && ageMs < NONCE_COOLDOWN_MS) {
        throw new HttpsError(
          "resource-exhausted",
          "A sign-in request was just issued for this wallet. Wait a few seconds and try again.",
        );
      }
    }

    const nonce = randomBytes(16).toString("hex");
    const issuedAt = new Date().toISOString();
    const domain = resolveDomain(request);
    const message = buildMessage({ address, nonce, issuedAt, domain });

    await ref.set({
      nonce,
      issuedAt,
      domain,
      address,
      consumed: false,
      expiresAt: Timestamp.fromMillis(Date.now() + NONCE_TTL_MS),
      createdAt: Timestamp.now(),
    });

    return { message, nonce, issuedAt };
  },
);

/**
 * Step 2 of sign-in. Verifies the signature against the message this server issued,
 * burns the nonce, and mints a Firebase custom token whose uid IS the wallet address.
 *
 * That uid is the whole security model: firestore.rules only ever has to check
 * `request.auth.uid == address`, and a uid can exist only if this function verified a
 * signature first. Nothing the browser does can forge one.
 */
export const verifySiweSignature = onCall({ region: REGION }, async (request) => {
  const address = normaliseAddress(request.data?.address);
  const signature = request.data?.signature;

  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    throw new HttpsError("invalid-argument", "A signature is required.");
  }

  const ref = db.collection(NONCE_COLLECTION).doc(address);

  // The nonce is claimed inside a transaction so two parallel attempts cannot both
  // spend it. A replayed signature therefore fails on the second use.
  const record = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) {
      throw new HttpsError("failed-precondition", "No sign-in request is pending for this wallet. Start again.");
    }

    const data = snapshot.data();
    if (data.consumed) {
      throw new HttpsError("failed-precondition", "That sign-in request was already used. Start again.");
    }
    if (data.expiresAt.toMillis() < Date.now()) {
      throw new HttpsError("deadline-exceeded", "That sign-in request expired. Start again.");
    }

    tx.update(ref, { consumed: true, consumedAt: Timestamp.now() });
    return data;
  });

  // Rebuilt from what the server stored, never from anything the client sent.
  const message = buildMessage({
    address,
    nonce: record.nonce,
    issuedAt: record.issuedAt,
    domain: record.domain,
  });

  let valid = false;
  try {
    valid = await verifyMessage({ address, message, signature, client: publicClient });
  } catch {
    valid = false;
  }

  if (!valid) {
    // The nonce was claimed inside the transaction above before verification ran,
    // so a wrong or forged signature would otherwise burn it permanently - anyone
    // who knows a target's PUBLIC address (profiles are readable by anyone) could
    // call this with a garbage signature and lock the real owner out until they
    // requested a fresh nonce. Reverting it here means a bogus attempt costs the
    // legitimate holder nothing: their already-signed message still matches this
    // same nonce and can be resubmitted immediately.
    await ref.update({ consumed: false }).catch(() => {});
    throw new HttpsError("permission-denied", "That signature does not match this wallet.");
  }

  const token = await getAuth().createCustomToken(address, {
    wallet: address,
    chainId: arbitrumSepolia.id,
  });

  return { token, address };
});
