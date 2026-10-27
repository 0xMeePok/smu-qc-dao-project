import { HttpsError, onCall } from "firebase-functions/v2/https";

export const FX_CURRENCIES = Object.freeze(["USD", "SGD", "EUR", "GBP", "AUD", "CAD", "CHF", "CNY", "HKD", "JPY", "MYR", "INR", "IDR", "THB", "PHP", "KRW", "TWD", "NZD"]);
const CACHE_MS = 15 * 60_000;
const RETRY_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function boundedHtml(response) {
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("text/html") || !response.body) {
    throw new Error("Google Finance quote unavailable");
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body.cancel();
    throw new Error("Google Finance response too large");
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
        throw new Error("Google Finance response too large");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}

/** Strictly bind the displayed primary quote to the requested canonical pair.
 * Google Finance has no documented public quote API. Fail closed if its HTML changes. */
export function parseGoogleFxQuote(html, from, to) {
  if (!FX_CURRENCIES.includes(from) || !FX_CURRENCIES.includes(to)) throw new Error("Unsupported FX pair");
  const canonical = `https://www.google.com/finance/quote/${from}-${to}`;
  const canonicalTags = html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*>/gi) ?? [];
  if (!canonicalTags.some(tag => tag.match(/\bhref=["']([^"']+)["']/i)?.[1] === canonical)) {
    throw new Error("Unexpected Google Finance quote");
  }
  // Current (October 2026) primary quote; do not match Pdsbrc alone because
  // related assets and chart tables also contain prices with that jsname.
  const prices = [...html.matchAll(/<div\b[^>]*\bclass=["']N6SYTe["'][^>]*>\s*<span\b[^>]*\bjsname=["']Pdsbrc["'][^>]*>\s*<span>\s*([\d,]+(?:\.\d+)?)\s*<\/span>\s*<\/span>\s*<\/div>/g)];
  if (prices.length !== 1) throw new Error("Missing or ambiguous Google Finance quote");
  const raw = prices[0][1];
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) throw new Error("Malformed Google Finance quote");
  const rate = Number(raw.replaceAll(",", ""));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Invalid Google Finance quote");
  return rate;
}

export function createFxRateService({ fetchImpl = fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
  // Keys come only from the fixed supported list. Coalescing and a short failure
  // cooldown bound Google requests even when many members open the same page.
  const pairs = new Map();
  async function quote(to) {
    if (to === "USD") return { rate: 1, fetchedAt: now() };
    const previous = pairs.get(to);
    if (previous?.pending) return previous.pending;
    if (previous?.quote && now() < previous.quote.fetchedAt + CACHE_MS) return previous.quote;
    if (previous?.retryAt && now() < previous.retryAt) throw new Error("FX provider temporarily unavailable");
    const pending = Promise.resolve().then(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const response = await fetchImpl(`https://www.google.com/finance/quote/USD-${to}?hl=en&gl=US`, {
          redirect: "error", signal: controller.signal,
          headers: { accept: "text/html", "user-agent": "Mozilla/5.0" },
        });
        const rate = parseGoogleFxQuote(await boundedHtml(response), "USD", to);
        const result = { rate, fetchedAt: now() };
        pairs.set(to, { quote: result });
        return result;
      } catch (error) {
        pairs.set(to, { retryAt: now() + RETRY_MS });
        throw error;
      } finally { clearTimeout(timer); controller.abort(); }
    });
    pairs.set(to, { pending });
    return pending;
  }
  return async function getFxRates(request) {
    const data = request.data;
    if (!data || typeof data !== "object" || Array.isArray(data)
      || Object.keys(data).some(key => key !== "localCurrency") || !FX_CURRENCIES.includes(data.localCurrency)) {
      throw new HttpsError("invalid-argument", "Choose a supported display currency.");
    }
    try {
      const [local, singapore] = await Promise.all([quote(data.localCurrency), quote("SGD")]);
      const fetchedAt = Math.min(local.fetchedAt, singapore.fetchedAt);
      const rates = { USD: local.rate, SGD: data.localCurrency === "SGD" ? 1 : local.rate / singapore.rate };
      if (Object.values(rates).some(rate => !Number.isFinite(rate) || rate <= 0)) throw new Error("Invalid FX rates");
      return { source: "Google Finance", localCurrency: data.localCurrency,
        fetchedAt: new Date(fetchedAt).toISOString(), expiresAt: new Date(fetchedAt + CACHE_MS).toISOString(), rates };
    } catch {
      throw new HttpsError("unavailable", "Google FX rates are unavailable. Amounts are shown in their original tokens.");
    }
  };
}

export function registerFxRateFunctions({ region }) {
  const getFxRates = createFxRateService();
  return { getFxRates: onCall({ region, maxInstances: 3, concurrency: 20, timeoutSeconds: 15 }, getFxRates) };
}
