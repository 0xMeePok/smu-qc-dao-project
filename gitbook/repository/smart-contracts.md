# Smart contracts

All contracts are Solidity 0.8.28 Hardhat 3 projects under `contracts/`, deployed to Arbitrum Sepolia (chain `421614`). Each folder is its own npm package with its own `.env.example`. Never use a key that controls mainnet funds.

## Packages

| Package | Contracts | Purpose |
| --- | --- | --- |
| `audit-registry` | `AuditRegistry.sol`, `AuditRegistryExtensible.sol` | The original hash registry for postings and proposals. Its source is kept byte-for-byte so old deployments still verify. The extensible copy is the base for the escrow-linked registry |
| `funding-escrow` | `EscrowAuditRegistry.sol`, `FundingEscrowFactory.sol`, `FundingEscrow.sol`, `FundingEscrowDeployer.sol`, `OpenFundingPool.sol`, `OpenFundingPoolDeployer.sol`, `IndependentFundingFactory.sol`, `IndependentFundingEscrow.sol`, `FundingAmountPolicy.sol`, `TokenDecimals.sol` and type files | The active registry and every escrow type |
| `qft-tokens` | `QFT.sol` | Fixed-supply ERC-20 reward token, minted once to an initial holder. No mint or burn after deployment |
| `stable-faucet` | `MockFaucetToken.sol` | Six-decimal mock XSGD, USDT and USDC, plus the Vercel faucet site in `site/` |

## What each active contract does

| Contract | Responsibility |
| --- | --- |
| `EscrowAuditRegistry` | Records opportunity and proposal hashes, revisions, withdrawals and audit events. Every proposal committed through it receives a canonical escrow in the same transaction (`commitProposalWithEscrow`). Also records moderation pauses and the accepted-proposal binding |
| `FundingEscrowFactory` | Canonical list of escrows, token allow-list, fee setting, owner and platform signer. Creates proposal escrows and open funding pools through the two deployer contracts |
| `FundingEscrow` | One proposal's pooled deposits, milestone payments, approvals, optional funder votes and refunds |
| `OpenFundingPool` | A funder's prefunded grant pool. Reserves funds for selected proposals and moves them into proposal escrows on acceptance |
| `IndependentFundingFactory` and `IndependentFundingEscrow` | Crowdfunding for independent researcher listings, separate from proposal selection and grant pools |
| `FundingAmountPolicy` | Each contribution must be at least one whole token and must not leave less than one whole token outstanding |
| `MockFaucetToken` | Owner-only `faucetMint` of 10,000 tokens per claim, one-hour cooldown per recipient, cap of one billion tokens |

Addresses for the active and older deployments are in [Contract addresses](../reference/contract-addresses.md).

## How records are anchored

* Off-chain records are serialised as canonical JSON version 1 (sorted keys, NFC strings, safe integers, typed dates and bytes) and hashed with `keccak256`. The implementation is `firebase/functions/auditCanonical.js`, used by both browser and server.
* Entity ids are also `keccak256` hashes, domain-separated with `qcdao.audit.entity`, the entity type and the Firestore record id. Under entity id scheme 2 the actor's address is part of the id, so nobody can claim another person's record id first.
* Opportunity kinds: `0` business problem, `1` open funding call, `2` independent listing.
* A proposal stores two hashes: one over the proposal fields and one over the methodology and attachments, including each PDF's SHA-256 digest. The registry anchors `keccak256(abi.encode(proposalHash, solutionHash))`.
* Golden test vectors stop accidental changes. If a hashing rule must change, add a new scheme version rather than editing the old one.

Evaluator comments, scores and owner reviews are never anchored.

## Escrow rules in the application

The contracts support more options than the app uses. The app fixes these settings:

| Setting | Value in the app |
| --- | --- |
| Payment plan | Two tranches, 50% upfront and 50% on completion (`trancheBps: [5000, 5000]`) |
| Funding target | The proposal's requested amount. Deposits cannot exceed it |
| Selection | Only a fully funded proposal can be selected by the problem owner |
| Approval window | Seven days from selection for both owners to approve the upfront payment |
| Completion | Delivery evidence plus approval from both owners. Optionally, yes votes from funders holding strictly more than 50% of deposits |
| Platform fee | 10 basis points (0.1%) of each payout. Deposits and refunds are free |
| Refunds | Pull-based: each funder calls `claimRefund` for their own share once a refund opens |
| Custody lock | Deposits cannot be withdrawn before the posting expires unless a refund opens earlier |

Payout steps that need the platform are sent by the platform signer from Cloud Functions, never by an administrator's browser. A Firebase administrator role alone cannot authorise a payment.

## Keys

| Key | Where it lives | Used for |
| --- | --- | --- |
| Deployer key | Local `.env` of the person deploying | Deploying and wiring contracts |
| Platform signer key | Secret Manager as `ESCROW_PLATFORM_PRIVATE_KEY` | Settlement, administrator cancellation and moderation voids |
| Faucet key | Vercel environment variable `FAUCET_PRIVATE_KEY` | Minting mock tokens |

On the active deployment the owner, fee recipient and platform signer are the same address, `0x1c608C148F64Fb9657bA4e5fB8992345277371C0`. Whoever holds that key controls the fee setting and the token allow-list, so plan its handover with the sponsor.

## Common commands

Run these inside the package folder after `npm install` and filling in `.env`.

| Package | Command | What it does |
| --- | --- | --- |
| any | `npm run compile` | Compile |
| any | `npm test` | Run the tests on a local Hardhat chain |
| `funding-escrow` | `npm run coverage` | Tests with coverage, as CI runs them |
| `funding-escrow` | `npm run test:verifier` | Tests for the read-only deployment verifier |
| `funding-escrow` | `npm run deploy:arbitrum-sepolia` | Deploy a new registry and factory. Needs `ESCROW_OWNER_ADDRESS`, `ESCROW_PLATFORM_SIGNER_ADDRESS`, `ESCROW_TOKEN_ADDRESSES`, `ESCROW_FEE_BPS` and `ESCROW_NEW_REGISTRY_ACK=true` |
| `funding-escrow` | `npm run verify:arbitrum-sepolia -- --deployment=deployments/<file>.json` | Read-only check of runtime bytecode, wiring, owners and fee |
| `funding-escrow` | `npm run verify:source` | Publish source to the explorer for an existing deployment |
| `funding-escrow` | `npm run export:abis` | Export the ABI bundle used by the app |
| `audit-registry` | `npm run verify:arbitrum-sepolia` | Verify the active manifest's deployment |
| `qft-tokens` | `npm run deploy:arbitrum-sepolia` | Deploy QFT. Needs `QFT_INITIAL_SUPPLY` and `QFT_INITIAL_HOLDER` |
| `stable-faucet` | `ALLOW_REDEPLOY=true npm run deploy:faucet` | Replace the mock tokens. Avoid this: escrows and the app use the current token addresses |

Independent crowdfunding has its own deploy script: `INDEPENDENT_FUNDING_NEW_FACTORY_ACK=true npx hardhat run scripts/deploy-independent.js --build-profile production --network arbitrumSepolia`.

## Switching the app to a new deployment

A new registry is not a migration. Existing records stay in the old registry's namespace.

1. Deploy and run the read-only verifier on the new deployment record.
2. Copy the outgoing configuration into `firebase/functions/auditRegistry.history.json` so existing receipts keep verifying.
3. Update `contracts/audit-registry/manifests/arbitrumSepolia.json`, then run `npm run sync:audit-registry` in `frontend/`. This rewrites both the frontend and functions manifests.
4. Remove any `VITE_AUDIT_REGISTRY_ADDRESS` or `AUDIT_REGISTRY_ADDRESS` override.
5. Plan how unfinished escrows on the old deployment will settle, because historical mode allows refunds and expiry but not new milestone approvals.
6. Deploy rules, indexes and functions, then Hosting.

The longer write-ups are `docs/ESCROW_REGISTRY_INTEGRATION.md`, `docs/AUDIT_REGISTRY_INTEGRATION.md`, `docs/registry-cutover.md` and `contracts/funding-escrow/README.md`.
