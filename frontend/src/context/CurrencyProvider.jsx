import { useEffect, useMemo, useState } from "react";
import { useSession } from "./SessionContext.jsx";
import { CurrencyContext } from "./CurrencyContext.jsx";
import { DEFAULT_LOCAL_CURRENCY, LOCAL_CURRENCIES, loadFxRates, validFxRates } from "../lib/fxRates.js";

export function CurrencyProvider({ children, lookup = loadFxRates }) {
  const { profile, address } = useSession();
  const currency = LOCAL_CURRENCIES.includes(profile?.localCurrency) ? profile.localCurrency : DEFAULT_LOCAL_CURRENCY;
  // A saved profile change or account change replaces any temporary header choice.
  const key = `${address || 'guest'}:${currency}:${profile?.showLocalCurrency === true}`;
  const [override, setOverride] = useState(null);
  const preference = override?.key === key ? override : { localCurrency: currency, showLocalCurrency: profile?.showLocalCurrency === true };
  const { localCurrency, showLocalCurrency } = preference;
  const [result, setResult] = useState({ rates: null, status: 'idle' });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!showLocalCurrency) { setResult({ rates: null, status: 'idle' }); return; }
    let active = true, timer;
    setResult({ rates: null, status: 'loading' });
    lookup(localCurrency).then(rates => {
      if (!active) return;
      if (!validFxRates(rates, localCurrency)) throw new Error("FX unavailable");
      setResult({ rates, status: 'ready' });
      timer = setTimeout(() => { setResult({ rates: null, status: 'loading' }); setRefresh(n => n + 1); }, Math.max(1, Date.parse(rates.expiresAt) - Date.now()));
    }).catch(() => { if (active) setResult({ rates: null, status: 'unavailable' }); });
    return () => { active = false; clearTimeout(timer); };
  }, [localCurrency, showLocalCurrency, lookup, refresh]);
  const value = useMemo(() => ({ localCurrency, showLocalCurrency,
    rates: validFxRates(result.rates, localCurrency) && showLocalCurrency ? result.rates : null,
    status: result.status, setPreference: patch => setOverride({ key, ...preference, ...patch }),
  }), [key, localCurrency, showLocalCurrency, result]);
  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}
