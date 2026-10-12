import { createHash } from "node:crypto";
import { PrivyClient } from "@privy-io/node";
import { arbitrumSepolia } from "viem/chains";

/**
 * Sign-in after Privy email login.
 *
 * The browser sends Privy's access token and nothing else that we trust. This
 * module verifies that token, reads the user from Privy, and returns the one
 * Ethereum embedded wallet on that account. The Firebase uid is that address.
 * An address the browser names is never the uid: a mismatch is a refusal.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RATE_COLLECTION = "privySessionRateLimits";
const RATE_WINDOW_MS = 60_000;
const RATE_PER_SOURCE = 30;

export class PrivySessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PrivySessionError";
    this.code = code;
  }
}

function accountsOf(user) {
  return Array.isArray(user?.linked_accounts) ? user.linked_accounts : [];
}

function isEmbeddedEthereum(account) {
  return account?.type === "wallet"
    && account.chain_type === "ethereum"
    && account.connector_type === "embedded"
    && (account.wallet_client_type === "privy" || account.wallet_client_type === "privy-v2")
    && ADDRESS.test(account.address ?? "");
}

/**
 * The embedded wallet Privy created for this email. External wallets are
 * ignored. Several different embedded addresses is a refusal, not a guess.
 */
export function embeddedWalletAddress(user) {
  const accounts = accountsOf(user);
  const hasEmail = accounts.some((account) => account?.type === "email"
    && typeof account.address === "string"
    && account.address.includes("@"));
  if (!hasEmail) {
    throw new PrivySessionError("failed-precondition", "Sign in with the email address for this account.");
  }
  const wallets = accounts.filter(isEmbeddedEthereum);
  const created = wallets.filter((account) => account.imported !== true);
  const addresses = [...new Set((created.length ? created : wallets).map((account) => account.address.toLowerCase()))];
  if (addresses.length !== 1) {
    throw new PrivySessionError(
      "failed-precondition",
      addresses.length === 0
        ? "Your QC DAO wallet is not ready yet. Sign in again in a moment."
        : "This account has more than one QC DAO wallet. Sign-in cannot choose between them.",
    );
  }
  return addresses[0];
}

/** A browser-supplied address is not identity. It may only agree with Privy's. */
export function assertNamedAddress(named, resolved) {
  if (named == null || named === "") return;
  if (typeof named !== "string" || !ADDRESS.test(named) || named.toLowerCase() !== resolved) {
    throw new PrivySessionError("permission-denied", "That sign-in does not match this account.");
  }
}

let cachedClient = null;

function privyClient() {
  const appId = process.env.PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new PrivySessionError("failed-precondition", "Sign-in is not configured.");
  }
  if (!cachedClient) cachedClient = new PrivyClient({ appId, appSecret });
  return cachedClient;
}

function userIdOf(claims) {
  const userId = claims?.user_id ?? claims?.userId;
  return typeof userId === "string" && userId.startsWith("did:privy:") ? userId : null;
}

async function userFromAccessToken(accessToken) {
  if (typeof accessToken !== "string" || accessToken.length > 8_192 || accessToken.split(".").length !== 3) {
    throw new PrivySessionError("unauthenticated", "Sign in again to continue.");
  }
  let claims;
  try {
    claims = await privyClient().utils().auth().verifyAccessToken(accessToken);
  } catch {
    throw new PrivySessionError("unauthenticated", "Sign in again to continue.");
  }
  const userId = userIdOf(claims);
  if (!userId) throw new PrivySessionError("unauthenticated", "Sign in again to continue.");
  try {
    return await privyClient().users()._get(userId);
  } catch {
    throw new PrivySessionError("unavailable", "Sign-in could not be confirmed. Try again in a moment.");
  }
}

/**
 * Emulator tests supply a Privy user fixture. Production never reads this
 * header: Cloud Functions does not set FUNCTIONS_EMULATOR.
 */
function emulatorUser(request) {
  if (process.env.FUNCTIONS_EMULATOR !== "true") return null;
  const raw = request.rawRequest?.headers?.["x-emulator-privy-user"];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new PrivySessionError("invalid-argument", "The sign-in fixture is not valid.");
  }
}

async function chargeAttempt(db, Timestamp, source) {
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const ref = db.collection(RATE_COLLECTION).doc(sourceHash);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const started = snap.data()?.windowStartedAt?.toMillis?.() ?? 0;
    const fresh = started <= 0 || now - started >= RATE_WINDOW_MS;
    const count = fresh ? 0 : Number(snap.data()?.count ?? 0);
    if (count >= RATE_PER_SOURCE) {
      throw new PrivySessionError("resource-exhausted", "Too many sign-in attempts. Wait a minute, then try again.");
    }
    tx.set(ref, {
      count: count + 1,
      windowStartedAt: Timestamp.fromMillis(fresh ? now : started),
      expiresAt: Timestamp.fromMillis(now + RATE_WINDOW_MS * 2),
    });
  });
}

/**
 * Verifies the Privy session and mints a Firebase custom token whose uid is
 * the embedded wallet address. `deps.getAuth` is firebase-admin auth.
 */
export async function exchangePrivySession(request, { db, getAuth, Timestamp }) {
  const source = (process.env.FUNCTIONS_EMULATOR === "true" && request.rawRequest?.headers?.["x-emulator-test-source"])
    || request.rawRequest?.ip
    || request.rawRequest?.socket?.remoteAddress
    || "unknown";
  await chargeAttempt(db, Timestamp, String(source));

  const user = emulatorUser(request) ?? await userFromAccessToken(request.data?.accessToken);
  const address = embeddedWalletAddress(user);
  assertNamedAddress(request.data?.address, address);

  const profile = await db.collection("users").doc(address).get();
  if (profile.exists && profile.data()?.suspended) {
    throw new PrivySessionError("permission-denied", "This account has been suspended by an administrator.");
  }

  const token = await getAuth().createCustomToken(address, {
    wallet: address,
    chainId: arbitrumSepolia.id,
  });
  return { token, address };
}
