import { HttpsError, onCall } from "firebase-functions/v2/https";
import { isAuthTimeRevoked, SESSION_REVOCATIONS_COLLECTION } from "./adminActions.js";
import {
  DueSandboxError,
  assertAmount,
  dueSandboxRequest,
  presentQuote,
  presentTransfer,
  sandboxRecipient,
  selectChannels,
} from "./dueSandboxClient.js";

const CURRENCIES = new Set(["USD", "EUR", "SGD"]);

function reject(error) {
  if (error instanceof DueSandboxError) throw new HttpsError(error.code, error.message);
  if (error instanceof HttpsError) throw error;
  throw new HttpsError("unavailable", "Due sandbox could not be reached. Try again in a moment.");
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

async function ensureLink({ db, apiKey, fetchImpl, uid, profile }) {
  const ref = db.collection("dueSandboxLinks").doc(uid);
  const saved = (await ref.get()).data() || {};
  const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
  if (!email) throw new DueSandboxError("This account has no email for Due sandbox.");
  const parts = String(profile.fullName || "QC DAO Member").trim().split(/\s+/).filter(Boolean);
  const firstName = (parts[0] || "QC").slice(0, 40);
  const lastName = (parts.slice(1).join(" ") || "Member").slice(0, 40);
  let accountId = saved.accountId;
  if (!accountId) {
    const created = await dueSandboxRequest({
      apiKey, fetchImpl, method: "POST", path: "/v1/accounts",
      body: { type: "individual", email, details: { firstName, lastName } },
    });
    accountId = created.id || created.accountId;
    if (!accountId) throw new DueSandboxError("Due sandbox did not return an account id.");
  }
  let walletId = saved.walletId && saved.address === uid ? saved.walletId : "";
  if (!walletId) {
    const wallet = await dueSandboxRequest({
      apiKey, fetchImpl, method: "POST", path: "/v1/wallets", accountId,
      body: { address: uid },
    });
    walletId = wallet.id || wallet.walletId;
    if (!walletId) throw new DueSandboxError("Due sandbox did not link this wallet.");
  }
  await dueSandboxRequest({
    apiKey, fetchImpl, method: "POST", path: `/dev/sumsub/applicants/${encodeURIComponent(accountId)}/approve`, accountId,
  }).catch(() => {});
  const link = { accountId, walletId, address: uid, email };
  await ref.set(link, { merge: true });
  return link;
}

async function railsFor(apiKey, fetchImpl, accountId, currency) {
  const channels = await dueSandboxRequest({ apiKey, fetchImpl, path: "/v1/channels", accountId });
  return selectChannels(channels, currency);
}

async function quote({ apiKey, fetchImpl, link, direction, currency, amount }) {
  const rails = await railsFor(apiKey, fetchImpl, link.accountId, currency);
  const source = direction === "onramp"
    ? { rail: rails.fiatRail, currency, amount }
    : { rail: rails.arbitrumRail, currency: "USDC", amount };
  const destination = direction === "onramp"
    ? { rail: rails.arbitrumRail, currency: "USDC" }
    : { rail: rails.fiatRail, currency };
  const quoted = await dueSandboxRequest({
    apiKey, fetchImpl, method: "POST", path: "/v1/transfers/quote", accountId: link.accountId,
    body: { source, destination },
  });
  const view = presentQuote(quoted);
  if (!view.token) throw new DueSandboxError("Due sandbox did not return a quote.");
  return { quote: view, rails };
}

async function createTransfer({ apiKey, fetchImpl, db, uid, link, profile, direction, currency, quoteToken }) {
  const token = typeof quoteToken === "string" ? quoteToken.trim() : "";
  if (token.length < 10 || token.length > 4000 || /[\r\n]/.test(token)) {
    throw new DueSandboxError("Review a new quote before creating the transfer.", "invalid-argument");
  }
  const rails = await railsFor(apiKey, fetchImpl, link.accountId, currency);
  let recipient = direction === "onramp" ? link.walletId : "";
  if (direction === "offramp") {
    const ref = db.collection("dueSandboxLinks").doc(uid);
    const saved = (await ref.get()).data()?.recipients || {};
    recipient = saved[currency] || "";
    if (!recipient) {
      const schema = rails.fiatSchema || (currency === "EUR" ? "bank_sepa" : currency === "USD" ? "bank_us" : "bank_sg");
      const body = sandboxRecipient(schema, profile.fullName);
      if (!body) throw new DueSandboxError(`Due sandbox has no known bank format for ${currency}.`);
      const created = await dueSandboxRequest({
        apiKey, fetchImpl, method: "POST", path: "/v1/recipients", accountId: link.accountId, body,
      });
      recipient = created.id;
      if (!recipient) throw new DueSandboxError("Due sandbox did not create a recipient.");
      await ref.set({ recipients: { [currency]: recipient } }, { merge: true });
    }
  }
  const transfer = await dueSandboxRequest({
    apiKey, fetchImpl, method: "POST", path: "/v1/transfers", accountId: link.accountId,
    body: direction === "onramp"
      ? { quote: token, recipient, memo: "QC DAO sandbox" }
      : { quote: token, sender: link.walletId, recipient, memo: "QC DAO sandbox" },
  });
  let funding = null;
  if (direction === "offramp" && transfer.id) {
    funding = await dueSandboxRequest({
      apiKey, fetchImpl, method: "POST", path: `/v1/transfers/${encodeURIComponent(transfer.id)}/funding_address`, accountId: link.accountId,
    });
  }
  return presentTransfer({ ...transfer, fundingAddress: funding });
}

export async function handleDueSandbox(request, { db, apiKey = process.env.DUE_API_KEY, fetchImpl = fetch }) {
  try {
    const { uid, profile } = await requireMember(request, db);
    const data = request.data || {};
    const action = data.action;
    const link = await ensureLink({ db, apiKey, fetchImpl, uid, profile });
    if (action === "quote") {
      const direction = data.direction === "offramp" ? "offramp" : data.direction === "onramp" ? "onramp" : "";
      if (!direction) throw new DueSandboxError("Choose buy USDC or sell USDC.", "invalid-argument");
      if (!CURRENCIES.has(data.currency)) throw new DueSandboxError("Choose USD, EUR, or SGD.", "invalid-argument");
      const amount = assertAmount(data.amount);
      const quoted = await quote({ apiKey, fetchImpl, link, direction, currency: data.currency, amount });
      return { accountId: link.accountId, walletId: link.walletId, address: uid, quote: quoted.quote };
    }
    if (action === "create") {
      const direction = data.direction === "offramp" ? "offramp" : "onramp";
      if (!CURRENCIES.has(data.currency)) throw new DueSandboxError("Choose USD, EUR, or SGD.", "invalid-argument");
      const transfer = await createTransfer({
        apiKey, fetchImpl, db, uid, link, profile, direction, currency: data.currency, quoteToken: data.quoteToken,
      });
      return { accountId: link.accountId, address: uid, transfer };
    }
    if (action === "payin" || action === "status") {
      const transferId = typeof data.transferId === "string" && /^[A-Za-z0-9_-]{4,80}$/.test(data.transferId) ? data.transferId : "";
      if (!transferId) throw new DueSandboxError("That transfer could not be found.", "invalid-argument");
      if (action === "payin") {
        const current = await dueSandboxRequest({
          apiKey, fetchImpl, path: `/v1/transfers/${encodeURIComponent(transferId)}`, accountId: link.accountId,
        });
        await dueSandboxRequest({
          apiKey, fetchImpl, method: "POST", path: "/dev/payin", accountId: link.accountId,
          body: {
            currency: current.source?.currency,
            rail: current.source?.rail,
            amount: current.source?.amount,
            reference: current.transferInstructions?.memo || transferId,
          },
        });
      }
      const updated = await dueSandboxRequest({
        apiKey, fetchImpl, path: `/v1/transfers/${encodeURIComponent(transferId)}`, accountId: link.accountId,
      });
      return { transfer: presentTransfer(updated) };
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
