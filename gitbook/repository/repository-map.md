# Repository map

The repository is a set of separate npm packages in one Git repository. There is no workspace tool: each folder with a `package.json` installs and tests on its own.

```
smu-qc-dao-project/
├── frontend/                 React + Vite web app
│   ├── src/                  App code (pages, components, lib, config, context, hooks)
│   ├── test/                 Unit, integration, component and accessibility tests
│   ├── scripts/              Dev seeding, Privy build guard, contract manifest sync
│   └── vite.config.js        Builds into ../firebase/public
├── firebase/                 Everything deployed to the Firebase project
│   ├── functions/            Cloud Functions source (Node 22) and their tests
│   ├── test/                 Firestore and Storage rules tests
│   ├── scripts/              CSP checks, preview deploys, Privy deploy preflight
│   ├── maintenance/          Lock-down rules used during a registry cutover
│   ├── firestore.rules       Database authorisation
│   ├── firestore.indexes.json  83 composite indexes
│   ├── storage.rules         Attachment authorisation
│   ├── storage.cors.json     Bucket CORS allow-list
│   ├── storage.lifecycle.json  Aborts stale uploads after a day
│   ├── firebase.json         Hosting headers, emulator ports, deploy targets
│   ├── deploy.sh             One-shot setup for a brand-new project
│   └── MOCK_MATCHING.md      Older off-chain matching workflow
├── contracts/                Solidity packages, each a Hardhat 3 project
│   ├── audit-registry/       Original AuditRegistry and its extensible copy
│   ├── funding-escrow/       EscrowAuditRegistry, escrow factory, grant pools, independent funding
│   ├── qft-tokens/           QFT ERC-20 token (fixed supply)
│   └── stable-faucet/        Mock XSGD, USDT, USDC tokens and the Vercel faucet site
├── docs/                     Deep-dive design notes, setup notes and test evidence
├── gitbook/                  This handover book, synced to GitBook
├── scripts/                  End-to-end funding tests and the shared test reporter
├── .github/
│   ├── workflows/            ci.yml (checks and deploy) and ai-security-review.yml
│   ├── actions/setup-workspace/  Shared Node and Java setup for ci.yml
│   └── scripts/              AI security review and its test
├── .superdesign/             Design exploration files and the brand mark
├── package.json              Root dev dependency (axe-core) only
├── .gitleaks.toml            Secret-scan configuration
├── .gitleaksignore           Reviewed false positives, such as public deployment records
└── README.md                 Quick start for developers
```

## Package boundaries

| Package | Install | Test | Notes |
| --- | --- | --- | --- |
| `frontend` | `npm install --prefix frontend` | `npm test --prefix frontend` | Also needs `firebase/functions` installed, because it imports shared modules from there |
| `firebase` | `npm install --prefix firebase` | `npm test --prefix firebase` | Rules tests, needs Java |
| `firebase/functions` | `npm install --prefix firebase/functions` | `npm test --prefix firebase/functions` | Starts its own emulators |
| `contracts/audit-registry` | `npm install` in the folder | `npm test` | Local Hardhat chain only |
| `contracts/funding-escrow` | `npm install` in the folder | `npm test` | Depends on `audit-registry` through a `file:` link |
| `contracts/qft-tokens` | `npm install` in the folder | `npm test` | No test files yet |
| `contracts/stable-faucet` | `npm install` in the folder and in `site/` | `npm test`, then `npm test --prefix site` | Includes a real EIP-7702 test |

## Where to change what

| To change | Edit | Then also |
| --- | --- | --- |
| A page or screen | `frontend/src/pages/` or `frontend/src/components/` | Component tests in `frontend/test/components/` |
| Who can open a route | `frontend/src/config/routes.js` | `docs/ROLE_ROUTE_PERMISSIONS.md` and `frontend/test/routeAccess.test.js` |
| What a member may read or write | `firebase/firestore.rules` | Rules tests in `firebase/test/`, deploy rules before the frontend |
| A server action or privileged read | `firebase/functions/*.js`, exported from `index.js` | Functions tests, the callable list in [Cloud Functions](../reference/cloud-functions.md) |
| A new query | `firebase/firestore.indexes.json` | Deploy indexes with the functions |
| How a record is hashed | `firebase/functions/auditCanonical.js` and the payload modules | Golden vectors in the tests. Old hashes must not change |
| Workflow status labels | `firebase/functions/workflowStatus.js` | `frontend/test/unit/workflow-status.test.js` |
| A contract | `contracts/<package>/contracts/` | Contract tests, a new deployment and a manifest sync |
| Active contract addresses | `contracts/audit-registry/manifests/arbitrumSepolia.json`, then `npm run sync:audit-registry` in `frontend/` | Deploy functions and Hosting together |
| Security headers | `firebase/firebase.json` | `node firebase/scripts/check-csp.mjs` after release |
| CI or deploy | `.github/workflows/ci.yml` and `.github/actions/setup-workspace/` | [CI/CD and quality checks](ci-cd.md) |
| This book | `gitbook/` | Nothing else. Book-only pushes skip the deploy |

## Files you should not commit

`.gitignore` already covers these. Check before adding new ones.

* Any `.env`, `.env.local` or `.env.<project-id>` file, and `firebase/functions/.secret.local`
* `firebase/.firebaserc`
* `firebase/public/`, the Vite build output
* `firebase/firebase.local.json`, generated for the Hosting emulator
* Hardhat `artifacts/`, `cache/` and local `deployments/` folders in `qft-tokens`, `stable-faucet` and `audit-registry`
