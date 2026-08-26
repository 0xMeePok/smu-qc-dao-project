# SMU QC DAO

A blockchain-enabled Proof of Concept platform for coordinating quantum and
quantum-adjacent solution funding workflows across organisations. Problem owners and
funders post problem statements, researchers submit proposals, and evaluators review
submissions through a shared web application. Sign-in is wallet-only: there is no
email or password anywhere in the system.

## Overview

The solution uses a hybrid architecture:

- **Firebase** (Firestore + Auth + Cloud Functions) stores off-chain application
  data — user profiles, problem statements, proposal content, evaluation records —
  and verifies wallet ownership server-side before any of it is written.
- **Smart contracts** deployed on **Arbitrum Sepolia** store verification hashes,
  timestamps, and key audit events, plus the QFT ERC-20 token distributed for
  platform activity.

This keeps sensitive content off-chain while still giving cross-institution
stakeholders an independently verifiable audit trail for the events that matter.

## How sign-in works

There is no registration form and no public sign-up URL. Connecting a wallet **is**
the account:

```
"Sign in with Wallet"
      |
      v
wagmi connector picker        (wallets discovered via EIP-6963 — no project id needed)
      |
      v
getSiweNonce()   ---------->  Cloud Function issues a single-use nonce and
      |                       returns the exact message to sign
      v
wallet signs that message
      |
      v
verifySiweSignature()  --->   Cloud Function re-derives the message from its OWN
      |                       stored nonce, verifies the signature, burns the nonce,
      |                       and mints a Firebase custom token whose uid IS the
      |                       wallet address
      v
signInWithCustomToken()
      |
      +-- users/{address} exists?  --> signed in
      |
      +-- not found?               --> onboarding popup (full name, organisation)
                                        creates the profile as a normal user
```

`request.auth.uid` **is** the lowercase wallet address, and that uid can only exist
because a Cloud Function verified a real signature first. That is what makes
Firestore's rule `request.auth.uid == address` a genuine proof of wallet ownership
rather than a claim the browser made about itself — verifying it in the browser
alone would prove nothing, since a client can always call Firestore directly and
skip that check.

**This initial signature only happens once per session** (Firebase persists it
across page reloads). The same signing step is what any future state-changing
action — posting a comment, committing funding, submitting a proposal — will also
require at the point of that action, once those features exist. Right now, only
account creation is implemented; nothing else writes to Firestore yet.

Every account is a normal user (`role: 0`). There is no self-service way to become an
administrator (`role: 1`) — that is set by hand in the Firestore console, and an
admin-only page appears in the app automatically once it is.

## Project Structure

```
smu-qc-dao-project/
├── contracts/
│   └── qft-tokens/          # QFT ERC-20 (fixed supply), Hardhat project, Arbitrum Sepolia
├── frontend/                 # Vite + React app — wallet sign-in, marketplace pages
│   ├── src/
│   │   ├── lib/                 # Firebase/wagmi setup, validation, SIWE client calls
│   │   ├── context/               # SessionContext — the sign-in state machine
│   │   ├── components/              # Modal shell, connector picker, onboarding form
│   │   └── pages/                     # AdminPage (only reachable with role == 1)
│   └── test/                            # Validation unit tests
├── firebase/                  # Firestore rules, Cloud Functions, their tests
│   ├── functions/                # getSiweNonce + verifySiweSignature
│   └── test/                       # Firestore rules tests (18, via emulator)
└── README.md
```

## Prerequisites

- Node.js ≥ 20.19 (frontend), Node 22 (functions — matches the deployed runtime)
- npm
- [Firebase CLI](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`) —
  only needed if you're redeploying rules/functions or running emulators, not for
  ordinary frontend work
- Java — only needed to run the Firestore rules test suite locally, which boots its
  own emulator
- A browser wallet (MetaMask is the simplest) with Arbitrum Sepolia testnet ETH from
  a faucet, for deploying/interacting with the QFT contract

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/0xMeePok/smu-qc-dao-project.git
cd smu-qc-dao-project
```

### 2. Connect to Firebase

The Firestore database and both Cloud Functions are already deployed — you don't set
up your own project. See **[Connect to Firebase](#connect-to-firebase)** below for
what you need from the project owner.

### 3. Install and run the frontend

```bash
cd frontend
cp .env.example .env.local
# fill in VITE_FIREBASE_API_KEY, VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_APP_ID
npm install
npm run dev
```

Open the URL Vite prints (`http://localhost:5173` by default).

### 4. (Optional) Deploy the QFT token

```bash
cd contracts/qft-tokens
cp .env.example .env
# fill in ARBITRUM_SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY, QFT_INITIAL_SUPPLY
npm install
npm run deploy:arbitrum-sepolia
```

See [`contracts/qft-tokens/README.md`](contracts/qft-tokens/README.md) for details —
the token has a fixed supply, no mint or burn, and is not yet deployed to a live
address.

## Connect to Firebase

Firestore, Authentication, and both Cloud Functions are already deployed to the
project's Firebase backend. You only need the client config:

1. Ask Ashley for the six `VITE_FIREBASE_*` values (or get them yourself
   from the Firebase console.  — Project settings → General → Your apps → Web app).
2. ```bash
   cd frontend
   cp .env.example .env.local
   # paste in the six values
   npm install && npm run dev
   ```

That's it — sign-in talks straight to the shared backend.

If you're changing `firestore.rules` or `firebase/functions/index.js` yourself and
need to redeploy, or want to run everything against local emulators instead, see
[`firebase/README.md`](firebase/README.md).

## Smart Contracts

| Contract | Address (Arbitrum Sepolia) | Purpose |
|---|---|---|
| [`QFT.sol`](contracts/qft-tokens/contracts/QFT.sol) | Not yet deployed | Fixed-supply ERC-20 distributed for platform activity |

## Testing

```bash
npm test --prefix frontend      # 18 tests — validation rules, default role, whole-form checks
npm test --prefix firebase      # 18 tests — Firestore rules, via a local emulator (needs Java)
npm test --prefix firebase/functions   # 7 tests — adversarial signature verification
```

The functions tests need the Functions emulator running, or `FUNCTIONS_BASE_URL`
pointed at a live deployment — see [`firebase/README.md`](firebase/README.md).

## Current implementation status

Implemented: wallet sign-in with server-verified signatures, onboarding (name +
organisation), a two-level access model (normal user / administrator, granted by
hand), an admin-only page shell, and the Firestore schema for user profiles including
placeholder contribution counters (`comments`, `businessProblems`, `openFunding`,
`fundingRequests`, `karma`, `reputation` — all currently `0`, nothing increments them
yet).

## Team

| Name | Role |
|---|---|
| Ashley Chung Beng Hunn | Product Owner |
| Anthony Chew Jian Yee | Scrum Master |
| Daryl Yeo Yao Hong | Full Stack Developer |
| Lim Jun Wei | Full Stack Developer |

## Course Context

Developed as part of IS483, Singapore Management University, under the guidance of
Professor Paul Griffin.

## License

[Placeholder: e.g. MIT License]
