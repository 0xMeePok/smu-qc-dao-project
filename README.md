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
                                        creates the profile as a normal user, writing
                                        users/{address} and publicProfiles/{address}
                                        in one batch
```

Profiles are stored across two collections. `users/{address}` holds the full record —
including `role` — and is readable only by the wallet that owns it.
`publicProfiles/{address}` holds just `address`, `fullName` and `organisation`, and is
readable by anyone so published work can be attributed. Neither can be listed, so the
user base cannot be enumerated and nothing reveals which wallets are administrators.

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

## Tech Stack

| Layer | Technology | Description |
|---|---|---|
| Frontend | React 18, Vite 6, Vanilla CSS | Single-page application with role-based routing and zero UI framework dependencies. |
| Backend / Off-chain Data | Firebase (Firestore, Auth, Storage) | Off-chain data store for user profiles, proposal drafts, and review feedback. |
| Smart Contracts | Solidity (0.8.28), Arbitrum Sepolia | Verifiable audit log and hash anchoring (Chain ID: `421614`). |
| Contract Tooling | Hardhat, Etherscan API v2 | Local testing, deployment pipelines, and automated Arbiscan verification. |
| Wallet Integration | wagmi / viem / Web3 Provider | Wallet connectivity and cryptographic audit signing. |

## Project Structure

```
smu-qc-dao-project/
├── contracts/
│   └── qft-tokens/          # QFT ERC-20 (fixed supply), Hardhat project, Arbitrum Sepolia
├── frontend/                # Vite + React app — wallet sign-in, marketplace pages, RBAC
│   ├── src/
│   │   ├── components/      # Modals, role views, RouteGuard, and UI components
│   │   ├── config/          # Role definitions, route permissions, feature flags
│   │   ├── context/         # AuthContext and SessionContext state machines
│   │   ├── lib/             # Firebase/wagmi setup, validation, SIWE client calls
│   │   ├── pages/           # AdminPage (only reachable with role == 1)
│   │   ├── App.jsx          # Main application shell and dynamic routing
│   │   └── styles.css       # Core design system and styles
│   └── test/                # Unit and integration test suites
├── firebase/                # Firestore rules, Cloud Functions, their tests
│   ├── functions/           # getSiweNonce + verifySiweSignature
│   └── test/                # Firestore rules tests (78, via emulator)
├── docs/                    # Architecture and RBAC documentation
│   └── ROLE_ROUTE_PERMISSIONS.md  # Living UAT reference for role-based access control
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

The web application will start at `http://localhost:5173/`.

- **Standard Mode**: `http://localhost:5173/` (production layout, standard wallet login).

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
   from the Firebase console: Project settings → General → Your apps → Web app).
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

## Documentation Reference

- [Role-to-Route Permission Matrix (ROLE_ROUTE_PERMISSIONS.md)](docs/ROLE_ROUTE_PERMISSIONS.md): Complete RBAC reference for all five platform roles (Problem Owner, Researcher, Evaluator, Funder, DAO Admin), detailing route permissions and opportunity creation rules.

## Smart Contracts

| Contract | Address (Arbitrum Sepolia) | Purpose |
|---|---|---|
| [`QFT.sol`](contracts/qft-tokens/contracts/QFT.sol) | Not yet deployed | Fixed-supply ERC-20 distributed for platform activity |

## Testing

```bash
npm test --prefix frontend            # 73 tests — validation, roles, routing, idle session
npm test --prefix firebase            # 78 tests — Firestore rules, via a local emulator (needs Java)
npm test --prefix firebase/functions  # 25 tests — adversarial signature verification
```

Each suite boots and tears down whatever emulator it needs, so no manual setup is
required — see [`firebase/README.md`](firebase/README.md).

Run everything in one go:

```bash
npm test --prefix frontend && npm test --prefix firebase && npm test --prefix firebase/functions
```

If a suite fails to start with a port error, an emulator is already running from
another terminal — stop it first (`pkill -f "firebase.*emulators"`), since each suite
starts its own.

## Deployment

Pushing to `main` deploys automatically via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):

```
test-backend  (Cloud Functions) ──┐
                                  ├──→ deploy-backend ──→ deploy-hosting
test-rules    (Firestore rules) ──┘                            ↑
test-frontend ─────────────────────────────────────────────────┘
```

The backend deploys **before** hosting, and hosting waits for it. That order is
required, not cosmetic: `createProfile()` writes to `publicProfiles/{address}`, and
until `firestore.rules` declares that collection the catch-all rule denies it — so a
frontend released ahead of its rules breaks onboarding for every new user.

Live site: **https://qcdao-a0c7a.web.app**

To deploy by hand (same order the pipeline uses):

```bash
cd firebase && npx firebase deploy --only firestore:rules,firestore:indexes,functions --project qcdao-a0c7a
npm run build --prefix frontend && (cd firebase && npx firebase deploy --only hosting --project qcdao-a0c7a)
```

To try a change on a real URL without touching the live site, deploy a preview
channel — see [`firebase/README.md`](firebase/README.md#preview-channels).

## Current implementation status

Implemented: wallet sign-in with server-verified signatures, onboarding (name +
organisation), a multi-role access control model and admin audit capabilities, an
admin-only page shell, and the Firestore schema for user profiles — split into a
private `users` record and a minimal public `publicProfiles` record — including
placeholder contribution counters (`comments`, `businessProblems`, `openFunding`,
`fundingRequests`, `karma`, `reputation`).

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
