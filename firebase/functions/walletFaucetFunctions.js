import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getAddress, isAddress, recoverMessageAddress } from "viem";
import { isAuthTimeRevoked, SESSION_REVOCATIONS_COLLECTION } from "./adminActions.js";

const FAUCET_URL = "https://smu-qc-dao-project.vercel.app/api/faucet";
const TOKENS = new Set(["XSGD", "USDT", "USDC"]);
const MAX_RESPONSE_BYTES = 8192;
const CLAIM_AMOUNT = "10000";

function mintMessage(token, recipient, issuedAt) {
  return ["TAP Faucet Mint", `Token: ${token}`, `Recipient: ${recipient}`,
    "Chain ID: 421614", `Issued At: ${issuedAt}`].join("\n");
}

async function requireMember(request, db) {
  const uid = request.auth?.uid;
  if (!/^0x[0-9a-f]{40}$/.test(uid ?? "")) {
    throw new HttpsError("unauthenticated", "Sign in with your email to get test tokens.");
  }
  const [profile, cutoff] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection(SESSION_REVOCATIONS_COLLECTION).doc(uid).get(),
  ]);
  if (!profile.exists || profile.data()?.suspended) {
    throw new HttpsError("permission-denied", "Complete your active member profile first.");
  }
  if (isAuthTimeRevoked(request.auth.token?.auth_time ?? 0,
    profile.data()?.sessionsValidAfterEpoch, cutoff.data()?.sessionsValidAfterEpoch)) {
    throw new HttpsError("unauthenticated", "Sign in again to continue.");
  }
  return uid;
}

async function chargeAttempt(db, uid, now) {
  const ref = db.collection("walletFaucetAttempts").doc(uid);
  await db.runTransaction(async transaction => {
    const previous = (await transaction.get(ref)).data() ?? {};
    const fresh = !Number.isFinite(previous.startedAt) || now - previous.startedAt >= 60_000;
    const count = fresh ? 0 : previous.count ?? 0;
    if (count >= 10) throw new HttpsError("resource-exhausted", "Wait one minute before requesting more test tokens.");
    transaction.set(ref, { startedAt: fresh ? now : previous.startedAt, count: count + 1,
      expiresAt: Timestamp.fromMillis(now + 120_000) });
  });
}

async function readResponse(response) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new Error("Invalid faucet response length");
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !response.body) {
    throw new Error("Invalid faucet response type");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Faucet response too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid faucet response");
  return body;
}

/** Server relay for the existing signed TAP faucet protocol; no minting key is held here. */
export async function claimWalletTokens(request, { db, fetchImpl = fetch, now = Date.now, timeoutMs = 55_000 }) {
  const uid = await requireMember(request, db);
  const data = request.data;
  if (!data || typeof data !== "object" || Array.isArray(data)
    || Object.keys(data).some(key => !["token", "issuedAt", "signature"].includes(key))
    || !TOKENS.has(data.token) || !Number.isSafeInteger(data.issuedAt)
    || typeof data.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(data.signature)) {
    throw new HttpsError("invalid-argument", "Choose a supported token and sign a fresh test-token request.");
  }
  const timestamp = now();
  const seconds = Math.floor(timestamp / 1000);
  if (data.issuedAt > seconds + 60 || seconds - data.issuedAt > 300) {
    throw new HttpsError("invalid-argument", "This test-token request expired. Please sign a new request.");
  }
  const recipient = getAddress(uid);
  try {
    const signer = await recoverMessageAddress({
      message: mintMessage(data.token, recipient, data.issuedAt), signature: data.signature,
    });
    if (signer.toLowerCase() !== uid) throw new Error("Different signer");
  } catch {
    throw new HttpsError("permission-denied", "The signature must come from your signed-in wallet.");
  }
  await chargeAttempt(db, uid, timestamp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(FAUCET_URL, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token: data.token, recipient, issuedAt: data.issuedAt, signature: data.signature }),
    });
    const body = await readResponse(response);
    if (response.status === 429) {
      const message = typeof body.error === "string" && body.error.trim().length > 0 && body.error.length <= 500
        ? body.error : "This wallet must wait before claiming this token again.";
      throw new HttpsError("resource-exhausted", message);
    }
    if (!response.ok) throw new HttpsError("unavailable", "The test-token faucet is temporarily unavailable. Try again shortly.");
    if (body.token !== data.token || body.amount !== CLAIM_AMOUNT || body.decimals !== 6
      || typeof body.recipient !== "string" || !isAddress(body.recipient, { strict: false })
      || getAddress(body.recipient) !== recipient
      || typeof body.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
      throw new Error("Invalid mint confirmation");
    }
    return { token: data.token, recipient, amount: CLAIM_AMOUNT, decimals: 6, txHash: body.txHash };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (controller.signal.aborted) {
      throw new HttpsError("deadline-exceeded", "The faucet confirmation took too long. Check your wallet balance before retrying.");
    }
    throw new HttpsError("unavailable", "The test-token faucet could not confirm this request. Check your wallet balance before retrying.");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function registerWalletFaucetFunctions({ db, region }) {
  return { claimWalletTokens: onCall({ region, maxInstances: 3, timeoutSeconds: 75,
    enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== "true" }, request => claimWalletTokens(request, { db })) };
}
