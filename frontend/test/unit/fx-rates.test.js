import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFxRates, localCurrencyEstimate, parseTokenDisplay, validFxRates } from '../../src/lib/fxRates.js';
const now = Date.now();
const rates = { source: 'Google Finance', localCurrency: 'SGD', fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900000).toISOString(), rates: { USD: 1.3, SGD: 1 } };
test('estimates USD stablecoins and SGD tokens using their own fiat bases', () => {
  assert.equal(localCurrencyEstimate('10', 'USDC', rates, 'SGD', 'en-SG', now), 'SGD 13.00');
  assert.equal(localCurrencyEstimate('10', 'USDT', rates, 'SGD', 'en-SG', now), 'SGD 13.00');
  assert.equal(localCurrencyEstimate('10', 'XSGD', rates, 'SGD', 'en-SG', now), 'SGD 10.00');
  assert.equal(localCurrencyEstimate('900719925474099312.345678', 'XSGD', rates, 'SGD', 'en-SG', now), 'SGD 900,719,925,474,099,312.35');
});
test('stale, invalid, unsupported and missing rates never become an estimate', () => {
  assert.equal(localCurrencyEstimate('1', 'ETH', rates, 'SGD', 'en-SG', now), null);
  assert.equal(localCurrencyEstimate('1', 'USDC', rates, 'SGD', 'en-SG', now + 900000), null);
  assert.equal(localCurrencyEstimate('NaN', 'USDC', rates, 'SGD', 'en-SG', now), null);
  assert.equal(validFxRates({ ...rates, rates: { USD: 1.3, SGD: 0.9 } }, 'SGD', now), false);
  assert.equal(validFxRates({ ...rates, rates: { USD: Infinity, SGD: 1 } }, 'SGD', now), false);
});
test('session lookups deduplicate and reuse rates; failures can be retried', async () => {
  let calls = 0;
  const lookup = async () => { calls++; return rates; };
  const [a,b] = await Promise.all([loadFxRates('SGD', { lookup }), loadFxRates('SGD', { lookup })]);
  assert.equal(a, b); assert.equal(calls, 1);
  await loadFxRates('SGD', { lookup }); assert.equal(calls, 1);
  await assert.rejects(loadFxRates('ZZZ', { lookup }));
  await assert.rejects(loadFxRates('GBP', { lookup: async () => { throw Error('offline'); } }));
  const gbp = { ...rates, localCurrency: 'GBP', rates: { USD: 0.75, SGD: 0.58 } };
  assert.equal(await loadFxRates('GBP', { lookup: async () => gbp }), gbp);
});
test('locale parsing preserves canonical escrow decimals and localized budgets', () => {
  assert.deepEqual(parseTokenDisplay('1.5 USDC', 'de-DE'), { amount: '1.5', currency: 'USDC' });
  assert.deepEqual(parseTokenDisplay('USDC 1.234,50', 'de-DE'), { amount: '1234.50', currency: 'USDC' });
  assert.deepEqual(parseTokenDisplay('USDC 1,234.50', 'en-SG'), { amount: '1234.50', currency: 'USDC' });
  assert.equal(parseTokenDisplay('Enter 1 USDC'), null);
});
