/**
 * Due sandbox only. The host is fixed, so a key cannot be aimed at Due production
 * by changing an environment variable. Due treats the key as a sandbox key
 * because it is presented to https://api.sandbox.due.network.
 */
export const DUE_SANDBOX_ORIGIN = "https://api.sandbox.due.network";

export class DueSandboxError extends Error {
  constructor(message, code = "failed-precondition") {
    super(message);
    this.name = "DueSandboxError";
    this.code = code;
  }
}

const PREFERRED_RAIL = { USD: "ach", EUR: "sepa", SGD: "fast" };
const MAX_BODY_BYTES = 256_000;

function text(value, max = 200) {
  const raw = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  return raw.length > max ? "" : raw;
}

function messageFrom(body, fallback) {
  const candidate = text(body?.message, 400) || text(body?.error, 400) || text(body?.error_code, 80);
  return candidate || fallback;
}

export function assertAmount(amount) {
  const raw = String(amount ?? "").trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(raw)) {
    throw new DueSandboxError("Enter an amount from 0.01 to 100000, with at most 2 decimal places.", "invalid-argument");
  }
  const [whole, fraction = ""] = raw.split(".");
  if (whole.length > 1 && whole.startsWith("0")) {
    throw new DueSandboxError("Enter an amount from 0.01 to 100000, with at most 2 decimal places.", "invalid-argument");
  }
  const scaled = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (scaled < 1 || scaled > 10_000_000) {
    throw new DueSandboxError("Enter an amount from 0.01 to 100000, with at most 2 decimal places.", "invalid-argument");
  }
  return raw;
}

export async function dueSandboxRequest({ apiKey, path, method = "GET", accountId, body, fetchImpl = fetch }) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (key.length < 8 || key.length > 500 || /[\r\n]/.test(key)) {
    throw new DueSandboxError("Add the Due sandbox API key as DUE_API_KEY in firebase/functions/.env, then restart the emulators.", "failed-precondition");
  }
  const url = new URL(path, DUE_SANDBOX_ORIGIN);
  if (url.origin !== DUE_SANDBOX_ORIGIN) throw new DueSandboxError("Due is locked to the sandbox host.");
  const headers = { authorization: `Bearer ${key}`, accept: "application/json" };
  if (accountId) headers["due-account-id"] = accountId;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
  });
  const raw = await response.text();
  if (raw.length > MAX_BODY_BYTES) throw new DueSandboxError("Due returned a response that was too large.", "unavailable");
  let parsed = null;
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { parsed = { message: raw.slice(0, 300) }; }
  }
  if (!response.ok) {
    throw new DueSandboxError(messageFrom(parsed, `Due sandbox refused the request (${response.status}).`), response.status === 401 ? "permission-denied" : "failed-precondition");
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

function channelList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.channels)) return body.channels;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

function currencyOf(channel) {
  return text(channel?.currencyCode, 12) || text(channel?.currency_code, 12) || text(channel?.currency, 12);
}

export function selectChannels(body, currency) {
  const channels = channelList(body);
  const crypto = channels.filter((channel) => currencyOf(channel) === "USDC" && /arbitrum/i.test(text(channel?.rail, 40)));
  const arbitrum = crypto.find((channel) => /sepolia/i.test(text(channel?.rail, 40))) || crypto[0];
  const fiatAll = channels.filter((channel) => currencyOf(channel) === currency);
  const preferred = PREFERRED_RAIL[currency];
  const fiat = fiatAll.find((channel) => text(channel?.rail, 40) === preferred) || fiatAll[0];
  if (!arbitrum) throw new DueSandboxError("This Due sandbox key has no Arbitrum USDC channel.");
  if (!fiat) throw new DueSandboxError(`This Due sandbox key has no ${currency} channel.`);
  return {
    arbitrumRail: text(arbitrum.rail, 40),
    fiatRail: text(fiat.rail, 40),
    fiatSchema: text(fiat.railSettings?.schemas?.[0] || fiat.rail_settings?.schemas?.[0], 40),
  };
}

function money(side) {
  return {
    rail: text(side?.rail, 40),
    currency: text(side?.currency, 12),
    amount: text(side?.amount, 40),
    fee: text(side?.fee, 40),
  };
}

export function presentQuote(quote) {
  return {
    source: money(quote?.source),
    destination: money(quote?.destination),
    fxRate: text(quote?.fxRate, 40),
    expiresAt: text(quote?.expiresAt, 40),
    token: text(quote?.token, 4000),
  };
}

const DETAIL_KEYS = ["bankName", "accountName", "accountNumber", "routingNumber", "iban", "IBAN", "bankCode", "address", "network", "token", "amount", "reference", "memo"];

function detailsOf(value) {
  const source = value?.details && typeof value.details === "object" ? value.details : value;
  const details = {};
  if (!source || typeof source !== "object") return details;
  for (const key of DETAIL_KEYS) {
    const item = text(source[key], 200);
    if (item) details[key] = item;
  }
  return details;
}

export function presentTransfer(transfer) {
  const instructions = transfer?.transferInstructions || transfer?.fundingAddress || null;
  return {
    id: text(transfer?.id, 80),
    status: text(transfer?.status, 40),
    source: money(transfer?.source),
    destination: money(transfer?.destination),
    expiresAt: text(transfer?.expiresAt, 40),
    memo: text(instructions?.memo || transfer?.transferInstructions?.memo, 120),
    details: detailsOf(instructions),
    fundingAddress: text(transfer?.fundingAddress?.details?.address || transfer?.fundingAddress?.address || instructions?.details?.address, 120),
  };
}

export function sandboxRecipient(schema, fullName) {
  const parts = String(fullName || "QC DAO Member").trim().split(/\s+/).filter(Boolean);
  const firstName = (parts[0] || "QC").slice(0, 40);
  const lastName = (parts.slice(1).join(" ") || "Member").slice(0, 40);
  const name = `${firstName} ${lastName}`;
  if (schema === "bank_sepa") {
    return { name, details: { schema, accountType: "individual", firstName, lastName, IBAN: "FR1420041010050500013M02606" } };
  }
  if (schema === "bank_us") {
    return { name, details: { schema, accountType: "individual", firstName, lastName, accountNumber: "000123456789", routingNumber: "021000021" } };
  }
  if (schema === "bank_sg") {
    return { name, details: { schema, accountType: "individual", firstName, lastName, accountNumber: "0123456789", bankCode: "7171" } };
  }
  return null;
}
