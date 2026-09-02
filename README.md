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
the account. Ensure you have MetaMask or Rabby installed.

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
│   ├── audit-registry/      # Workflow hash registry, Hardhat project, Arbitrum Sepolia
│   ├── qft-tokens/          # QFT ERC-20 (fixed supply), Hardhat project, Arbitrum Sepolia
│   └── stable-faucet/       # Test token faucet deployment
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
  ordinary frontend work against the live backend
- Java — needed by the Firestore emulator (local emulators **and** the rules test suite)
- A browser wallet (MetaMask is the simplest) with Arbitrum Sepolia testnet ETH from
  a faucet, for deploying/interacting with the QFT contract

## Getting Started

Do these **in order**. GitHub Actions installs packages for you; your laptop does not.
Starting the emulators or `npm run dev` on a fresh clone without step 2 fails with
`Cannot find module 'firebase-functions'` (or a missing Vite/React install).

### 1. Clone the repository

```bash
git clone https://github.com/0xMeePok/smu-qc-dao-project.git
cd smu-qc-dao-project
```

### 2. Install dependencies (first, once, from the repo root)

There is no root `package.json`. Each folder below is its own npm package — install
all three before anything else:

```bash
npm install --prefix firebase
npm install --prefix firebase/functions
npm install --prefix frontend
```

Re-run these only after a clean clone, a deleted `node_modules`, or a change to a
`package.json` / lockfile.

### 3. Frontend env

```bash
cp frontend/.env.example frontend/.env.local
```

Fill in `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`, and
`VITE_FIREBASE_APP_ID` (ask Ashley, or copy from Firebase console — see
[Connect to Firebase](#connect-to-firebase)).

To talk to production instead of **local emulators**, else ignore:

```
VITE_FIREBASE_USE_EMULATORS=false
```


Use the same project id in `.env.local` as you pass to `--project` in step 4
(the shared project is `qcdao-a0c7a`). Without the emulator flag, `npm run dev`
hits the live Firebase project.

### 4. Run locally (emulators first, then the app)

Two terminals. Start the emulators **before** the frontend.

**Terminal 1 — Firebase emulators**

```bash
cd firebase
npx firebase emulators:start --only functions,firestore,auth,storage --project qcdao-a0c7a
```

Wait until you see `All emulators ready` **and** the functions loaded
(`getSiweNonce`, `verifySiweSignature`). If you see `Cannot find module
'firebase-functions'`, go back to step 2.

Emulator UI: http://127.0.0.1:4000

**Terminal 2 — frontend**

```bash
cd frontend
npm run dev
```

App: http://localhost:5173/

To skip emulators and use the shared production backend, omit
`VITE_FIREBASE_USE_EMULATORS=true` and only run terminal 2.

### 5. (Optional) Deploy the QFT token

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
2. Follow [Getting Started](#getting-started) steps 2–4. For production (no
   emulators), `VITE_FIREBASE_USE_EMULATORS` will need to be changed to false and only run the frontend.

That's it — sign-in talks straight to the shared backend unless emulators are on.

If you're changing `firestore.rules` or `firebase/functions/index.js` yourself and
need to redeploy, or want more detail on local emulators, see
[`firebase/README.md`](firebase/README.md).

## Documentation Reference

- [Role-to-Route Permission Matrix (ROLE_ROUTE_PERMISSIONS.md)](docs/ROLE_ROUTE_PERMISSIONS.md): Complete RBAC reference for all five platform roles (Problem Owner, Researcher, Evaluator, Funder, DAO Admin), detailing route permissions and opportunity creation rules.
- [Audit Registry Integration](docs/AUDIT_REGISTRY_INTEGRATION.md): Hash format, transaction states, frontend configuration, and contract replacement workflow.

## Smart Contracts

| Contract | Address (Arbitrum Sepolia) | Purpose |
|---|---|---|
| [`AuditRegistry.sol`](contracts/audit-registry/contracts/AuditRegistry.sol) | [`0xd119C050E51e7012B4Dea180c3e4F2727F354447`](https://sepolia.arbiscan.io/address/0xd119C050E51e7012B4Dea180c3e4F2727F354447#code) | Anchors opportunity, proposal, and evaluation hashes. Deployed in block `304637649`. |
| [`QFT.sol`](contracts/qft-tokens/contracts/QFT.sol) | Not yet deployed | Fixed-supply ERC-20 distributed for platform activity |

## Testing

```bash
npm test --prefix frontend            # 73 tests — validation, roles, routing, idle session
npm test --prefix firebase            # 78 tests — Firestore rules, via a local emulator (needs Java)
npm test --prefix firebase/functions  # 25 tests — adversarial signature verification
```

Each suite boots and tears down whatever emulator it needs, so no manual setup is
required — see [`firebase/README.md`](firebase/README.md). Still run step 2 of
[Getting Started](#getting-started) first, or the functions suite cannot find
`firebase-functions` / `firebase-tools`.

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
test-frontend ─────────────────────────────────────────────────────┘
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

## Pull request security review

Every non-draft pull request is reviewed by Fireworks AI's GLM-5.3 model. The
workflow scans only the changed diff and creates or updates a single PR comment with
concrete, actionable security findings. Repository maintainers must add the
`FIREWORKS_API_KEY` Actions secret once before the workflow can run.

See [`docs/AI_SECURITY_REVIEW.md`](docs/AI_SECURITY_REVIEW.md) for setup, security
boundaries, cost controls, and the later switch from Fireworks AI to OpenAI.

## Current implementation status

Implemented: wallet sign-in with server-verified signatures, onboarding (name +
organisation), a multi-role access control model and admin audit capabilities, an
admin-only page shell, and the Firestore schema for user profiles — split into a
private `users` record and a minimal public `publicProfiles` record — including
placeholder contribution counters (`comments`, `businessProblems`, `openFunding`,
`fundingRequests`, `karma`, `reputation`).

## Team

| Name | Role |
|---|---|---|
| Ashley Chung Beng Hunn | Product Owner |
| Anthony Chew Jian Yee | Scrum Master |
| Daryl Yeo Yao Hong | Full Stack Developer |
| Lim Jun Wei | Full Stack Developer |

## Course Context

Developed as part of IS483, Singapore Management University, under the guidance of
Professor Paul Griffin.

## License

[Placeholder: e.g. MIT License]
