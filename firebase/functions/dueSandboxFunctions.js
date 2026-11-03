import { HttpsError, onCall } from "firebase-functions/v2/https";
import { isAuthTimeRevoked, SESSION_REVOCATIONS_COLLECTION } from "./adminActions.js";
import { DueSandboxError, assertAmount } from "./dueSandboxClient.js";

const CURRENCIES = new Set(["USD", "EUR", "SGD"]);
const RATES = { USD: 1, EUR: 0.92, SGD: 1.35 };
const RAILS = { USD: "ach", EUR: "sepa", SGD: "fast" };

function reject(error) {
  if (error instanceof DueSandboxError) throw new HttpsError(error.code, error.message);
  if (error instanceof HttpsError) throw error;
  throw new HttpsError("unavailable", "The testnet ramp could not be completed. Try again in a moment.");
}

async function requireMember(request, db) {
  const uid = request.auth?.uid;
  if (!/^0x[0-9a-f]{40}$/.test(uid ?? "")) throw new HttpsError("unauthenticated", "Sign in with your email.");
  const [profile, cutoff] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection(SESSION_REVOCATIONS_COLLECTION).doc(uid).get(),
  ]);
  if (!profile.exists || profile.data()?.suspended) throw new HttpsError("permission-denied", "Complete your active member profile first.");
  if (isAuthTimeRevoked(request.auth.token?.auth_time ?? 0, profile.data()?.sessionsValidAfterEpoch, cutoff.data()?.sessionsValidAfterEpoch)) {
    throw new HttpsError("unauthenticated", "Sign in again to continue.");
  }
  return { uid, profile: profile.data() };
}

function money(value) {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function accountFor(uid) {
  return { accountId: `acct_mock_${uid.slice(2, 10).toLowerCase()}`, walletId: `wlt_mock_${uid.slice(2, 10).toLowerCase()}`, address: uid };
}

function buildQuote({ direction, currency, amount }) {
  const value = Number(assertAmount(amount));
  const rate = RATES[currency];
  const fee = Math.max(0.5, Math.round(value * 0.5) / 100);
  if (fee >= value) throw new DueSandboxError("Enter a larger amount. The simulated fee would use the whole payment.", "invalid-argument");
  const net = value - fee;
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const token = `mock.${direction}.${currency}.${money(value)}`;
  if (direction === "onramp") {
    return {
      token,
      source: { rail: RAILS[currency], currency, amount: money(value), fee: money(fee) },
      destination: { rail: "arbitrum-sepolia", currency: "USDC", amount: money(net / rate), fee: "0.00" },
      fxRate: money(rate),
      expiresAt,
    };
  }
  return {
    token,
    source: { rail: "arbitrum-sepolia", currency: "USDC", amount: money(value), fee: money(fee) },
    destination: { rail: RAILS[currency], currency, amount: money(net * rate), fee: "0.00" },
    fxRate: money(rate),
    expiresAt,
  };
}

/**
 * QCDAO-151 mock. The dialog stays the same, but no Due account is created and
 * no request is sent to Due. Swap this function for dueSandboxRequest calls
 * when a sandbox platform key exists.
 */
export async function handleDueSandbox(request, { db }) {
  try {
    const { uid } = await requireMember(request, db);
    const data = request.data || {};
    const account = accountFor(uid);
    const ref = db.collection("dueSandboxLinks").doc(uid);
    const saved = (await ref.get()).data() || {};
    if (data.action === "quote") {
      const direction = data.direction === "offramp" ? "offramp" : data.direction === "onramp" ? "onramp" : "";
      if (!direction) throw new DueSandboxError("Choose buy USDC or sell USDC.", "invalid-argument");
      if (!CURRENCIES.has(data.currency)) throw new DueSandboxError("Choose USD, EUR, or SGD.", "invalid-argument");
      const quote = buildQuote({ direction, currency: data.currency, amount: data.amount });
      await ref.set({ ...account, quotes: { ...(saved.quotes || {}), [quote.token]: { direction, currency: data.currency, amount: data.amount } } }, { merge: true });
      return { ...account, quote };
    }
    if (data.action === "create") {
      const direction = data.direction === "offramp" ? "offramp" : "onramp";
      if (!CURRENCIES.has(data.currency)) throw new DueSandboxError("Choose USD, EUR, or SGD.", "invalid-argument");
      const known = saved.quotes?.[data.quoteToken];
      if (!known) throw new DueSandboxError("Review a new quote before creating the transfer.", "invalid-argument");
      const quote = buildQuote(known);
      const count = Object.keys(saved.transfers || {}).length + 1;
      const id = `tf_${count}`;
      const transfer = direction === "offramp"
        ? { id, status: "awaiting_funds", fundingAddress: `mock-funding-${id}`, source: quote.source, destination: quote.destination }
        : {
          id, status: "awaiting_funds", memo: `SIM-${id}`, source: quote.source, destination: quote.destination,
          details: { bankName: "QC DAO testnet bank", accountName: "QC DAO testnet beneficiary", accountNumber: "0000000000", routingNumber: "000000000" },
        };
      await ref.set({ transfers: { ...(saved.transfers || {}), [id]: transfer } }, { merge: true });
      return { ...account, transfer };
    }
    if (data.action === "payin" || data.action === "status") {
      const transfer = saved.transfers?.[data.transferId];
      if (!transfer) throw new DueSandboxError("That transfer could not be found.", "invalid-argument");
      const next = data.action === "payin" ? { ...transfer, status: "payment_processed" } : transfer;
      if (data.action === "payin") await ref.set({ transfers: { ...(saved.transfers || {}), [transfer.id]: next } }, { merge: true });
      return { transfer: next };
    }
    throw new DueSandboxError("Choose a Due sandbox action.", "invalid-argument");
  } catch (error) {
    reject(error);
  }
}

export function registerDueSandboxFunctions({ db, region }) {
  return {
    dueSandbox: onCall({
      region,
      maxInstances: 3,
      timeoutSeconds: 60,
      enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== "true",
    }, (request) => handleDueSandbox(request, { db })),
  };
}
