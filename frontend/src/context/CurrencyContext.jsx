import { createContext, useContext } from "react";
import { DEFAULT_LOCAL_CURRENCY } from "../lib/fxRates.js";

const defaults = { localCurrency: DEFAULT_LOCAL_CURRENCY, showLocalCurrency: false, rates: null, status: "idle", setPreference: () => {} };
export const CurrencyContext = createContext(defaults);
export const useCurrency = () => useContext(CurrencyContext);
