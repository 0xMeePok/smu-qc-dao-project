import { useCurrency } from "../context/CurrencyContext.jsx";
import { LOCAL_CURRENCIES } from "../lib/fxRates.js";
import { TokenSelect } from "./TokenSelect.jsx";

const currencyNames = new Intl.DisplayNames(["en"], { type: "currency" });
const options = [
  { value: "tokens", label: "Tokens", description: "Original token amounts" },
  ...LOCAL_CURRENCIES.map(code => ({ value: code, label: code, description: currencyNames.of(code) })),
];

export function CurrencyToggle() {
  const { localCurrency, showLocalCurrency, status, setPreference } = useCurrency();
  return <div className="currency-toggle">
    <svg className="currency-toggle-globe" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" />
    </svg>
    <TokenSelect aria-label="Display currency" value={showLocalCurrency ? localCurrency : "tokens"} options={options}
      onChange={event => setPreference(event.target.value === "tokens"
        ? { showLocalCurrency: false }
        : { localCurrency: event.target.value, showLocalCurrency: true })} />
    {showLocalCurrency && status === "unavailable" && <small className="currency-toggle-status" role="status">FX unavailable · showing tokens</small>}
    {showLocalCurrency && status === "loading" && <span className="sr-only" role="status">Loading exchange rates</span>}
  </div>;
}
