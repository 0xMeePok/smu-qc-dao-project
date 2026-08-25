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

| Layer | Technology | Description |
|---|---|---|
| Frontend | React 18, Vite 6, Vanilla CSS | Single-page application with role-based routing and zero UI framework dependencies. |
| Backend / Off-chain Data | Firebase (Firestore, Auth, Storage) | Off-chain data store for user profiles, proposal drafts, and review feedback. |
| Smart Contracts | Solidity (0.8.28), Arbitrum Sepolia | Verifiable audit log and hash anchoring (Chain ID: `421614`). |
| Contract Tooling | Hardhat, Etherscan API v2 | Local testing, deployment pipelines, and automated Arbiscan verification. |
| Wallet Integration | ethers.js / Web3 Provider | Wallet connectivity and cryptographic audit signing. |

## Architecture

```
User -> Web App (React + Vite) -> Firebase (off-chain profiles, briefs, proposals)
                                -> Smart Contract (Arbitrum Sepolia: hashes, timestamps, audit events)
```

## Project Structure

```
smu-qc-dao-project/
├── contracts/
│   └── qft-tokens/         # Solidity contracts, Hardhat configuration, deploy scripts
├── frontend/               # React frontend application
│   ├── src/
│   │   ├── components/     # RouteGuard, AccessDenied (403), Login, and role dashboards
│   │   ├── config/         # Role definitions, route permissions, feature flags
│   │   ├── context/        # AuthContext and session state management
│   │   ├── App.jsx         # Main application shell and dynamic routing
│   │   └── styles.css      # Core design system and styles
│   ├── package.json
│   └── vite.config.js
├── docs/                   # Documentation and permission matrices
│   └── ROLE_ROUTE_PERMISSIONS.md  # Living UAT reference for role-based access control
├── .gitignore
└── README.md
```

## Prerequisites

- Node.js v20.19.0 or higher
- npm v10 or higher
- MetaMask wallet configured with Arbitrum Sepolia testnet (Chain ID `421614`)
- Arbitrum Sepolia testnet ETH (for contract deployment and audit transactions)

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/0xMeePok/smu-qc-dao-project.git
cd smu-qc-dao-project
```

### 2. Run the frontend application

```bash
cd frontend
npm install
npm run dev
```

The web application will start at `http://localhost:5173/`.

- **Standard Mode**: `http://localhost:5173/` (production layout, standard login form).
- **Demo Mode**: `http://localhost:5173/?demo=true` (enables the bottom demo role-switcher toolbar and one-click persona selector for grading demonstrations).

### 3. Deploy and test smart contracts

```bash
cd ../contracts/qft-tokens
npm install
```

Configure your `.env` from `.env.example` with your Arbitrum Sepolia RPC URL and private key, then run:

```bash
npm run deploy:arbitrum-sepolia
```

## Documentation Reference

- [Role-to-Route Permission Matrix (ROLE_ROUTE_PERMISSIONS.md)](docs/ROLE_ROUTE_PERMISSIONS.md): Complete RBAC reference for all five platform roles (Problem Owner, Researcher, Evaluator, Funder, DAO Admin), detailing route permissions, opportunity creation rules, and demo mode specifications.

## Team

| Name | Role |
|---|---|
| [Placeholder] | [Placeholder] |

## Course Context

Developed as part of [Placeholder: e.g. IS483, Singapore Management University], under the guidance of [Placeholder: e.g. Prof Paul Griffin].

## License

[Placeholder: e.g. MIT License]
