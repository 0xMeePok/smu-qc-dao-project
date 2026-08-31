# Firebase setup — step by step

Every step marked **[YOU]** needs your action. Follow them in order; step 8 is the one
people skip, and skipping it produces a misleading CORS error.

---

## Before you start

You need the **Blaze (pay-as-you-go)** plan. Sign-in verifies wallet signatures on the
server, that runs in Cloud Functions, and Cloud Functions is not available on Spark.

The free allowance (2M invocations/month) means a demo costs effectively nothing, but
a card is required. There is no fool-proof alternative: verifying a signature in the
browser proves nothing, because an attacker just skips the browser.

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
| `address` | string | lowercase `0x…`, equals the document id |
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

**`siweNonces/{address}`** — written and consumed by the Cloud Functions, denied to all
clients. Manages itself; ignore it.

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
firebase deploy --only firestore:rules,functions --project YOUR_PROJECT_ID
```

**Both halves are mandatory.** Without the rules, production mode denies every write.
Without the functions, nothing can verify a signature and nobody can sign in.

The first deploy asks to enable the `cloudfunctions`, `cloudbuild`, `artifactregistry`
and `eventarc` APIs — accept. It takes several minutes.

### Verify the deploy actually worked

```bash
firebase functions:list --project YOUR_PROJECT_ID
```

You want `getSiweNonce` and `verifySiweSignature` in `asia-southeast1`. Then check the
endpoint is really reachable:

```bash
curl -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  --data '{"data":{"address":"0x0000000000000000000000000000000000000000"}}' \
  https://asia-southeast1-YOUR_PROJECT_ID.cloudfunctions.net/getSiweNonce
```

`200` means deployed and working. **`404` means not deployed** — see
[Troubleshooting](#troubleshooting).

## Step 9 — Run it

```bash
npm install --prefix frontend
npm run dev --prefix frontend
```

## Step 10 — Get a wallet **[YOU]**

Install [MetaMask](https://metamask.io/download/). You do **not** need to add Arbitrum
Sepolia in advance, and signing in costs no gas — it is a signature, not a transaction.

---

## How sign-in works

```
Sign in with Wallet
      |
      v
wagmi connector picker   (wallets discovered via EIP-6963)
      |
      v
getSiweNonce()   ------>  server issues a single-use nonce and returns
      |                   the exact message to sign
      v
wallet signs that message
      |
      v
verifySiweSignature() -->  server rebuilds the message from its OWN stored nonce,
      |                    verifies the signature, burns the nonce, and mints a
      |                    Firebase custom token whose uid IS the wallet address
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

`request.auth.uid` **is** the wallet address, and a uid can only exist because the
server verified a signature. That is what makes the rule `request.auth.uid == address`
a real proof of ownership rather than a claim the browser made about itself.

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
gcloud run services add-iam-policy-binding getsiwenonce \
  --region=asia-southeast1 --member=allUsers --role=roles/run.invoker
gcloud run services add-iam-policy-binding verifysiwesignature \
  --region=asia-southeast1 --member=allUsers --role=roles/run.invoker
```

### Region mismatch

If `functions:list` shows a region other than `asia-southeast1`, either redeploy to
that region or change `REGION` and `FUNCTIONS_REGION` (step 4) to match what you have.

### "Your details were rejected by our security rules"

The rules are not deployed: `firebase deploy --only firestore:rules`.

### The wallet connects but no onboarding popup appears

Sign-in never completed. The popup only opens once the server has verified your
signature. Check the browser console for the specific error — an undeployed function
now reports itself in plain language rather than failing silently.

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
npm test --prefix frontend      # 17 validation tests, no emulator needed
npm test --prefix firebase      # 18 Firestore rules tests (boots the emulator, needs Java)

# Adversarial signature tests, with the functions emulator running:
cd firebase && npx firebase emulators:start --only functions,firestore,auth,storage --project qc-dao-demo
cd firebase/functions && npm test    # 7 attack tests
```

---

## FAQ

### Do I still need a WalletConnect project id?

**No.** It has been removed. wagmi discovers browser wallets over EIP-6963 with no
project id and no extra dependency, so MetaMask, Rabby, Coinbase's extension and others
appear automatically.

You would only need one if you deliberately add the `walletConnect()` connector back for
phone-QR sign-in. That currently pulls in `@reown/appkit → @base-org/account → axios`,
which carries a high-severity advisory and adds noticeably to the bundle — the trade-off
is documented in [`src/lib/wagmi.js`](../frontend/src/lib/wagmi.js). Delete
`VITE_WALLETCONNECT_PROJECT_ID` from your env file; nothing reads it.

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
server-side signature verification. Keep the env file out of git anyway so each person
uses their own project.
