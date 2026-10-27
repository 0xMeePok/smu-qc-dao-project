// Display-only FX. Token settlement and signed payloads never use these values.
export const LOCAL_CURRENCIES = Object.freeze(['USD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'JPY', 'MYR', 'INR', 'IDR', 'THB', 'PHP', 'KRW', 'TWD', 'NZD']);
export const DEFAULT_LOCAL_CURRENCY = 'SGD';
export const TOKEN_FIAT = Object.freeze({ USDT: 'USD', USDC: 'USD', XSGD: 'SGD' });
const pending = new Map();
const cache = new Map();
const CACHE_PREFIX = 'qcdao-fx-v1:';
export const FX_MAX_AGE_MS = 15 * 60 * 1000;

export function validFxRates(data, currency, now = Date.now()) {
  const fetched = Date.parse(data?.fetchedAt), expires = Date.parse(data?.expiresAt);
  return LOCAL_CURRENCIES.includes(currency) && data?.localCurrency === currency && data?.source === 'Google Finance'
    && Number.isFinite(fetched) && fetched <= now + 5000 && fetched > now - FX_MAX_AGE_MS
    && expires > now && expires <= fetched + FX_MAX_AGE_MS
    && ['USD', 'SGD'].every(base => typeof data.rates?.[base] === 'number' && Number.isFinite(data.rates[base]) && data.rates[base] > 0 && data.rates[base] <= 1e6
      && (base !== currency || data.rates[base] === 1));
}

async function callGoogleFx(localCurrency) {
  const [{ httpsCallable }, { functions }] = await Promise.all([import('firebase/functions'), import('./firebase.js')]);
  if (!functions) throw new Error('FX unavailable');
  return (await httpsCallable(functions, 'getFxRates')({ localCurrency })).data;
}

export function loadFxRates(currency, { lookup = callGoogleFx, now = Date.now } = {}) {
  if (!LOCAL_CURRENCIES.includes(currency)) return Promise.reject(new Error('Unsupported display currency'));
  let saved = cache.get(currency);
  if (!saved) {
    try { saved = JSON.parse(sessionStorage.getItem(CACHE_PREFIX + currency)); } catch { /* Storage is optional. */ }
  }
  if (validFxRates(saved, currency, now())) { cache.set(currency, saved); return Promise.resolve(saved); }
  if (pending.has(currency)) return pending.get(currency);
  const request = Promise.resolve().then(() => lookup(currency)).then(data => {
    if (!validFxRates(data, currency, now())) throw new Error('FX unavailable or expired');
    cache.set(currency, data);
    try { sessionStorage.setItem(CACHE_PREFIX + currency, JSON.stringify(data)); } catch { /* In-memory cache remains. */ }
    return data;
  }).finally(() => pending.delete(currency));
  pending.set(currency, request);
  return request;
}

/** Round only the indicative fiat value; retain the exact original token text. */
export function localCurrencyEstimate(amount, token, data, currency, locale, now = Date.now()) {
  if (!TOKEN_FIAT[token] || !validFxRates(data, currency, now)) return null;
  const text = String(amount ?? '');
  if (text.length > 160 || !/^\d+(?:\.\d{1,77})?$/.test(text)) return null;
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code' });
  const digits = formatter.resolvedOptions().maximumFractionDigits;
  const [whole, fraction = ''] = text.split('.');
  const rate = BigInt(Math.round(data.rates[TOKEN_FIAT[token]] * 1e9));
  if (rate <= 0n) return null;
  const denominator = 10n ** BigInt(fraction.length) * 1000000000n;
  const numerator = BigInt(whole + fraction) * rate * 10n ** BigInt(digits);
  const minor = (numerator + denominator / 2n) / denominator;
  const divisor = 10n ** BigInt(digits);
  // formatToParts(BigInt) keeps large values exact while Intl supplies local separators.
  return formatter.formatToParts(minor / divisor).map(part => part.type === 'fraction'
    ? String(minor % divisor).padStart(digits, '0') : part.value).join('');
}

export function parseTokenDisplay(text, locale) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^(?:(USDT|USDC|XSGD)\s+(.+)|(.+?)\s+(USDT|USDC|XSGD))$/);
  if (!match) return null;
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const group = parts.find(p => p.type === 'group')?.value;
  const decimal = parts.find(p => p.type === 'decimal')?.value;
  let amount = match[2] ?? match[3];
  // formatUnits helpers emit canonical decimals followed by the token.
  // Prefix amounts come from localized UI formatters. Never reinterpret a raw
  // decimal point as a locale's thousands separator (1.5 USDC must stay 1.5).
  if (!(match[4] && /^\d+(?:\.\d+)?$/.test(amount))) {
    if (group) amount = amount.split(group).join('');
    if (decimal && decimal !== '.') amount = amount.replace(decimal, '.');
  }
  return /^\d+(?:\.\d+)?$/.test(amount) ? { currency: match[1] ?? match[4], amount } : null;
}
