# Due on/off-ramp simulation

QCDAO-151 asks a funder to see how adding stablecoins will work from inside QC DAO, without a real payment. Card on-ramps do not run on Arbitrum Sepolia: Stripe fails on testnets even in sandbox mode, and MoonPay's sandbox does not deliver assets on this chain. The screen is a local simulation shaped like [Due's on/off-ramp with Privy](https://docs.privy.io/recipes/due-on-off-ramp).

**Add funds** is on the account menu and on the escrow funding panel. Both open the same dialog.

## What the screen does

The dialog is labelled **Testnet simulation** on every step. It walks through:

1. A local sandbox account, with KYC marked approved and the embedded wallet linked.
2. Direction: on-ramp (fiat to USDC) or off-ramp (USDC to fiat).
3. Asset, currency and payment method. The asset is USDC. USD uses ACH, SGD uses FAST and EUR uses SEPA. USDT and XSGD are shown and cannot be selected.
4. Amount, quote review and an explicit confirmation.
5. Funding instructions. An on-ramp shows fictional bank details and a reference. An off-ramp shows a funding reference, not a wallet address.
6. A simulated result. The status moves through `awaiting_funds`, `approved`, `payment_submitted` and `payment_processed`.

The fee is 0.50%, with a minimum of 0.50 in the source currency. A quote lasts two minutes. For 100.00 USD the quote receives 99.500000 USDC. For 100.00 USDC to SGD the quote receives 134.32 SGD.

Nothing in this flow charges a card, sends a bank transfer, asks for a wallet signature, moves tokens or calls Due. The wallet balance does not change. Test tokens still come from the [faucet](test-token-faucet.md).

## Credential

The simulator accepts one credential:

```text
local-due-sandbox-qcdao-151
```

It lives in `frontend/src/lib/dueSandbox.js` as `LOCAL_DUE_SANDBOX_KEY`. It is public on purpose. It is not a Due API key, it is not an environment variable, and it is not accepted by `api.sandbox.due.network` or `api.due.network`. Any other value is rejected, so pasting a real Due key into the app cannot point this screen at Due.

A Due key cannot be created from this repository. Due issues a Bearer token to a platform account. Ask Due through [demo@due.network](mailto:demo@due.network). When a key exists, store it in Secret Manager as `DUE_API_KEY` and use it only from a Cloud Function. Never put it in a `VITE_` variable.

## How to test it

No new environment variable, Firebase secret or deploy is required. Sign in with email on `http://127.0.0.1:5173` so the account menu has an embedded wallet.

### On-ramp

1. Open the account menu and choose **Add funds**.
2. Leave **On-ramp: fiat to USDC**, **USDC**, **US dollar (USD)** and **US bank transfer (ACH)**.
3. Enter `100.00` and choose **Review quote**. The quote shows a 0.50 USD fee and 99.500000 USDC.
4. Choose **Continue to confirmation**, then **Continue simulation**.
5. Confirm the bank name is "QC DAO sandbox bank", the account number is all zeroes, and the reference starts with `SIM-tf_`.
6. Choose **Simulate sandbox pay-in**. The status list ends at `payment_processed`, and the dialog says the balance is unchanged.
7. Refresh the account-menu balances. USDC is unchanged.

### Off-ramp

1. Open **Add funds** again, or open a proposal with an escrow and choose **Add funds** there.
2. Choose **Off-ramp: USDC to fiat**, then **Singapore dollar (SGD)**. The payment method becomes FAST.
3. Enter `100` and continue through review and confirmation.
4. The funding reference looks like `sandbox-funding:tf_1`. It is not an `0x` address, and there is no **Send** button.
5. Choose **Simulate sandbox deposit**. The result is `payment_processed`, and no wallet prompt appears.

### Automated tests

```bash
node --test test/unit/due-sandbox.test.js
npx vitest run test/components/due-ramp.test.jsx test/components/account-wallet.test.jsx test/components/escrow-funding-panel.test.jsx
```

Run both from `frontend/`. `npm test --prefix frontend` includes them.

## Swap point

Replace the simulator when the platform moves to a network Due actually settles. Keep `DueOnOffRamp`'s props (`address`, `email`, `className`) and the same screen order.

| Piece | Where |
| --- | --- |
| Button and dialog | `frontend/src/components/DueOnOffRamp.jsx` |
| Quote, transfer and simulated funding | `frontend/src/lib/dueSandbox.js` |
| Functions to replace | `startDueSandbox`, `quoteDueSandbox`, `createDueSandboxTransfer`, `simulateDueSandboxFunding` |
| Constant that names the swap | `DUE_RAMP_SWAP_POINT` in the same file |

The replacement calls Due from a Cloud Function. The browser keeps sending the member's wallet address and the form choices, and keeps rendering the returned quote, bank details or funding address, and status. The Due API key stays in Secret Manager.

## Due sandbox setup, for that later swap

This setup is not used by the current screen. It is the path Due documents for a sandbox platform, written down so the swap does not have to be rediscovered. Do not call these URLs from the browser, and do not use them in production.

Due's sandbox API is `https://api.sandbox.due.network`. Production is `https://api.due.network`. Sandbox-only tools are on `https://dev.sandbox.due.network`. Send `Authorization: Bearer <sandbox key>` and, after the account exists, `Due-Account-Id`.

1. Create an individual account with `POST /v1/accounts`. Keep the returned account id.
2. Link the Privy embedded wallet with `POST /v1/wallets` and body `{ "address": "<embedded wallet>" }`.
3. Approve sandbox KYC with `POST /dev/sumsub/applicants/<accountId>/approve`, or the tool at `https://dev.sandbox.due.network/commands/sumsub/approve-applicant`. Production KYC is a real review. Do not call the stub there.
4. On-ramp. `POST /v1/transfers/quote` with a fiat source (`ach` and `USD`, `sepa` and `EUR`) and a stablecoin destination. `POST /v1/transfers` with the quote token and the linked wallet as `recipient`. Show the user `transferInstructions`, including the payment reference. Simulate the bank payment with `POST /dev/payin`. `/dev/payin` cannot simulate a crypto deposit.
5. Off-ramp. Create the bank recipient, quote USDC to fiat, then `POST /v1/transfers`. `POST /v1/transfers/<transferId>/funding_address` returns `details.address`.
6. For a crypto leg, mint Due's own sandbox USDC from [Stub Admin](https://dev.sandbox.due.network/commands/crypto/mint-token) to the sender wallet. Due's example network is Base Sepolia. Mint to the sender, never to the funding address. Send the exact `source.amount` in one transaction before `expiresAt`, from the same address recorded as the sender. Due matches the deposit by sender and amount. Their published networks for funding addresses are Ethereum, Polygon, Avalanche, Arbitrum and Base, plus the sandbox equivalents. The token table on their site lists mainnet Arbitrum USDC and USDT, not QC DAO's faucet tokens.
7. Read `GET /v1/transfers/<transferId>` until the status reaches `payment_processed`.

The QC DAO faucet's USDC (`0x4CBf2C15243678206dF8F248D01a0e117C8ce0cd` on Arbitrum Sepolia) is a different token. Due says a public faucet token is never matched. Sending it to a Due funding address would not complete an off-ramp, and this app does not send it.

## Requirements this page covers

| QCDAO-151 | Where it is met |
| --- | --- |
| **Add funds** on the escrow panel and in the account menu | `EscrowFundingPanel`, `AccountWallet` |
| Amount, asset, currency, payment method, review, confirmation and success | `DueOnOffRamp` |
| Labelled as a testnet simulation | Dialog heading and banner |
| No real or sandbox payment can be started | The four functions only update an in-memory session |
| Swap point documented in the repository | This page and `DUE_RAMP_SWAP_POINT` |
