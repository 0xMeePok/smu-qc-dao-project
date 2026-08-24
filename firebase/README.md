# Firebase backend

Firestore security rules, Cloud Functions, and their tests for QC DAO's wallet
sign-in. **The backend is already deployed** — Firestore, Authentication, and both
Cloud Functions are live. Most collaborators only need the
[Connect](#connect-to-the-shared-backend) section below; the rest of this file is
for anyone editing `firestore.rules` or `functions/index.js` and redeploying.

## What's here

```
firebase/
├── firestore.rules              # Server-side authorisation for the users/{address} schema
├── firestore.indexes.json       # No composite indexes needed yet
├── firebase.json                # Emulator ports, hosting config, functions source path
├── .firebaserc.example          # Copy to .firebaserc and fill in the project id
├── test/
│   └── firestore.rules.test.mjs # 18 tests against firestore.rules, via the emulator
└── functions/
    ├── index.js                 # getSiweNonce + verifySiweSignature (see below)
    ├── package.json
    └── test/
        └── siwe.test.mjs        # 7 adversarial tests: replay, forged signature, wrong signer, etc.
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

This is all most people need — no install in this folder, no deploy, no Firebase CLI.

1. Ask the project owner for the six `VITE_FIREBASE_*` values.
2. Put them in `frontend/.env.local` (copy `frontend/.env.example` as a starting
   point).
3. `npm install && npm run dev` in `frontend/` — sign-in talks straight to the live
   backend.

Verify the backend itself is reachable, independent of the frontend:

```bash
curl -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  --data '{"data":{"address":"0x0000000000000000000000000000000000000000"}}' \
  https://asia-southeast1-<project-id>.cloudfunctions.net/getSiweNonce
```

`200` means it's up. If you get a CORS error in the browser console instead, it
almost always means the URL is wrong (region or project id) rather than an actual
CORS misconfiguration — a 404 page carries no CORS headers, and the browser reports
the missing header instead of the 404.

---

## Making backend changes

Everything below is only relevant if you're editing `firestore.rules` or
`functions/index.js` yourself.

### Install

```bash
cd firebase
npm install
npm --prefix functions install
```

### Link this checkout to the project

```bash
cp .firebaserc.example .firebaserc
```

Edit `.firebaserc` and put the real project id in place of
`your-firebase-project-id`. This file is gitignored.

### Run against local emulators instead of the live backend

```bash
npx firebase emulators:start --only functions,firestore,auth --project qc-dao-demo
```

Point the frontend at it with `VITE_FIREBASE_USE_EMULATORS=true` in
`frontend/.env.local`. The emulator UI is at `http://127.0.0.1:4000`. Useful for
trying out a rules or functions change without touching the shared backend.

### Tests

```bash
# Firestore rules — boots its own emulator, needs Java
npm test

# Cloud Functions — adversarial signature tests. Needs the functions emulator running
# (see above), or point at the live backend:
npm --prefix functions test
FUNCTIONS_BASE_URL=https://asia-southeast1-<project-id>.cloudfunctions.net npm --prefix functions test
```

The rules suite (18 tests) checks things like: a wallet can only create its own
profile, `stats` can never be written non-zero at signup, one signed-in wallet cannot
edit another's profile, and `siweNonces` is unreachable from any client.

The functions suite (7 tests) checks that a replayed signature, a signature from the
wrong key, a fabricated signature, and a signature over a different message are all
rejected — and that a legitimate signature succeeds.

### Deploy

```bash
firebase deploy --only firestore:rules,functions --project <project-id>
```

Confirm it landed:

```bash
firebase functions:list --project <project-id>
```

You should see `getSiweNonce` and `verifySiweSignature` in `asia-southeast1`.

## The `users/{address}` schema these rules enforce

| Field | Type | Notes |
|---|---|---|
| `address` | string | lowercase `0x…`, must equal the document id |
| `fullName` | string | 2–80 chars |
| `organisation` | string | 2–120 chars |
| `role` | string | one of the five roles in `frontend/src/lib/roles.js` — keep both files in sync |
| `chainId` | number | `421614` (Arbitrum Sepolia) |
| `walletVerified` | bool | always `true` — only reachable after server-side verification |
| `stats` | map | `comments`, `businessProblems`, `openFunding`, `fundingRequests`, `karma`, `reputation` — all `0` at creation, frozen against every client write |
| `onboardingComplete` | bool | flips to `true` once the role-selection step is confirmed |
| `termsAcceptedAt`, `createdAt`, `updatedAt` | timestamp | must equal server time, not client-supplied time |

`stats` can only ever move via the Admin SDK, which bypasses these rules — nothing
currently writes to it, since comments/problems/funding/proposals are not built yet.
