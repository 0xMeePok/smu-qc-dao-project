# Firebase backend

Firestore security rules, Cloud Functions, and their tests for QC DAO's wallet
sign-in. **The backend is already deployed** — Firestore, Authentication, and both
Cloud Functions are live. Most collaborators only need the
[Connect](#connect-to-the-shared-backend) section below; the rest of this file is
for anyone editing `firestore.rules` or `functions/index.js` and redeploying.

## What's here

```
firebase/
├── deploy.sh                    # One-shot production setup - see "Deploy" below
├── firestore.rules              # Server-side authorisation for users/, publicProfiles/, siweNonces/
├── firestore.indexes.json       # No composite indexes needed yet
├── firebase.json                # Emulator ports, hosting config, functions source path
├── .firebaserc.example          # Copy to .firebaserc and fill in the project id
├── test/
│   └── firestore.rules.test.mjs # 78 tests against firestore.rules, via the emulator
└── functions/
    ├── index.js                 # getSiweNonce + verifySiweSignature (see below)
    ├── package.json
    └── test/
        └── siwe.test.mjs        # 25 adversarial tests: replay, forged signature, spoofed origin, etc.
```

### What the two Cloud Functions do

Wallet sign-in is verified server-side, not in the browser — a client-side check
proves nothing, since anyone can call Firestore directly and skip it. The uid
Firebase ends up with **is** the lowercase wallet address, and that uid only exists
because one of these functions verified a real signature first:

1. **`getSiweNonce`** — issues a single-use nonce and returns the exact message to
   sign. The client never chooses this text.
2. **`verifySiweSignature`** — rebuilds that message from its own stored nonce,
   verifies the signature (`viem.verifyMessage`, which also covers EIP-1271 smart
   contract wallets), burns the nonce, and mints a Firebase custom token whose uid is
   the address.

## Connect to the shared backend

1. Ask Ashley for the six `VITE_FIREBASE_*` values.
2. Put them in `frontend/.env.local` (copy `frontend/.env.example` as a starting
   point).
3. Install from the **repo root**, then run the frontend:

```bash
cd ..   # repo root, if you are in firebase/
npm install --prefix firebase
npm install --prefix firebase/functions
npm install --prefix frontend
cd frontend && npm run dev
```

Sign-in talks straight to the live backend. The root [README](../README.md#getting-started)
has the full local (emulator) flow.

Verify the backend itself is reachable, independent of the frontend:

```bash
curl -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  --data '{"data":{"address":"0x0000000000000000000000000000000000000000"}}' \
  https://asia-southeast1-<project-id>.cloudfunctions.net/getSiweNonce
```

`200` means it's up. If you get a CORS error in the browser console instead, it
almost always means the URL is wrong (region or project id) rather than an actual
CORS misconfiguration.

---

## Making backend changes

Everything below is only relevant if you're editing `firestore.rules` or
`functions/index.js` yourself.

### Install

Do this **before** `emulators:start` or `npm test`. `cd firebase && npm install` is
not enough — `firebase-functions` lives in `functions/`:

```bash
# from the repo root
npm install --prefix firebase
npm install --prefix firebase/functions
npm install --prefix frontend
```

### Link this checkout to the project

```bash
cp .firebaserc.example .firebaserc
```

Edit `.firebaserc` and put the real project id in place of
`your-firebase-project-id`. This file is gitignored.

### Run against local emulators instead of the live backend

Install first (section above), then:

```bash
npx firebase emulators:start --only functions,firestore,auth --project qcdao-a0c7a
```

Point the frontend at it with `VITE_FIREBASE_USE_EMULATORS=true` in
`frontend/.env.local` (project id there must match `--project`). The emulator UI is
at `http://127.0.0.1:4000`. Useful for trying out a rules or functions change without
touching the shared backend.

If functions fail to load with `Cannot find module 'firebase-functions'`, you skipped
`npm install --prefix firebase/functions`.

### Tests

```bash
# Firestore rules — boots its own emulator, needs Java
npm test

# Cloud Functions — adversarial signature tests. Boots its own emulator; no setup:
npm --prefix functions test
FUNCTIONS_BASE_URL=https://asia-southeast1-<project-id>.cloudfunctions.net npm --prefix functions test
```

The rules suite (78 tests) checks things like: a wallet can only create its own
profile and can only read its own, `stats` can never be written non-zero at signup,
the user base cannot be enumerated, `role` never leaks through `publicProfiles`, and
`siweNonces` is unreachable from any client.

The functions suite (25 tests) checks that a replayed signature, a signature from the
wrong key, a fabricated signature, a signature over a different message, and a nonce
request from an unrecognised origin are all rejected — and that a legitimate
signature succeeds.

### Allowed sign-in origins

The SIWE message names a domain, and that name is what binds a signature to this
site. `getSiweNonce` refuses to issue a message to a browser origin it does not
recognise — otherwise anyone could request a message naming *their* domain, get a
user to sign it, and exchange that signature here for a real session.

**This fails closed.** An unlisted origin gets `permission-denied`, which surfaces in
the app as *"The sign-in server refused the request."* Recognised automatically, with
no configuration:

- `<project-id>.web.app` and `<project-id>.firebaseapp.com`
- `localhost:5173` / `127.0.0.1:5173`, **only** under the emulator — never in a
  deployed function, where allow-listing localhost would reopen the hole

Additional origins (a custom domain) go in `functions/.env`, which is gitignored:

```
SIWE_DOMAIN=qcdao.example.edu
SIWE_ALLOWED_HOSTS=qcdao.example.edu,www.qcdao.example.edu
```

`SIWE_DOMAIN` is the canonical name used when a request has no `Origin` header at all
(a server, curl, the test suite). `SIWE_ALLOWED_HOSTS` is a comma-separated list of
additional browser origins allowed to request a message.

Do **not** add `localhost` to `SIWE_ALLOWED_HOSTS` on a deployed project to make local
development work. It would let anyone forge `Origin: localhost:5173` and obtain a
signable message again. Use the emulator instead — see below.

### Local development against the emulator

Because deployed functions refuse `localhost`, a local frontend pointed at the live
backend will fail sign-in with *"The sign-in server refused the request."* Run the
emulator instead, where dev origins are allowed automatically.

From the **repo root**, install first, then two terminals:

```bash
npm install --prefix firebase
npm install --prefix firebase/functions
npm install --prefix frontend
```

```bash
# terminal 1
cd firebase
npx firebase emulators:start --only functions,firestore,auth --project qcdao-a0c7a

# terminal 2
cd frontend
npm run dev
```

Then set `VITE_FIREBASE_USE_EMULATORS=true` in `frontend/.env.local` (and keep
`VITE_FIREBASE_PROJECT_ID=qcdao-a0c7a` in sync with `--project`). The app still opens
at `http://localhost:5173`; only the backend changes. Emulator data starts empty and
is discarded on shutdown, so you will re-onboard a test wallet each session unless
you pass `--export-on-exit`.

### Continuous deployment

Pushing to `main` runs [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):

```
test-backend  (Cloud Functions, 25) ──┐
                                      ├──→ deploy-backend ──→ deploy-hosting
test-rules    (Firestore rules, 78) ──┘                            ↑
test-frontend (47) ─────────────────────────────────────────────────┘
```

Backend deploys first and hosting waits for it, because `createProfile()` writes to
`publicProfiles/{address}` and the catch-all rule denies that collection until
`firestore.rules` declares it. A frontend released ahead of its rules breaks
onboarding for every new user.

The rules suite runs here **and** in `ci.yml`. That duplication is deliberate:
`ci.yml` is a separate workflow and cannot stop `deploy-backend`, so only the copy in
this workflow actually gates the deploy.

The service account needs `Firebase Hosting Admin`, `Firebase Rules Admin`,
`Cloud Functions Developer`, `Service Account User`, `Cloud Run Admin`,
`Artifact Registry Writer` and `Cloud Build Editor`. A missing role surfaces as a
`PERMISSION_DENIED` naming the exact permission — add it and re-run the job.

<a id="preview-channels"></a>
### Preview channels

Deploy the current build to a temporary real URL without touching the live site:

```bash
npm run build --prefix ../frontend
npx firebase hosting:channel:deploy my-test --expires 1d --project <project-id>
```

You get `https://<project>--my-test-<hash>.web.app`, served by real Firebase Hosting
and talking to the **real deployed backend**. Sign-in works there: `getSiweNonce`
accepts hosts matching the generated channel shape, so the unpredictable hash needs
no configuration.

Two things to know:

- It writes to **production** Firestore. Onboarding on a preview creates real
  `users/` and `publicProfiles/` documents. Use a throwaway wallet.
- It previews the **frontend only**. Rules and functions are whatever is currently
  deployed, so a local `firestore.rules` change is not reflected — test those against
  the emulator instead.

```bash
npx firebase hosting:channel:list --project <project-id>
npx firebase hosting:channel:delete my-test --project <project-id>
```

### Deploy

For a brand-new production project (a fresh Firebase project with nothing deployed
yet), use `deploy.sh` — it creates the Firestore database in the correct region if
one doesn't exist, deploys rules/indexes/functions, and prints what's left to do by
hand. It never deletes or moves an existing database:

```bash
./deploy.sh --project <project-id>
```

Run `./deploy.sh --help` for the full rundown of what it checks and why.

For a one-off change to rules or functions on an already-set-up project, the plain
CLI commands are enough:

```bash
firebase deploy --only firestore:rules,functions --project <project-id>
```

Confirm it landed:

```bash
firebase functions:list --project <project-id>
```

You should see `getSiweNonce` and `verifySiweSignature` in `asia-southeast1`.

## Collections

| Collection | Who can read | Contents |
|---|---|---|
| `users/{address}` | the owning wallet only (`get`, never `list`) | the full profile, including `role` |
| `publicProfiles/{address}` | anyone (`get`, never `list`) | `address`, `fullName`, `organisation` — nothing else |
| `siweNonces/{address}` | nobody; Admin SDK only | pending sign-in nonces |

A profile is split across two documents because Firestore rules can only allow or
deny a whole document — there is no way to publish some fields and hide others
within one. `role` therefore lives only in `users`, so nothing can reveal which
wallets are administrators.

Neither collection grants `list`. An address can be looked up when it is already
known (because it was attached to something published), but the directory cannot be
enumerated.

`createProfile` in `frontend/src/lib/profile.js` writes both documents in a single
batch, so an account can never end up half-created.

## The `users/{address}` schema these rules enforce

| Field | Type | Notes |
|---|---|---|
| `address` | string | lowercase `0x…`, must equal the document id |
| `fullName` | string | 2–80 chars |
| `organisation` | string | 2–120 chars |
| `role` | number | `0` (user) or `1` (administrator). Fixed to `0` on create and immutable on every client update — the only way to grant `1` is by hand in the Firestore console (or via the Admin SDK), never through the app |
| `chainId` | number | must be `421614` (Arbitrum Sepolia); immutable after creation |
| `walletVerified` | bool | must be `true` at creation — only reachable after server-side verification |
| `stats` | map | `comments`, `businessProblems`, `openFunding`, `fundingRequests`, `karma`, `reputation` — all `0` at creation, frozen against every client write |
| `termsVersion` | string | 1–40 chars; immutable after creation |
| `termsAcceptedAt`, `createdAt`, `updatedAt` | timestamp | must equal server time, not client-supplied time |

No other fields are allowed — `create` and `update` both reject a document with any
field outside this list, so a client can't smuggle in something like a self-granted
`isAdmin` for later code to trust by accident.

## The `publicProfiles/{address}` schema

| Field | Type | Notes |
|---|---|---|
| `address` | string | lowercase `0x…`, must equal the document id |
| `fullName` | string | 2–80 chars |
| `organisation` | string | 2–120 chars |

Locked with `hasOnly()` on both `create` and `update`, so `role`, `stats`,
`walletVerified`, `chainId` and the timestamps cannot be written here even by the
wallet that owns the record.

`stats` can only ever move via the Admin SDK, which bypasses these rules — nothing
currently writes to it, since comments/problems/funding/proposals are not built yet.
