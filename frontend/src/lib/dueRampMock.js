/** In-browser stand-in for Due. No account is created and no request leaves the page. */
const RATES = { USD: 1, EUR: 0.92, SGD: 1.35 };
const RAILS = { USD: "ach", EUR: "sepa", SGD: "fast" };
const quotes = new Map();
const transfers = new Map();

export function resetDueRampMock() {
  quotes.clear();
  transfers.clear();
}

function money(value) {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function parseAmount(amount) {
  const raw = String(amount ?? "").trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(raw)) {
    throw new Error("Enter an amount from 0.01 to 100000, with at most 2 decimal places.");
  }
  const [whole, fraction = ""] = raw.split(".");
  if (whole.length > 1 && whole.startsWith("0")) {
    throw new Error("Enter an amount from 0.01 to 100000, with at most 2 decimal places.");
  }
  const scaled = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (scaled < 1 || scaled > 10_000_000) {
    throw new Error("Enter an amount from 0.01 to 100000, with at most 2 decimal places.");
  }
  return scaled / 100;
}

function accountFor(address) {
  const suffix = String(address || "preview").replace(/^0x/i, "").slice(0, 8).toLowerCase() || "preview";
  return { accountId: `acct_mock_${suffix}`, walletId: `wlt_mock_${suffix}`, address: address || "" };
}

function quoteFor({ direction, currency, amount }) {
  const value = parseAmount(amount);
  const rate = RATES[currency];
  if (!rate || (direction !== "onramp" && direction !== "offramp")) {
    throw new Error("Choose buy USDC or sell USDC, and USD, EUR, or SGD.");
  }
  const fee = Math.max(0.5, Math.round(value * 0.5) / 100);
  if (fee >= value) throw new Error("Enter a larger amount. The simulated fee would use the whole payment.");
  const net = value - fee;
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  if (direction === "onramp") {
    return {
      token: `mock.${direction}.${currency}.${money(value)}`,
      source: { rail: RAILS[currency], currency, amount: money(value), fee: money(fee) },
      destination: { rail: "arbitrum-sepolia", currency: "USDC", amount: money(net / rate), fee: "0.00" },
      fxRate: money(rate),
      expiresAt,
    };
  }
  return {
    token: `mock.${direction}.${currency}.${money(value)}`,
    source: { rail: "arbitrum-sepolia", currency: "USDC", amount: money(value), fee: money(fee) },
    destination: { rail: RAILS[currency], currency, amount: money(net * rate), fee: "0.00" },
    fxRate: money(rate),
    expiresAt,
  };
}

export async function runDueRampMock(data, address = "") {
  const account = accountFor(address);
  if (data.action === "quote") {
    const quote = quoteFor(data);
    quotes.set(quote.token, { direction: data.direction, currency: data.currency, amount: data.amount });
    return { ...account, quote };
  }
  if (data.action === "create") {
    const saved = quotes.get(data.quoteToken);
    if (!saved) throw new Error("Review a new quote before creating the transfer.");
    const quote = quoteFor(saved);
    const id = `tf_${transfers.size + 1}`;
    const transfer = data.direction === "offramp"
      ? {
        id, status: "awaiting_funds", fundingAddress: `mock-funding-${id}`,
        source: quote.source, destination: quote.destination,
      }
      : {
        id, status: "awaiting_funds", memo: `SIM-${id}`,
        source: quote.source, destination: quote.destination,
        details: { bankName: "QC DAO testnet bank", accountName: "QC DAO testnet beneficiary", accountNumber: "0000000000", routingNumber: "000000000" },
      };
    transfers.set(id, transfer);
    return { ...account, transfer };
  }
  const transfer = transfers.get(data.transferId);
  if (!transfer) throw new Error("That transfer could not be found.");
  if (data.action === "payin" || data.action === "status") {
    const next = data.action === "payin" ? { ...transfer, status: "payment_processed" } : transfer;
    transfers.set(transfer.id, next);
    return { transfer: next };
  }
  throw new Error("Choose a Due sandbox action.");
}
