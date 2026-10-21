# Firebase setup — step by step

Every step marked **[YOU]** needs your action. Follow them in order; step 8 is the one
people skip, and skipping it produces a misleading CORS error.

---

## Before you start

You need the **Blaze (pay-as-you-go)** plan. Sign-in verifies the Privy access
token in Cloud Functions, and Cloud Functions is not available on Spark.

The free allowance (2M invocations/month) means a demo costs effectively nothing, but
a card is required. The browser never chooses the account: the server reads the
embedded wallet from Privy and mints the Firebase session.

If you only want to develop locally, skip to [Local development](#local-development-no-cloud-project)
— the emulators run fine on Spark.

---

## Step 1 — Create the project **[YOU]**

1. <https://console.firebase.google.com> → **Add project**
2. Name it (e.g. `smu-qc-dao`)
3. Turn Google Analytics **off** — not needed
4. Wait for provisioning, then open the project

## Step 2 — Upgrade to Blaze **[YOU]**

1. Bottom-left, click the **Spark** badge → **Upgrade** → **Blaze**
2. Attach a billing account
3. **Set a budget alert** when prompted — $5/month is ample and emails you long before
   anything surprising happens

## Step 3 — Enable Anonymous authentication **[YOU]**

1. **Build → Authentication → Get started**
2. **Sign-in method** tab → **Anonymous** → **Enable** → **Save**

> Custom tokens are not listed as a provider in the console. Enabling Anonymous is what
> activates Identity Toolkit for the project so `signInWithCustomToken` works. Do **not**
> enable Email/Password — this app has no passwords.

## Step 4 — Create Firestore **[YOU]**

1. **Build → Firestore Database → Create database**
2. **Production mode** (test mode leaves data world-writable for 30 days; the rules in
   this repo replace the defaults at step 8 anyway)
3. Location: **`asia-southeast1` (Singapore)**

   > **The location is permanent.** It must also match the Cloud Functions region, which
   > is `asia-southeast1` in two places: `REGION` in
   > [`firebase/functions/index.js`](../firebase/functions/index.js) and
   > `FUNCTIONS_REGION` in [`frontend/src/lib/firebase.js`](../frontend/src/lib/firebase.js).
   > If you pick a different region, change both or sign-in will 404.

**Do not create any collections by hand.** Firestore creates them on first write. For
reference, the schema is:

**`users/{lowercase wallet address}`**

| Field | Type | Notes |
|---|---|---|
| `address` | string | lowercase `0x…`, equals the document id and the Firebase uid |
| `email` | string | server-written on sign-in. One email per account. Clients cannot write it |
| `privyUserId` | string | server-written `did:privy:…`. Clients cannot write it |
| `fullName` | string | 2–80 chars |
| `organisation` | string | 2–120 chars |
| `role` | number | `0` (user) or `1` (administrator) access level |
| `chainId` | number | `421614` (Arbitrum Sepolia) |
| `walletVerified` | bool | `true` — the server proved it |
| `stats` | map | `comments`, `businessProblems`, `openFunding`, `fundingRequests`, `karma`, `reputation` — all start at `0` |
| `termsAcceptedAt` / `createdAt` / `updatedAt` | timestamp | server time, never client time |
| `termsVersion` | string | |
| `onboardingComplete` | bool | |

The whole `stats` map is **frozen against client writes** — the rules require it back
byte-identical on update, so nobody can award themselves karma. Only Admin SDK code can
move those numbers.

**`privyIdentities/{address}`** — the sign-in binding, copied onto `users/{address}`
when onboarding creates the profile. Admin SDK only.

## Step 5 — Register the web app **[YOU]**

1. **Project settings** (gear) **→ General → Your apps → Web** (`</>`)
2. Nickname it `qc-dao-frontend`. Do **not** tick Firebase Hosting here
3. Copy the `firebaseConfig` object

## Step 6 — Fill in your environment file **[YOU]**

```bash
cp frontend/.env.example frontend/.env.local
```

Paste the values in. Only three are actually required:

```
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_APP_ID=1:123456789012:web:abc123
```

`VITE_FIREBASE_AUTH_DOMAIN`, `STORAGE_BUCKET` and `MESSAGING_SENDER_ID` are optional —
see [FAQ](#faq). Both `.env.local` and `.env` work; both are gitignored.

## Step 7 — Install the CLI and link the project **[YOU]**

```bash
npm install -g firebase-tools
firebase login
cp firebase/.firebaserc.example firebase/.firebaserc
```

Put your real project id in `firebase/.firebaserc`.

## Step 8 — Deploy the rules AND the functions **[YOU]**

```bash
cd firebase
npm install
npm --prefix functions install
firebase deploy --only firestore:rules,firestore:indexes,functions --project YOUR_PROJECT_ID
```

**Both halves are mandatory.** Without the rules, production mode denies every write.
Without the functions, nothing can verify a Privy session and nobody can sign in.

The first deploy asks to enable the `cloudfunctions`, `cloudbuild`, `artifactregistry`,
`eventarc`, and `cloudscheduler` APIs — accept. It takes several minutes.

### Verify the deploy actually worked

```bash
firebase functions:list --project YOUR_PROJECT_ID
```

You want `exchangePrivySession` and `revokeOwnSessions` in `asia-southeast1`. Then check the
endpoint is really reachable:

```bash
curl -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  --data '{"data":{}}' \
  https://asia-southeast1-YOUR_PROJECT_ID.cloudfunctions.net/exchangePrivySession
```

`200` means deployed and working. **`404` means not deployed** — see
[Troubleshooting](#troubleshooting).

## Step 9 — Run it

```bash
npm install --prefix frontend
npm run dev --prefix frontend
```

## Step 10 — Privy email sign-in **[YOU]**

<a id="privy-email-sign-in"></a>
Members sign in through Privy's login modal with an email address and a one-time code.
Nobody installs a wallet: Privy's modal creates an embedded wallet on the first sign-in
(`createOnLogin: "users-without-wallets"` in `src/lib/privy.js`), and that address is
the account.

1. In the [Privy dashboard](https://dashboard.privy.io), create an app (or open the
   existing one) and copy **App settings → Basics → App ID** into `frontend/.env` as
   `VITE_PRIVY_APP_ID`. The app id is public; the app **secret** is never needed by the
   frontend and must never go in a `VITE_` variable.
2. **User management → Authentication**: enable **Email** only. Turn off wallet, SMS,
   social and passkey login. The app limits Privy's modal to email in code
   (`src/lib/privy.js`), but **passkeys are the exception**: whenever the dashboard
   allows passkey login, Privy's modal shows "I have a passkey" whatever the app's
   config says, so that toggle must be off here.
3. **Wallets → Embedded wallets**: enable **Ethereum (EVM)** wallets. Leave smart wallets
   off: gas sponsorship upgrades the embedded wallet in place (EIP-7702, same address),
   so the account never moves to a separate smart-wallet address.
4. **App settings → Domains → Allowed origins**: add every origin that serves the app —
   `https://YOUR_PROJECT_ID.web.app`, `https://YOUR_PROJECT_ID.firebaseapp.com`, each
   Hosting preview channel URL you test on (Privy does not accept a `*.web.app`
   wildcard), and `http://localhost:5173` / `http://127.0.0.1:5173` while developing.
5. **Fee sponsorship** (QCDAO-144): turn on **Sponsor gas fees**, add **Arbitrum
   Sepolia** under **Supported chains**, and turn on **Allow transactions from the
   client** (the app requests sponsorship from the browser with `sponsor: true`).
   Sponsorship needs Privy's TEE execution: the app's config reports
   `embedded_wallet_config.mode: "user-controlled-server-wallets-only"` when it is on
   (see Privy's [TEE migration guide](https://docs.privy.io/recipes/tee-wallet-migration-guide)
   for an app still on on-device execution). Testnet gas costs nothing; mainnet
   sponsorship needs prepaid credits.
6. Optional, for repeatable testing: **User management → Authentication → Advanced →
   Enable test accounts** gives a fixed `test-XXXX@privy.io` address and code.

### Privy deployment configuration

<a id="privy-deployment-configuration"></a>

Keep these settings in their separate destinations:

| Setting | Destination | Purpose |
| --- | --- | --- |
| `VITE_PRIVY_APP_ID` | `frontend/.env` or `.env.local`; GitHub Actions repository variable of the same name | Public app ID bundled into the frontend |
| `PRIVY_APP_ID` | `firebase/functions/.env.<project-id>` for manual deployment | The same public ID used by server token verification |
| `PRIVY_SECRET` | Firebase Functions Secret Manager | Server-only Privy API credential |

The existing deployment workflow uses `vars.VITE_PRIVY_APP_ID`, falling back to
`secrets.VITE_PRIVY_APP_ID` for older repository configurations. It supplies that
same value to the frontend build and the functions environment. If both exist,
the repository variable takes precedence. Do not add a Privy secret to the
workflow's frontend build environment. Vite exposes every `VITE_` value; the build
now rejects private Privy secret, token and signing-key names before bundling.

Before the first functions deployment, provision the app secret interactively
from the Firebase directory:

```bash
npx firebase functions:secrets:set PRIVY_SECRET --project YOUR_PROJECT_ID
```

Enter the value from the Privy dashboard when prompted. Do not put it in a shell
command, the frontend environment, a committed file or the frontend's GitHub
Actions variables. `exchangePrivySession` binds `defineSecret("PRIVY_SECRET")`;
deploy the function again after creating or rotating a secret version. Its
runtime service account must retain permission to access that secret. A missing
secret or denied access must be fixed in Firebase/Google Cloud, not by putting
the credential in the browser.

For a manual backend deployment, set `PRIVY_APP_ID` in the functions dotenv file
to the same public ID as the frontend. Firebase overlays `.env.<project-id>` on
`.env`; an empty project-specific setting overrides the base value. A shell
variable or emulator-only `.env.local` is not the deployed runtime environment.
`firebase/deploy.sh` checks these files before any database or rules changes and
requires an explicit project ID. You can run the same preflight from `firebase/`
with `node scripts/check-privy-deploy.mjs YOUR_PROJECT_ID`.

For local emulators using a real Privy app, the public ID is read from the
frontend environment and the app secret belongs in the gitignored
`firebase/functions/.secret.local` as `PRIVY_SECRET=...`. Never use that file as
the production secret source. Emulator test-user fixtures need no real secret.

For Hosting previews, Vite resolves shell and mode-specific environment files
at build time. `deploy:preview -- --backend` reads the public ID from that exact
artifact, updates only `PRIVY_APP_ID` in the backend dotenv file, and preserves
RPC and other runtime settings. It deploys rules and functions before publishing
the preview. This updates the shared backend for all channels. Without
`--backend`, no backend environment file is read or changed; use the same Privy
app ID as the already deployed backend. `--dry-run` stops before cloud changes
and backend environment writes.

### Hosting policy and verification

The configured email-only embedded-wallet flow needs these exact sources in
`firebase/firebase.json`:

| Directive | Privy source | Used for |
| --- | --- | --- |
| `connect-src` | `https://auth.privy.io` | Login and wallet API requests |
| `frame-src` | `https://auth.privy.io` | Embedded-wallet iframe |
| `connect-src` | `https://arbitrum-sepolia.rpc.privy.systems` | Sponsored Arbitrum Sepolia requests |

The app's CAPTCHA setting is currently disabled. If an administrator enables
Turnstile, add `https://challenges.cloudflare.com` to `script-src` and `frame-src`
and retest before release. Other CAPTCHA providers need their own documented
sources. Consult [Privy's CSP guide](https://docs.privy.io/security/implementation-guide/content-security-policy)
when changing dashboard features. External wallets are disabled in this app, so
their relay domains are not needed. Keep exact RPC origins and the existing
frame-ancestor, base, object and form protections.

Dashboard origins must match scheme, host and port exactly. For this project,
check both `https://qcdao-a0c7a.web.app` and
`https://qcdao-a0c7a.firebaseapp.com`, each current preview URL, and local
`http://localhost:5173` / `http://127.0.0.1:5173`. Remove expired or misspelled
origins after confirming nobody uses them. Keep Email as the only dashboard
login method, EVM embedded wallets enabled, Arbitrum Sepolia sponsorship enabled
and smart wallets disabled.

After a release:

1. Run `node firebase/scripts/check-csp.mjs https://qcdao-a0c7a.web.app` to inspect
   the effective response header, including CDN propagation retries.
2. In a fresh browser session with DevTools open, sign in with email and OTP,
   load the embedded wallet, sign a sponsored testnet transaction, then sign out
   and back in. Inspect both the main page and wallet iframe for CSP errors.
3. Confirm the same address/profile returns and the transaction is confirmed.
   Missing dashboard origins, App Check domain entries and secret permissions
   are separate gates from CSP; diagnose the failing gate before changing it.
4. Run the frontend artifact test to verify the public ID is present and a
   server-secret sentinel is absent. CI runs that real production build test.
   Never search for or print the actual secret value to check a bundle.

Signing in costs no gas: it sends no transaction at all. Every member transaction
(publishing audits, proposals, funding approvals and deposits) is gas-sponsored, so a
new embedded wallet holding no ETH can take part. A sponsored transaction is sent by a
bundler to the ERC-4337 EntryPoint, so the Cloud Functions verify the member's own call
inside it (`firebase/functions/memberCall.js`) instead of the transaction's sender.
Funding still needs the test token itself in the funder's wallet.

---

## How sign-in works

```
Sign in with email
      |
      v
Privy's login modal: email address, then the one-time code Privy sends to it
      |
      v
embedded wallet created by the modal on first sign-in, loaded on every later one
      |
      v
exchangePrivySession() -->  server verifies the Privy access token, reads that
      |                      user's embedded wallet from Privy, and mints a Firebase
      |                      custom token whose uid IS that address. The browser
      |                      does not name the account.
      v
signInWithCustomToken()
      |
      +-- users/{address} exists?  --> signed in
      |
      +-- not found?               --> onboarding modal
                                          (full name, organisation, role)
                                              |
                                              v
                                        #/role-selection
```

`request.auth.uid` **is** the wallet address. Email is stored on the same
`users/{address}` document by the server (`email`, `privyUserId`); Privy
keeps one user, and so one wallet, per email. The rules
reject a client write of either field. That is what makes the rule `request.auth.uid == address`
a real proof of ownership rather than a claim the browser made about itself.

## Administrator bootstrap (QCDAO-152)

The wallet address does not exist until the administrator signs in, so the grant
is keyed by email. Put their address in `ADMIN_BOOTSTRAP_EMAILS` on the functions
environment before they finish onboarding:

```bash
# firebase/functions/.env.qcdao-a0c7a  (gitignored)
ADMIN_BOOTSTRAP_EMAILS=you@smu.edu.sg
```

Redeploy functions, then sign in with that email and complete onboarding. The
server sets `role` to `1` on the new `users/{wallet}` document, but only for the
first account to hold that email: a second wallet presenting the same email
stays a normal user until an administrator promotes it by hand. A later sign-in
grants it again if the role is still `0`, which covers setting the variable
after the first signup. Remove the email from the list before demoting that
account to a normal user, or the next sign-in promotes it again.

The emulator reads the same variable from the process environment or
`firebase/functions/.env`.

## Reset development data (QCDAO-152)

`firebase/functions/scripts/reset-dev-data.mjs` deletes every Firestore root
collection (including subcollections), every Storage object, and every Auth
user. Dry run is the default. `--confirm` must be the project id or nothing is
deleted.

This repository's tests run it only against the emulator. The live site is
`qcdao-a0c7a`; run that yourself, after a dry run:

```bash
cd firebase/functions

# Emulator. Start it first, then:
node scripts/reset-dev-data.mjs --project qcdao-a0c7a
node scripts/reset-dev-data.mjs --project qcdao-a0c7a --confirm qcdao-a0c7a

# Live project. Application Default Credentials. Emulator host variables must be unset.
node scripts/reset-dev-data.mjs --target production --project qcdao-a0c7a
node scripts/reset-dev-data.mjs --target production --project qcdao-a0c7a --confirm qcdao-a0c7a
```

The script refuses a production reset of any project other than `qcdao-a0c7a`,
and refuses production while `FIRESTORE_EMULATOR_HOST`,
`FIREBASE_AUTH_EMULATOR_HOST` or `FIREBASE_STORAGE_EMULATOR_HOST` is set.

---

## Troubleshooting

### "blocked by CORS policy: No 'Access-Control-Allow-Origin' header"

**This almost always means the functions are not deployed**, not that CORS is
misconfigured. A missing function returns a 404 HTML page, that page has no CORS
headers, and the browser reports the missing header instead of the 404.

Confirm with the `curl` in step 8. If you get `404`:

```bash
cd firebase && firebase deploy --only functions --project YOUR_PROJECT_ID
```

If that fails with a billing error, you are still on Spark — do step 2.

If `curl` returns `403`, the functions deployed but are not publicly invokable. Grant it:

```bash
gcloud run services add-iam-policy-binding exchangeprivysession \
  --region=asia-southeast1 --member=allUsers --role=roles/run.invoker
```

### Region mismatch

If `functions:list` shows a region other than `asia-southeast1`, either redeploy to
that region or change `REGION` and `FUNCTIONS_REGION` (step 4) to match what you have.

### "Your details were rejected by our security rules"

The rules are not deployed: `firebase deploy --only firestore:rules`.

### Email sign-in succeeds but no onboarding popup appears

The Firebase session never completed. The popup opens only after
`exchangePrivySession` has minted a custom token. Check the browser console for
the specific error — an undeployed function reports itself in plain language
rather than failing silently.

---

## Local development (no cloud project)

Works on Spark, no billing, no deploy:

```bash
# terminal 1
cd firebase && npx firebase emulators:start --only functions,firestore,auth,storage --project qc-dao-demo

# terminal 2
npm run dev --prefix frontend
```

Set in `frontend/.env.local`:

```
VITE_FIREBASE_USE_EMULATORS=true
VITE_FIREBASE_API_KEY=demo-api-key
VITE_FIREBASE_PROJECT_ID=qc-dao-demo
VITE_FIREBASE_APP_ID=1:000000000000:web:demo
```

The emulators accept any project id and placeholder keys.

---

## Running the tests

```bash
npm test --prefix frontend      # Frontend unit and component tests; no emulator needed
npm test --prefix firebase      # Firestore rules tests (boots the emulator; needs Java)

# Cloud Functions tests boot their emulator; no separate emulator process is needed:
npm test --prefix firebase/functions
```

---

## FAQ

### Do I still need a WalletConnect project id, or MetaMask?

**No.** Browser wallets are gone: email through Privy is the only sign-in method, and
external wallets (MetaMask, WalletConnect, Coinbase and the rest) are switched off in
the Privy config. Delete `VITE_WALLETCONNECT_PROJECT_ID` from your env file; nothing
reads it.

### What ends a session?

Signing out, 15 minutes of inactivity, or an administrator suspending the account. Each
ends **both** the Privy session and the Firebase session. A Privy session found without a
Firebase session beside it (after a reload, or a sign-out in another tab) is ended too.

### Do I still need `authDomain`?

**Not for this app.** `authDomain` is only used by OAuth popup/redirect sign-in (Google,
GitHub, email link). This app signs in with custom tokens, which does not touch it —
verified directly: `signInWithCustomToken` succeeds with `authDomain` absent.

It is harmless to keep, and you would need it the moment you add Google sign-in, so
leaving it in costs nothing. The app no longer refuses to start when it is missing —
only `apiKey`, `projectId` and `appId` are required.

### Are the `VITE_FIREBASE_*` values secrets?

No. They ship in the JS bundle and are visible to anyone who opens devtools. They are
identifiers, not credentials. Your data is protected by Firestore rules and by
the server checking the Privy access token. Keep the env file out of git anyway so each person
uses their own project.
