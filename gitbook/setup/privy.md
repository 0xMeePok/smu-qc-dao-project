# Privy

Privy provides the email login modal, one embedded EVM wallet per email and gas sponsorship. The app limits Privy to email in code (`frontend/src/lib/privy.js`), but several dashboard settings must match, or sign-in and transactions fail.

## Joining the existing project

1. Ask the Privy dashboard owner to invite you to the app's team at [dashboard.privy.io](https://dashboard.privy.io).
2. Copy the **App ID** from **Configuration**, **App settings**, **Basics**. It is public.
3. Ask for the app secret only if you will deploy or run the emulator against this app. Privy does not store the secret, so it must be handed over securely or regenerated. Regenerating it breaks sign-in until `PRIVY_SECRET` is updated and the functions are redeployed.
4. Add your local origins to the allowed origins, or better, use a separate development app.

## Creating an app

Privy recommends one app per environment. Use a development app for local work and keep the production app's origins and secret tight.

### 1. Create the app and collect the ids

1. In [dashboard.privy.io](https://dashboard.privy.io), create an app.
2. Open **Configuration**, **App settings**, **Basics** and copy the **App ID** and **App secret**. Store the secret in a password manager straight away. Privy does not store it, so a lost secret has to be regenerated.

### 2. Allow email only

1. Open **User management**, **Authentication**.
2. Enable **Email**.
3. Turn off wallet, SMS, social and passkey login. Passkeys matter most: while the dashboard allows them, Privy's modal shows **I have a passkey** whatever the app's code says.

### 3. Configure embedded wallets

1. Open **Wallets** and enable **Ethereum (EVM)** embedded wallets. The app creates the wallet on first login (`createOnLogin: "users-without-wallets"`).
2. Leave smart wallets off. Gas sponsorship upgrades the embedded wallet in place with EIP-7702, so the address never changes. A separate smart wallet would have a different address and break the account model.
3. Check that **Wallets**, **Advanced** shows **TEE enabled**. Gas sponsorship requires TEE execution. If it shows **On-device**, request the migration from that tab. The migration is one-way.

### 4. Set the allowed origins

Open **Configuration**, **App settings**, **Domains**, **Allowed origins** and add every origin that serves the app. Origins must match scheme, host and port exactly.

| Origin | When |
| --- | --- |
| `https://<project-id>.web.app` | Always |
| `https://<project-id>.firebaseapp.com` | Always |
| Each preview channel URL, such as `https://<project-id>--prod-twin-<hash>.web.app` | While that channel is in use. Privy does not accept a wildcard that matches every `web.app` site, so add each one and remove it when the channel expires |
| `http://localhost:5173` and `http://127.0.0.1:5173` | Development apps only |

### 5. Turn on gas sponsorship

1. Open **Fee sponsorship** and enable **Sponsor gas fees**.
2. Under **Supported chains**, add **Arbitrum Sepolia**.
3. Enable **Allow transactions from the client**. The app requests sponsorship from the browser with `sponsor: true`.

Testnet sponsorship costs nothing. A move to mainnet needs prepaid credits under **Billing**, **Fee sponsorship**.

### 6. Optional: test accounts

Under **User management**, **Authentication**, **Advanced**, enable **Enable test accounts**. The dashboard then shows a fixed `test-XXXX@privy.io` address and code for repeatable testing. Use the exact values it shows.

### 7. Leave CAPTCHA off unless you also change the CSP

CAPTCHA is currently disabled. If you enable Cloudflare Turnstile, add `https://challenges.cloudflare.com` to `script-src` and `frame-src` in `firebase/firebase.json` and test again before release. Other dashboard features may need other origins. Privy's [CSP guide](https://docs.privy.io/security/implementation-guide/content-security-policy) lists them.

## Where the values go

| Value | Destination | Secret? |
| --- | --- | --- |
| App ID | `VITE_PRIVY_APP_ID` in `frontend/.env.local`, the GitHub Actions variable `VITE_PRIVY_APP_ID`, and `PRIVY_APP_ID` in `firebase/functions/.env.<project-id>` for manual deploys | No |
| App secret | Secret Manager as `PRIVY_SECRET` for deployed functions, `firebase/functions/.secret.local` for the emulator | Yes |

The frontend build refuses any `VITE_PRIVY_*` variable whose name looks like a secret, key or token. CI also checks that the built bundle contains the public id.

## Check that it works

1. In a fresh browser profile with DevTools open, sign in on the live site with email and the one-time code.
2. Confirm onboarding opens for a new email, and the same address returns on the next sign-in.
3. Send a sponsored transaction, for example a faucet claim or publishing a test posting, and confirm it with no ETH in the wallet.
4. Sign out and back in. Look for CSP errors in both the page and the Privy wallet iframe.
5. Run `node firebase/scripts/check-csp.mjs https://<project-id>.web.app`.

If sign-in fails, check the allowed origins, the App Check registration and the `PRIVY_SECRET` permissions separately. They fail in different ways, so find which one is failing before changing anything. See [Troubleshooting](../operations/troubleshooting.md).
