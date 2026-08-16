# SMU QC DAO

A blockchain-enabled Proof of Concept platform for coordinating quantum and quantum-adjacent solution funding workflows across organisations. The platform allows problem owners and funders to post problem statements, researchers to submit proposals, and evaluators to review submissions through a shared web application.

## Overview

The solution uses a hybrid architecture:

- **Firebase** stores off-chain application data, including user profiles, problem statements, proposal content, evaluation records, and workflow status.
- **Smart contracts** deployed on **Arbitrum Sepolia** store only verification hashes, timestamps, and key audit events such as proposal submissions, evaluation outcomes, and funding decisions.

This creates an immutable audit trail for events that may be disputed across institutions, while keeping sensitive proposal content off-chain.

## Features

- [Placeholder: e.g. Problem statement posting by problem owners/funders]
- [Placeholder: e.g. Proposal submission by researchers]
- [Placeholder: e.g. Evaluation workflow for expert evaluators]
- [Placeholder: e.g. On-chain audit trail via Arbitrum Sepolia]

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | [Placeholder: e.g. React / Next.js] |
| Backend / Off-chain data | Firebase (Firestore, Auth, Storage) |
| Smart Contracts | Solidity, deployed on Arbitrum Sepolia |
| Contract Tooling | [Placeholder: e.g. Hardhat / Foundry] |
| Wallet Integration | [Placeholder: e.g. MetaMask / wagmi / ethers.js] |

## Architecture

```
[Placeholder: architecture diagram or description]

User → Web App → Firebase (off-chain data)
                → Smart Contract (Arbitrum Sepolia) — hashes, timestamps, audit events
```

## Project Structure

```
smu-qc-dao-project/
├── contracts/          # [Placeholder: Solidity smart contracts]
├── frontend/            # [Placeholder: Web application source]
├── firebase/             # [Placeholder: Firebase config, functions, security rules]
├── scripts/               # [Placeholder: Deployment/utility scripts]
├── test/                   # [Placeholder: Contract and application tests]
├── docs/                   # [Placeholder: Additional documentation]
└── README.md
```

## Prerequisites

- [Placeholder: e.g. Node.js v18+]
- [Placeholder: e.g. npm / yarn / pnpm]
- [Placeholder: e.g. Firebase CLI]
- [Placeholder: e.g. MetaMask wallet with Arbitrum Sepolia testnet configured]
- [Placeholder: e.g. Arbitrum Sepolia testnet ETH (from a faucet)]

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/[Placeholder: org]/smu-qc-dao-project.git
cd smu-qc-dao-project
```

### 2. Install dependencies

```bash
[Placeholder: e.g. npm install]
```

### 3. Configure environment variables

Create a `.env` file in the root directory:

```
[Placeholder: e.g. FIREBASE_API_KEY=]
[Placeholder: e.g. FIREBASE_PROJECT_ID=]
[Placeholder: e.g. ARBITRUM_SEPOLIA_RPC_URL=]
[Placeholder: e.g. PRIVATE_KEY=]
[Placeholder: e.g. CONTRACT_ADDRESS=]
```

### 4. Deploy smart contracts (if not already deployed)

```bash
[Placeholder: e.g. npx hardhat run scripts/deploy.js --network arbitrumSepolia]
```

### 5. Run the application locally

```bash
[Placeholder: e.g. npm run dev]
```

The app should now be running at `[Placeholder: e.g. http://localhost:3000]`.

## Smart Contracts

| Contract | Address (Arbitrum Sepolia) | Purpose |
|---|---|---|
| [Placeholder: e.g. QCDAORegistry.sol] | [Placeholder: 0x...] | [Placeholder: e.g. Stores verification hashes and audit events] |

## Testing

```bash
[Placeholder: e.g. npx hardhat test]
[Placeholder: e.g. npm run test]
```

## Team

| Name | Role |
|---|---|
| [Placeholder] | [Placeholder] |

## Course Context

Developed as part of [Placeholder: e.g. IS483, Singapore Management University], under the guidance of [Placeholder: e.g. Prof Paul Griffin].

## License

[Placeholder: e.g. MIT License]
