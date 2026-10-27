# Local development

The recommended setup runs the frontend against the Firebase emulators. It needs no cloud project and no billing. Wallet actions and on-chain checks still use the real Arbitrum Sepolia testnet through Privy.

## 1. Clone and install

Install all three packages before starting anything. Starting the emulators without the functions dependencies fails with `Cannot find module 'firebase-functions'`.

```bash
git clone https://github.com/0xMeePok/smu-qc-dao-project.git
cd smu-qc-dao-project
npm install --prefix firebase
npm install --prefix firebase/functions
npm install --prefix frontend
```

Run the installs again after a fresh clone, a deleted `node_modules` or a change to a `package.json` or lockfile.

## 2. Create the frontend env file

```bash
cp frontend/.env.example frontend/.env.local
```

For emulators, placeholder Firebase values are enough. You still need a real Privy app id, because Privy's login modal is a hosted service. Use a development Privy app that allows `http://localhost:5173` and `http://127.0.0.1:5173`, as described in [Privy](privy.md).

```bash
VITE_FIREBASE_USE_EMULATORS=true
VITE_FIREBASE_API_KEY=demo-api-key
VITE_FIREBASE_PROJECT_ID=qc-dao-demo
VITE_FIREBASE_APP_ID=1:000000000000:web:demo
VITE_FIREBASE_STORAGE_BUCKET=qc-dao-demo.firebasestorage.app
VITE_PRIVY_APP_ID=<your development Privy app id>
```

Leave `VITE_FIREBASE_APP_CHECK_SITE_KEY` empty. App Check is skipped with emulators.

## 3. Give the emulator the Privy secret

The sign-in function verifies Privy tokens with the app secret even in the emulator. Put the development app's secret in the git-ignored file `firebase/functions/.secret.local`:

```bash
PRIVY_SECRET=<development Privy app secret>
```

The emulator reads the public app id from `frontend/.env.local`, so no functions env file is needed for local work. Never copy the production secret into this file.

## 4. Start the emulators, then the app

Terminal 1:

```bash
cd firebase
npx firebase emulators:start --only functions,firestore,auth,storage --project qc-dao-demo
```

Wait for `All emulators ready` and for `exchangePrivySession` and `revokeOwnSessions` to appear in the functions list. The emulator UI is at http://127.0.0.1:4000.

Terminal 2:

```bash
cd frontend
npm run dev
```

The app opens at http://127.0.0.1:5173. `npm run dev` first seeds three sample postings into the emulators. The project id you pass to `--project` must match `VITE_FIREBASE_PROJECT_ID`.

Emulator data is lost when you stop the emulators. Add `--export-on-exit=./emulator-data --import=./emulator-data` to keep it between runs, and keep that folder out of Git.

## 5. Sign in

Sign in with your email, or with the Privy test account from the Privy dashboard (`test-XXXX@privy.io` and a fixed code). The first sign-in opens onboarding. To make yourself an administrator in the emulator, add your email to `ADMIN_BOOTSTRAP_EMAILS` in `firebase/functions/.env` and restart the emulators before onboarding.

To fund proposals locally, claim mock tokens from the account menu's **Faucet** action, which calls the live Vercel faucet on Arbitrum Sepolia.

## Alternative: one terminal on the Hosting emulator

```bash
cd firebase
npm run emulate
```

This builds the frontend for the emulators, generates `firebase.local.json` with a CSP that trusts localhost, and serves the build at http://127.0.0.1:5000 with the real Hosting headers. Seed data separately with `cd firebase/functions && npm run seed`.

Rebuild before any manual Hosting deploy afterwards: `npm run emulate` leaves an emulator build in `firebase/public`.

## Running against the live project

Pointing a local frontend at `qcdao-a0c7a` (`VITE_FIREBASE_USE_EMULATORS=false` and the real `VITE_FIREBASE_*` values) is possible but limited:

* Callable functions enforce App Check outside the emulator. A localhost page only passes if the reCAPTCHA key or an App Check debug token allows it, and this repository does not wire a debug token.
* The production bucket's CORS list excludes localhost, so attachments fail. The app detects this and tells you to use the Storage emulator.
* Everything you create is real production data.

Use a [preview channel](../operations/deployment.md#preview-channels) instead when you need the real backend.

## Contracts

Each contract package runs its tests on a local Hardhat chain, with no keys or RPC:

```bash
cd contracts/funding-escrow
npm install
npm test
```

`contracts/funding-escrow` also needs `contracts/audit-registry` installed, because it links to it.

## End-to-end funding tests

Two scripts in `scripts/` run the real contracts, backend modules and a Firestore emulator together, with fresh local wallets:

```bash
npm --prefix contracts/funding-escrow run compile
cd firebase && npx firebase emulators:start --only firestore --project demo-open-funding
# in another terminal, from the repository root
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/open-funding-e2e.mjs
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/main-funding-e2e.mjs
```

No testnet funds or deployed contracts are used.
