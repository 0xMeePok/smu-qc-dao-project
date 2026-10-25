# Environment variables

Every env file below is git-ignored. Only the `.env.example` files are committed.

## Frontend (`frontend/.env.local` or `frontend/.env`)

Every `VITE_` value is bundled into the public JavaScript. None of them may be a secret.

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_FIREBASE_API_KEY` | Yes | Web app config |
| `VITE_FIREBASE_PROJECT_ID` | Yes | Web app config. Must match `--project` when using emulators |
| `VITE_FIREBASE_APP_ID` | Yes | Web app config |
| `VITE_FIREBASE_STORAGE_BUCKET` | For attachments | Without it, the attachment UI reports that Storage is not configured |
| `VITE_FIREBASE_APP_CHECK_SITE_KEY` | Production | reCAPTCHA Enterprise site key registered with App Check. Ignored with emulators |
| `VITE_PRIVY_APP_ID` | Yes | Public Privy app id. Sign-in is impossible without it |
| `VITE_FIREBASE_USE_EMULATORS` | No | `true` connects to the local emulators. Set it to `false` explicitly for production builds |
| `VITE_ARBITRUM_SEPOLIA_RPC_URL` | No | Preferred RPC for browser reads |
| `VITE_ARBITRUM_SEPOLIA_RPC_BACKUP_URLS` | No | Comma-separated list or JSON array of fallback RPCs. Public defaults are always added |
| `VITE_AUDIT_REGISTRY_ADDRESS` | No | Overrides the registry address. Leave blank to use the manifest |

`VITE_FIREBASE_AUTH_DOMAIN` and `VITE_FIREBASE_MESSAGING_SENDER_ID` are not used. `VITE_WALLETCONNECT_PROJECT_ID` is obsolete.

## Cloud Functions (`firebase/functions/.env`, `.env.<project-id>`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `PRIVY_APP_ID` | Yes, when deployed | Public Privy app id. In the emulator it is read from the frontend env file instead |
| `ARBITRUM_SEPOLIA_RPC_URL` | Yes, when deployed | Primary RPC for receipt checks and platform transactions. CI fails without it |
| `ARBITRUM_SEPOLIA_RPC_BACKUP_URLS` | No | Comma-separated fallback RPCs |
| `ADMIN_BOOTSTRAP_EMAILS` | No | Comma-separated emails granted administrator on sign-in |
| `ATTACHMENT_SWEEP_ENABLED` | No | `true` lets `sweepAttachments` delete files. Dry run otherwise |
| `AUDIT_REGISTRY_ADDRESS` | No | Overrides the registry address. Must match the frontend |

Firebase loads `.env` first, then `.env.<project-id>`. A shell variable is not part of the deployed runtime.

## Cloud Functions secrets (Secret Manager)

| Secret | Purpose | Local equivalent |
| --- | --- | --- |
| `PRIVY_SECRET` | Privy app secret for verifying access tokens | `firebase/functions/.secret.local` |
| `ESCROW_PLATFORM_PRIVATE_KEY` | Platform signer for escrow settlement and cancellation | None. Do not use it locally |

Set them with `npx firebase functions:secrets:set <NAME> --project <project-id>` and redeploy.

## Contracts (`contracts/<package>/.env`)

| Variable | Packages | Purpose |
| --- | --- | --- |
| `ARBITRUM_SEPOLIA_RPC_URL` | All | RPC for deploys and verification |
| `ARBITRUM_SEPOLIA_FALLBACK_RPC_URL` | `audit-registry`, `qft-tokens` | Read-only fallback after a broadcast |
| `DEPLOYER_PRIVATE_KEY` | All | Testnet deployer. Never a key with mainnet funds |
| `ETHERSCAN_API_KEY` | All except `stable-faucet` | Source verification through the Etherscan API v2 |
| `ESCROW_OWNER_ADDRESS`, `ESCROW_PLATFORM_SIGNER_ADDRESS` | `funding-escrow` | Factory owner and platform signer for a new deployment |
| `ESCROW_TOKEN_ADDRESSES`, `ESCROW_FEE_BPS` | `funding-escrow` | Allowed tokens and fee (10 = 0.1%) |
| `ESCROW_NEW_REGISTRY_ACK` | `funding-escrow` | Must be `true` to deploy a new registry, as a reminder that it needs an app migration |
| `QFT_INITIAL_SUPPLY`, `QFT_INITIAL_HOLDER` | `qft-tokens` | Fixed supply and who receives it |

## Faucet (Vercel project settings)

| Variable | Purpose |
| --- | --- |
| `ARBITRUM_SEPOLIA_RPC_URL` | RPC for minting |
| `FAUCET_PRIVATE_KEY` | Owner of the mock token contracts. Mark as sensitive |
| `XSGD_TOKEN_ADDRESS`, `USDT_TOKEN_ADDRESS`, `USDC_TOKEN_ADDRESS` | The mock tokens |

## GitHub Actions

See [GitHub Actions](../setup/github-actions.md) for the full list of repository secrets and variables.
