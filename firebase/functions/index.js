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

// Must match FUNCTIONS_REGION in frontend/src/lib/firebase.js, and ideally the
// Firestore location too. A mismatch shows up in the browser as a CORS error,
// because the wrong-region URL 404s and a 404 page carries no CORS headers.
const REGION = "asia-southeast1";

// EIP-1271 lets a smart contract wallet (Safe, Argent, most account-abstraction
// wallets) "sign" without an EOA private key. viem's verifyMessage falls back to an
// on-chain isValidSignature call when the address has bytecode, so those wallets work
// too - but only if it has a chain to ask, hence the public client.
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

function resolveDomain(request) {
  const origin = request.rawRequest?.headers?.origin;
  if (!origin) return "smu-qc-dao";
  try {
    return new URL(origin).host;
  } catch {
    return "smu-qc-dao";
  }
}

/**
 * Step 1 of sign-in. Issues a single-use nonce and returns the message to sign.
 * The nonce document is written with the Admin SDK, so it is unreachable from any
 * browser: firestore.rules denies the whole collection.
 */
export const getSiweNonce = onCall({ region: REGION }, async (request) => {
  const address = normaliseAddress(request.data?.address);
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  const domain = resolveDomain(request);
  const message = buildMessage({ address, nonce, issuedAt, domain });

  await db.collection(NONCE_COLLECTION).doc(address).set({
    nonce,
    issuedAt,
    domain,
    address,
    consumed: false,
    expiresAt: Timestamp.fromMillis(Date.now() + NONCE_TTL_MS),
    createdAt: Timestamp.now(),
  });

  return { message, nonce, issuedAt };
});

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
    throw new HttpsError("permission-denied", "That signature does not match this wallet.");
  }

  const token = await getAuth().createCustomToken(address, {
    wallet: address,
    chainId: arbitrumSepolia.id,
  });

  return { token, address };
});
