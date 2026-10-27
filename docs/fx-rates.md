# Local currency estimates (QCDAO-118)

`getFxRates` is a public, read-only callable in `asia-southeast1`. It accepts only
`{ localCurrency }` from the supported currency list in `firebase/functions/fxRates.js`.
Its response contains `source`, `localCurrency`, retrieval time `fetchedAt`, cache
expiry `expiresAt`, and `rates.USD` / `rates.SGD` (local currency per one base unit).

Google Finance public currency quote pages provide the FX data. The relay retrieves
USD/local and USD/SGD in parallel and derives SGD/local by division. The server
avoids browser CORS issues. Each instance caches successful quotes for 15 minutes,
coalesces concurrent requests, and pauses failed pair retries for 30 seconds.
Requests have a 10-second timeout, a 4 MiB response limit, a fixed Google host,
no redirects, and no user-supplied URL. The callable has a three-instance ceiling.

Google does not provide a documented public Finance quote REST API. This adapter
depends on public HTML markup. The canonical pair and unique primary displayed
quote must match; consent pages, unsupported pages, changed markup, malformed
quotes, and oversized responses fail closed. The adapter was checked against the
USD/SGD page on 27 October 2026. A standard browser User-Agent is required by the
current page. Monitor the adapter if Google changes its page. No stale or invented
rates are returned; the UI must fall back to original token amounts.

These are approximate display values, not settlement prices. USDT/USDC estimates
assume one token equals one USD, and XSGD assumes one token equals one SGD; depegs
and redemption fees are not represented. `fetchedAt` is the retrieval time, not the
market quote timestamp. Google quotes may be delayed. Funding inputs, stored
amounts, token base units, approvals, transfers, and contracts stay in tokens.

Provider references:
- [Google Finance USD/SGD](https://www.google.com/finance/quote/USD-SGD?hl=en)
- [Google Finance disclaimer](https://www.google.com/intl/en-US_US/googlefinance/disclaimer/)

Deploy the new callable with the normal Firebase Functions deployment before
expecting converted values in a hosted frontend. No API key or Chainlink contract
is needed. Run the isolated backend checks with
`node --test firebase/functions/test/fx-rates.test.mjs`.

## User controls and frontend cache

The header's compact display-currency picker switches between original token
amounts and estimates in 18 local currencies. Save a default under Profile → Edit profile → Local
currency and Show local currency estimates. Those fields stay in the private user
profile and apply on the next sign-in. Saving a profile preference updates every
shared currency display immediately; a different account restores its own choice.
Existing profiles default to SGD with estimates off.

Local estimates appear above the original token amounts, with an indicative
testnet label. Hover for the Google retrieval time and the token's assumed fiat
peg. Transaction inputs, validation, payment action labels and immutable receipt
payloads continue to show exact token units. No estimated fiat value is submitted
for a payment or included in a signed payload.

The frontend coalesces lookups and caches rates in memory and sessionStorage until
expiry (at most 15 minutes). Storage restrictions still permit an in-memory cache.
Expired quotes disappear while a refresh runs; missing or failed quotes retain
only the token display. Deploy the updated Firestore rules with the frontend so
profile preference writes are accepted, as well as the new `getFxRates` function.
