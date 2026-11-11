# Technology stack

Versions are the ones pinned in the `package.json` files at `main` @ `a634f09c`. Rechecked on 11 November 2026. A caret (`^`) means npm may install a newer minor version.

## Frontend (`frontend/`)

| Technology | Version | Used for |
| --- | --- | --- |
| React | 18.3.1 | UI components |
| Vite with `@vitejs/plugin-react` | 7.3.7, 5.2.0 | Dev server and production build into `firebase/public` |
| Plain CSS | n/a | One stylesheet, `src/styles.css`, with light and dark themes. No UI framework |
| Hash router (own code) | n/a | Routes such as `#/discover`, defined in `src/config/routes.js` |
| TanStack React Query | ^5.102.2 | Caching and refreshing server data |
| Firebase JS SDK | 12.19.0 | Auth, Firestore, callable Functions, Storage and App Check |
| Privy React SDK (`@privy-io/react-auth`) | ^3.51.2 | Email login modal, embedded wallet, sponsored transactions |
| viem | ^2.57.8 | Contract reads, ABI encoding and the RPC failover client |
| Node.js | 20.19 or newer | Required by Vite 7 |

Testing uses Node's built-in test runner, Vitest 3.2.4, Testing Library 16.3.0, jsdom 26.1.0 and axe-core for accessibility checks.

## Backend (`firebase/`)

| Technology | Version | Used for |
| --- | --- | --- |
| Cloud Functions for Firebase, second generation (`firebase-functions`) | 7.4.0 | 77 callable, 18 Firestore-triggered, 7 scheduled and 1 HTTPS function |
| Node.js runtime | 22 | Set in `firebase/functions/package.json` |
| Firebase Admin SDK | 14.5.0 | Firestore, Auth custom tokens and Storage from the server |
| Privy server SDK (`@privy-io/node`) | 0.35.0 | Verifying access tokens and reading a user's wallet |
| viem | 2.55.19 | Reading receipts and contract state, signing platform transactions |
| Cloud Firestore | n/a | Main database, `asia-southeast1` |
| Cloud Storage for Firebase | n/a | PDF attachments, bucket `qcdao-a0c7a.firebasestorage.app` |
| Firebase Authentication | n/a | Sessions from custom tokens |
| Firebase App Check with reCAPTCHA Enterprise | n/a | Attests callable function requests from the real web app |
| Firebase Hosting | n/a | Serves the web app with security headers |
| Firebase CLI (`firebase-tools`) | 15.35.0 | Emulators, deploys and preview channels, installed per package |
| Firebase rules unit testing | 5.0.2 | Firestore and Storage rules tests against the emulator |
| Java | 17 in CI | Required by the Firestore emulator |

## Google Cloud services behind Firebase

| Service | Used for |
| --- | --- |
| Cloud Run, Cloud Build and Artifact Registry | Run and build second-generation functions |
| Eventarc | Delivers Firestore events to the 18 triggered functions |
| Cloud Scheduler | Runs the seven scheduled functions |
| Secret Manager | `PRIVY_SECRET`, `ESCROW_PLATFORM_PRIVATE_KEY` and `OPENAI_API_KEY` |
| reCAPTCHA Enterprise | Site key used by App Check |
| IAM | Deploy service account for GitHub Actions, runtime service accounts |

## Blockchain (`contracts/`)

| Technology | Version | Used for |
| --- | --- | --- |
| Solidity | 0.8.28 | All contracts |
| Hardhat | 3.13.0 | Compile, test, deploy and verify |
| ethers | 6.17.0 | Deploy and verification scripts |
| OpenZeppelin Contracts | 5.6.1 | `ERC20`, `SafeERC20`, `Ownable`, `Ownable2Step`, `ReentrancyGuard` |
| Mocha and Chai | 11.8.0, 6.2.2 | Contract tests |
| Arbitrum Sepolia | chain `421614` | Layer 2 testnet for low-cost transactions |
| Node.js | 22.13 or newer | Required by `contracts/funding-escrow` |

## Wallets and gas

| Technology | Used for |
| --- | --- |
| Privy embedded wallets | One EVM wallet per email, created on first sign-in, key held in Privy's trusted execution environment |
| EIP-7702 | Upgrades the embedded wallet in place so it can use sponsorship, without changing its address |
| ERC-4337 bundler and paymaster (Privy) | Sends sponsored transactions so members need no ETH |

## Delivery and quality tooling

| Tool | Used for |
| --- | --- |
| GitHub Actions | CI on pull requests and deploy on pushes to `main` |
| Semgrep Community Edition | Static analysis for JavaScript, React, Node, Solidity and OWASP rules |
| Gitleaks 8.30.1 | Secret scanning on every push |
| Fireworks AI (`glm-5p3-flash` by default) | Advisory AI security review comment on pull requests |
| Vercel | Hosts the test-token faucet site and its API |
| Superdesign | Design exploration files in `.superdesign/` |
| GitBook | This handover book, synced from `gitbook/` |

## Why these choices

* **Firebase and Vite** keep the team on managed services and a fast build, which the proposal chose to limit delivery risk for a four-person team.
* **Arbitrum Sepolia** is a Layer 2 testnet, so transactions are cheap and no real funds are at risk. Only hashes and escrow events go on-chain.
* **Privy email sign-in** replaced MetaMask in Sprint 5 so that people on locked-down institutional laptops, and people new to crypto, can take part without a browser wallet or ETH.
* **Testnet mock stablecoins** let the escrow be demonstrated end to end without custody of real money.
