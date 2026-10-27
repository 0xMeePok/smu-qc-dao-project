import { formatUnits } from 'viem';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { localCurrencyEstimate, parseTokenDisplay } from '../lib/fxRates.js';
import { formatFundingAmount, fundingAmount, fundingToken, fundingUnits } from '../lib/fundingDisplay.js';

export function CurrencyAmount({ amount, currency, tokenText }) {
  const { localCurrency, showLocalCurrency, rates } = useCurrency();
  const original = tokenText ?? formatFundingAmount(currency, amount ?? '—');
  const converted = showLocalCurrency ? localCurrencyEstimate(amount, currency, rates, localCurrency) : null;
  if (!converted) return <>{original}</>;
  const base = currency === 'XSGD' ? 'SGD' : 'USD';
  return <span className="currency-amount" title={`Indicative testnet estimate · Google Finance, fetched ${new Date(rates.fetchedAt).toLocaleString()}. Assumes 1 ${currency} = 1 ${base}; not a redeemable balance.`}>
    <span className="currency-amount-local">≈ {converted}</span>
    <small className="currency-amount-token"><span className="currency-amount-token-value">{original}</span><span className="currency-amount-note">indicative testnet estimate</span></small>
  </span>;
}

export function ConvertedAmount({ text }) {
  const parsed = parseTokenDisplay(text);
  return parsed ? <CurrencyAmount {...parsed} tokenText={text} /> : <>{text}</>;
}

export function TokenAmount({ value, summary, decimals, currency, tokenText }) {
  const token = summary ? fundingToken(summary) : { decimals, symbol: currency };
  const units = fundingUnits(value);
  const original = tokenText ?? fundingAmount(value, { tokenDecimals: token.decimals, tokenSymbol: token.symbol });
  if (units === null || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 77) return <>{original}</>;
  return <CurrencyAmount amount={formatUnits(units, token.decimals)} currency={token.symbol} tokenText={original} />;
}
