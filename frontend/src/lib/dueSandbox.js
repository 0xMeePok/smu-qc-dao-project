/**
 * Local Due on/off-ramp simulator for QCDAO-151.
 *
 * SWAP POINT
 * Component: frontend/src/components/DueOnOffRamp.jsx
 * Props: address, email, className
 * Replace these four functions at mainnet migration:
 *   startDueSandbox, quoteDueSandbox, createDueSandboxTransfer, simulateDueSandboxFunding
 * Keep the same props and the same screen order (details, review, confirmation,
 * funding instructions, result). Move the calls into a Cloud Function. Store the
 * Due API key in Secret Manager as DUE_API_KEY. Never put that key in a VITE_
 * variable, and never call Due from the browser.
 *
 * Due's sandbox API is https://api.sandbox.due.network. Production is
 * https://api.due.network. This module does not call either one. Its credential
 * is a public simulator id, not a Due API key, and it is not read from the
 * environment. The screen cannot initiate a card payment, a bank transfer, a
 * wallet signature, or a token transfer.
 */

export const LOCAL_DUE_SANDBOX_KEY = "local-due-sandbox-qcdao-151";
export const DUE_SANDBOX_CHAIN_ID = 421614;
export const DUE_SANDBOX_RAIL = "arbitrum-sepolia";
const QUOTE_TTL_MS = 120_000;
const FIAT = 100n;
const USDC = 1_000_000n;
const FEE_BPS = 50n;
const MIN_FIAT_FEE = 50n;
const MIN_USDC_FEE = 500_000n;
const AMOUNT_MESSAGE = "Enter an amount from 0.01 to 100000, with at most 2 decimal places.";
const FEE_MESSAGE = "Enter a larger amount. The sandbox fee would use the whole payment.";

export const DUE_RAMP_SWAP_POINT = Object.freeze({
  story: "QCDAO-151",
  component: "frontend/src/components/DueOnOffRamp.jsx",
  logic: "frontend/src/lib/dueSandbox.js",
  props: Object.freeze(["address", "email", "className"]),
  functions: Object.freeze([
    "startDueSandbox",
    "quoteDueSandbox",
    "createDueSandboxTransfer",
    "simulateDueSandboxFunding",
  ]),
  sandboxApi: "https://api.sandbox.due.network",
  productionApi: "https://api.due.network",
});

const METHODS = Object.freeze([
  Object.freeze({ id: "ach", currency: "USD", currencyLabel: "US dollar (USD)", label: "US bank transfer (ACH)", rail: "ach", fiatPerUsdcCents: 100n }),
  Object.freeze({ id: "fast", currency: "SGD", currencyLabel: "Singapore dollar (SGD)", label: "Singapore bank transfer (FAST)", rail: "fast", fiatPerUsdcCents: 135n }),
  Object.freeze({ id: "sepa", currency: "EUR", currencyLabel: "Euro (EUR)", label: "Euro bank transfer (SEPA)", rail: "sepa", fiatPerUsdcCents: 92n }),
]);

/** Labels for the screen. Rates stay inside this module. */
export function dueSandboxMethods() {
  return METHODS.map(({ id, currency, currencyLabel, label, rail }) => ({ id, currency, currencyLabel, label, rail }));
}

export class DueSandboxError extends Error {
  constructor(message) {
    super(message);
    this.name = "DueSandboxError";
  }
}

function formatScaled(value, scale, decimals) {
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0");
  return `${whole.toString()}.${fraction}`;
}

function formatFiat(cents) {
  return formatScaled(cents, FIAT, 2);
}

function formatUsdc(micros) {
  return formatScaled(micros, USDC, 6);
}

function parseAmount(amount) {
  const raw = String(amount ?? "").trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(raw)) throw new DueSandboxError(AMOUNT_MESSAGE);
  const [whole, fraction = ""] = raw.split(".");
  if (whole.length > 1 && whole.startsWith("0")) throw new DueSandboxError(AMOUNT_MESSAGE);
  const scaled = BigInt(whole) * FIAT + BigInt((fraction + "00").slice(0, 2));
  if (scaled < 1n || scaled > 10_000_000n) throw new DueSandboxError(AMOUNT_MESSAGE);
  return scaled;
}

function feeOf(amount, minimum) {
  const proportional = amount * FEE_BPS / 10_000n;
  return proportional > minimum ? proportional : minimum;
}

function assertSession(session) {
  if (!session || session.mode !== "local-simulation" || session.credential !== LOCAL_DUE_SANDBOX_KEY || session.apiBase !== "local://due-sandbox") {
    throw new DueSandboxError("This screen only runs the local Due sandbox simulator.");
  }
}

function methodById(methodId) {
  const method = METHODS.find((item) => item.id === methodId);
  if (!method) throw new DueSandboxError("Choose a payment method.");
  return method;
}

function expired(iso, now) {
  return now >= Date.parse(iso);
}

function bankInstructions(method, transferId) {
  const memo = `SIM-${transferId}`;
  const shared = { bankName: "QC DAO sandbox bank", accountName: "QC DAO sandbox beneficiary" };
  if (method.id === "ach") {
    return { kind: "details", memo, details: { schema: "bank_us", ...shared, accountNumber: "0000000000", routingNumber: "000000000" } };
  }
  if (method.id === "sepa") {
    return { kind: "details", memo, details: { schema: "bank_sepa", ...shared, iban: "SIMU00000000000000000000" } };
  }
  return { kind: "details", memo, details: { schema: "bank_sg", ...shared, accountNumber: "0000000000", bankCode: "0000" } };
}

/**
 * Opens a local sandbox account, marks KYC approved, and links the embedded wallet.
 * The returned session is the only state. Nothing is stored or sent.
 */
export function startDueSandbox({ address, email, apiKey, now = Date.now() }) {
  if (apiKey !== LOCAL_DUE_SANDBOX_KEY) throw new DueSandboxError("The local simulator rejected this credential.");
  if (typeof address !== "string" || !/^0x[\da-f]{40}$/i.test(address)) {
    throw new DueSandboxError("Enter the embedded wallet address before starting the simulation.");
  }
  const cleanEmail = typeof email === "string" && email.trim() ? email.trim().slice(0, 200) : null;
  const suffix = address.slice(2).toLowerCase();
  return {
    mode: "local-simulation",
    apiBase: "local://due-sandbox",
    credential: LOCAL_DUE_SANDBOX_KEY,
    chainId: DUE_SANDBOX_CHAIN_ID,
    rail: DUE_SANDBOX_RAIL,
    accountId: `acct_local_${suffix.slice(0, 8)}`,
    walletId: `wlt_local_${suffix.slice(0, 8)}`,
    kyc: { status: "approved", source: "local-stub" },
    address,
    email: cleanEmail,
    createdAt: new Date(now).toISOString(),
    quotes: {},
    transfers: {},
  };
}

/** Builds a two-minute quote. `amount` is fiat for an on-ramp and USDC for an off-ramp. */
export function quoteDueSandbox({ session, direction, asset = "USDC", methodId, amount, now = Date.now() }) {
  assertSession(session);
  if (direction !== "onramp" && direction !== "offramp") throw new DueSandboxError("Choose on-ramp or off-ramp.");
  if (asset !== "USDC") throw new DueSandboxError("This simulation only uses USDC. USDT and XSGD purchases are not available.");
  const method = methodById(methodId);
  const scaled = parseAmount(amount);
  const id = `quo_${Object.keys(session.quotes).length + 1}`;
  let source;
  let destination;
  if (direction === "onramp") {
    const fee = feeOf(scaled, MIN_FIAT_FEE);
    if (fee >= scaled) throw new DueSandboxError(FEE_MESSAGE);
    const usdc = (scaled - fee) * USDC / method.fiatPerUsdcCents;
    if (usdc <= 0n) throw new DueSandboxError(FEE_MESSAGE);
    source = { rail: method.rail, currency: method.currency, amount: formatFiat(scaled), fee: formatFiat(fee) };
    destination = {
      rail: DUE_SANDBOX_RAIL,
      currency: "USDC",
      amount: formatUsdc(usdc),
      fee: "0.000000",
      details: { schema: "evm", address: session.address },
    };
  } else {
    const usdc = scaled * (USDC / FIAT);
    const fee = feeOf(usdc, MIN_USDC_FEE);
    if (fee >= usdc) throw new DueSandboxError(FEE_MESSAGE);
    const fiat = (usdc - fee) * method.fiatPerUsdcCents / USDC;
    if (fiat <= 0n) throw new DueSandboxError(FEE_MESSAGE);
    source = { rail: DUE_SANDBOX_RAIL, currency: "USDC", amount: formatUsdc(usdc), fee: formatUsdc(fee) };
    destination = { rail: method.rail, currency: method.currency, amount: formatFiat(fiat), fee: "0.00" };
  }
  const quote = {
    id,
    token: `local.${id}`,
    direction,
    methodId: method.id,
    asset: "USDC",
    source,
    destination,
    fxRate: formatFiat(method.fiatPerUsdcCents),
    fxMarkupBps: 50,
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
    used: false,
  };
  return { session: { ...session, quotes: { ...session.quotes, [id]: quote } }, quote };
}

/** Records a local transfer from an unused, unexpired quote. */
export function createDueSandboxTransfer({ session, quoteId, now = Date.now() }) {
  assertSession(session);
  const quote = session.quotes?.[quoteId];
  if (!quote) throw new DueSandboxError("Review a quote before continuing.");
  if (quote.used) throw new DueSandboxError("This quote was already used. Review a new quote.");
  if (expired(quote.expiresAt, now)) throw new DueSandboxError("This quote has expired. Review a new quote.");
  const method = methodById(quote.methodId);
  const id = `tf_${Object.keys(session.transfers).length + 1}`;
  const transfer = {
    id,
    status: "awaiting_funds",
    statusLog: ["awaiting_funds"],
    direction: quote.direction,
    source: quote.source,
    destination: quote.destination,
    fxRate: quote.fxRate,
    expiresAt: quote.expiresAt,
    transferInstructions: quote.direction === "offramp"
      ? {
        kind: "funding_reference",
        details: {
          schema: "simulated",
          reference: `sandbox-funding:${id}`,
          network: DUE_SANDBOX_RAIL,
          token: "USDC",
          amount: quote.source.amount,
        },
      }
      : bankInstructions(method, id),
    simulated: true,
  };
  return {
    session: {
      ...session,
      quotes: { ...session.quotes, [quote.id]: { ...quote, used: true } },
      transfers: { ...session.transfers, [id]: transfer },
    },
    transfer,
  };
}

/**
 * Advances a local transfer the way Due's sandbox would after a simulated fiat
 * pay-in or a matched crypto deposit. No funds move.
 */
export function simulateDueSandboxFunding({ session, transferId, now = Date.now() }) {
  assertSession(session);
  const transfer = session.transfers?.[transferId];
  if (!transfer) throw new DueSandboxError("Start a transfer before simulating funds.");
  if (transfer.status === "payment_processed") return { session, transfer };
  if (transfer.status !== "awaiting_funds") throw new DueSandboxError("This transfer can no longer accept funds.");
  const next = expired(transfer.expiresAt, now)
    ? { ...transfer, status: "expired", statusLog: [...transfer.statusLog, "expired"] }
    : { ...transfer, status: "payment_processed", statusLog: ["awaiting_funds", "approved", "payment_submitted", "payment_processed"] };
  return {
    session: { ...session, transfers: { ...session.transfers, [transfer.id]: next } },
    transfer: next,
  };
}
