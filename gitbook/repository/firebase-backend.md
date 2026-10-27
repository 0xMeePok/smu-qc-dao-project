# Firebase backend

Everything deployed to the Firebase project lives in `firebase/`: security rules, indexes, Hosting settings and the Cloud Functions source. The live project is `qcdao-a0c7a` in `asia-southeast1`.

## Configuration files

| File | What it controls |
| --- | --- |
| `firebase.json` | Rules and index files, the Storage bucket, the functions source, Hosting headers and rewrites, and emulator ports |
| `firestore.rules` | Who may read or write each Firestore document (about 1,800 lines) |
| `firestore.indexes.json` | 83 composite indexes and one field override |
| `storage.rules` | Attachment uploads and downloads |
| `storage.cors.json` | Origins allowed to call the bucket from a browser. Production origins only, no `localhost` |
| `storage.lifecycle.json` | Aborts incomplete uploads after one day |
| `.firebaserc.example` | Copy to `.firebaserc` (git-ignored) and set the project id |
| `firebase.maintenance.json`, `maintenance/` | Locked-down rules used only during a registry cutover |
| `deploy.sh` | One-shot setup for a brand-new project: creates the database in `asia-southeast1`, then deploys rules, indexes and functions |

### Hosting

Hosting serves `firebase/public`, the Vite build output. Every path except `/assets/**` rewrites to `index.html`. Hashed assets are cached for a year, and the HTML is never cached.

The `Content-Security-Policy` header is strict. It lists each Google endpoint, the reCAPTCHA scripts, the Arbitrum Sepolia RPCs and Privy's `auth.privy.io` and `arbitrum-sepolia.rpc.privy.systems` by name. Any new external service, such as a CAPTCHA provider or a new RPC, must be added there or the browser blocks it. CI adds the configured RPC origins with `firebase/scripts/configure-rpc-csp.mjs` before building, and checks the live header after deploying with `firebase/scripts/check-csp.mjs`.

### Emulator ports

| Emulator | Port |
| --- | --- |
| Auth | 9099 |
| Firestore | 8080 |
| Functions | 5001 |
| Storage | 9199 |
| Hosting (only with `npm run emulate`) | 5000 |
| Emulator UI | 4000 |

## Cloud Functions

The source is `firebase/functions/`, an ES module package on Node 22. `index.js` creates the Admin SDK app and exports all 94 functions. Larger areas register their functions from their own module, for example `registerEscrowFundingFunctions()` in `escrowFundingFunctions.js`.

| Type | Count | Notes |
| --- | --- | --- |
| Callable (`onCall`) | 70 | Called from the browser with `httpsCallable`. Most use `MEMBER_CALL_OPTIONS`: region `asia-southeast1`, at most five instances, and App Check enforced outside the emulator |
| Firestore triggers | 17 | Projections, audit queues, edit trails, moderation screening and notifications |
| Scheduled | 7 | See [Scheduled jobs](#scheduled-jobs) |

Every callable checks the caller itself. `requireMember` refuses callers who are signed out, not yet onboarded, suspended or signed in before a session revocation, and refuses everyone while a registry cutover is in progress. Admin callables also require access level 1.

### Functions by area

| Area | Main modules | Functions |
| --- | --- | --- |
| Sign-in and accounts | `privySession.js`, `privyAccount.js`, `adminActions.js` | `exchangePrivySession`, `stampPrivyIdentity`, `revokeOwnSessions`, `adminListUsers`, `adminChangeRole`, `adminSetSuspended` |
| Publication and on-chain audit | `publication.js`, `auditCanonical.js`, `opportunityAuditPayload.js`, `proposalAuditPayload.js`, `proposalAuditQueue.js`, `proposalAuditRecovery.js`, `auditReceipt.js`, `auditDeployments.js`, `auditTrail.js` | `attestPublication`, `queueProposalAudit`, `confirmProposalAudit`, `retryPendingProposalAudits`, `recordProposalEdit`, `recordOpportunityEdit`, `listAuditTrail`, `adminListProposalAudits`, `adminVerifyProposalAudit`, `adminRetryProposalAudit` |
| Postings, expiry and attachments | `opportunityExpiry.js`, `opportunityExpiryService.js`, `opportunityMetrics.js`, `resourceQuotas.js`, `attachmentSweeper.js` | `lapseExpiredOpportunities`, `adminForceExpireOpportunity`, three `sync*Metrics` triggers, `reserveResource`, `reserveAttachment`, `removeAttachment`, `sweepAttachments` |
| Proposals, reviews and comments | `proposalQueues.js`, `proposalComparison.js`, `ownerReviews.js`, `comments.js`, `independentProposalCatalog.js`, `ownerDashboard.js` | `listMyProposalQueue`, `listEvaluatorQueue`, `listActionItems`, `listOwnerDashboard`, `getProposalComparison`, `listIndependentListings`, `recordOwnerReview`, `listOwnerReviews`, `createComment`, `editComment`, `deleteComment` |
| Funding approaches | `fundingApproach.js`, `fundingApproachAnchor.js` | `createFundingApproach`, `listFundingApproaches`, `getFundingApproach`, `decideFundingApproach`, `recordFundingApproachAnchor`, `recordFundingApproachDecisionAnchors` |
| Proposal escrow | `escrowFunding*.js`, `escrowCustody.js`, `escrowAudit.js`, `escrowAdminCancellation.js`, `escrowModerationVoid.js`, `escrowProposalTerms.js`, `escrowRefund*.js`, `fundingSnapshots.js`, `postingEscrowProgress.js` | `prepareEscrowDeposit`, `syncEscrowFunding`, `startEscrowSettlement`, `startEscrowAdminCancellation`, `reconcileEscrowFunding` and eleven more |
| Open funding grants | `openFunding.js`, `openFundingFunctions.js`, `funderDashboard.js` | `getOpenFundingSummary`, `prepareOpenFundingAction`, `syncOpenFunding`, `getFunderDashboard` |
| Independent crowdfunding | `independentFunding*.js` | `getIndependentFundingState`, `prepareIndependentFundingAction`, `syncIndependentFunding` |
| Moderation | `moderation.js`, `moderationFunctions.js`, `moderationAnchor.js` | Eight callables including `submitContentReport` and `moderateContent`, three `screen*Content` triggers, `listRemovedProblems`, `readRemovedProblem`, `listPostedProposals` |
| Mock matching and notices | `matching.js`, `matchingNotifications.js` | Eight mock matching callables, `expireMockMatchingWindows`, `notifyMatchingEvent`, `resumeMatchingNotificationDelivery`, `remindNearingApprovalWindows` |
| Admin overview | `adminActivity.js`, `platformStatus.js`, `proposalExport.js` | `adminGetActivitySummary`, `adminGetPlatformStatus`, `adminExportSelectedProposals` |
| Wallet | `walletFaucetFunctions.js` | `claimWalletTokens`, which relays a signed faucet request to the Vercel faucet |

The full list with one line per function is in [Cloud Functions](../reference/cloud-functions.md).

### Shared modules

Some modules are imported by both the functions and the frontend, so both sides hash and label records identically: `auditCanonical.js`, `opportunityAuditPayload.js`, `proposalAuditPayload.js`, `escrowProposalTerms.js`, `escrowAudit.js`, `escrowCustody.js`, `auditDeployments.js`, `rpcPolicy.js`, `opportunityExpiry.js`, `workflowStatus.js` and others. Keep them free of Node-only APIs and change them with care: an edit to a hashing module can make every existing receipt fail verification. Golden vectors in the tests guard against that.

### Contract configuration

| File | Purpose |
| --- | --- |
| `auditRegistry.contract.json` | Active registry address, chain, ABIs, escrow factory, token list and grant pool ABI. Kept identical to `frontend/src/config/auditRegistry.contract.json` |
| `auditRegistry.history.json` | Earlier deployments that existing records may still need for verification |
| `independentFunding.contract.json` | Independent crowdfunding factory and its settings |
| `escrowRegistry.abis.json` | ABI bundle used by the escrow services |

## Scheduled jobs

| Function | Schedule | What it does |
| --- | --- | --- |
| `retryPendingProposalAudits` | Every minute | Confirms up to 25 pending proposal audit jobs, with back-off |
| `lapseExpiredOpportunities` | Every minute | Marks postings past their deadline as expired and hands off refunds |
| `reconcileEscrowFunding` | Every minute | Reconciles escrow events and sends queued platform transactions. Uses `ESCROW_PLATFORM_PRIVATE_KEY` |
| `resumeMatchingNotificationDelivery` | Every minute | Retries notification delivery |
| `remindNearingApprovalWindows` | Every 5 minutes | Reminds owners whose approval window is closing |
| `expireMockMatchingWindows` | Every 5 minutes | Closes expired windows in the legacy mock matching flow |
| `sweepAttachments` | Daily at 03:00 Singapore time | Deletes unreferenced PDFs older than 24 hours. Dry run unless `ATTACHMENT_SWEEP_ENABLED=true` |

## Runtime configuration

| Name | Kind | Required | Purpose |
| --- | --- | --- | --- |
| `PRIVY_SECRET` | Secret Manager | Yes | Verifies Privy access tokens in `exchangePrivySession` |
| `ESCROW_PLATFORM_PRIVATE_KEY` | Secret Manager | Yes, for escrow | Platform signer for settlement, cancellation and moderation voids. Its address must match the factory's platform signer |
| `PRIVY_APP_ID` | Functions `.env` | Yes | The public Privy app id. CI writes it from `VITE_PRIVY_APP_ID` |
| `ARBITRUM_SEPOLIA_RPC_URL` | Functions `.env` | Yes | Primary RPC for receipt checks and platform transactions |
| `ARBITRUM_SEPOLIA_RPC_BACKUP_URLS` | Functions `.env` | No | Comma-separated fallback RPCs |
| `ADMIN_BOOTSTRAP_EMAILS` | Functions `.env` | No | Emails granted administrator on sign-in |
| `ATTACHMENT_SWEEP_ENABLED` | Functions `.env` | No | `true` lets the sweeper delete files |
| `AUDIT_REGISTRY_ADDRESS` | Functions `.env` | No | Overrides the registry address. Must match the frontend |

Firebase loads `functions/.env` and then `functions/.env.<project-id>` at deploy time. Both are git-ignored. In the emulator, `PRIVY_APP_ID` is read from `frontend/.env.local` or `frontend/.env`, and the secret from `functions/.secret.local`.

## Security rules in brief

* A member can create and read only their own `users/{address}` document. `role`, `email`, `privyUserId`, `stats` and timestamps cannot be set by the client.
* `publicProfiles/{address}` carries only name, organisation, biography and expertise. Nobody can list it, so the member directory cannot be enumerated.
* A published posting or proposal must match a server-written `publicationProofs` entry, so nothing reaches Firestore without its on-chain anchor.
* Drafts are private to their author. Published content is immutable apart from the documented correction and withdrawal paths.
* Server-owned collections, such as audit jobs, escrow jobs and projections, have no client access at all.
* Suspended accounts and sessions older than `sessionRevocations/{address}` are refused everywhere, including Storage.

Storage objects live at `problems/{ownerId}/{problemId}/{file}.pdf` and `proposals/{ownerId}/{proposalId}/{file}.pdf`. Uploads are PDF only, up to 10 MB, owner only, and cannot be overwritten. Any signed-in member can download. Downloads use `getBlob()`, so every read is checked by the rules.

The detailed field-level schema is in `docs/FIRESTORE_WORKFLOW_SCHEMA.md` and `firebase/README.md`. A summary of every collection is in [Firestore collections](../reference/firestore-collections.md).

## Scripts

| Script | Purpose |
| --- | --- |
| `firebase/scripts/check-csp.mjs <url>` | Reads the live Content-Security-Policy, with retries while the CDN updates |
| `firebase/scripts/configure-rpc-csp.mjs` | Adds the configured RPC origins to the CSP before a CI build |
| `firebase/scripts/check-privy-deploy.mjs <project-id>` | Fails a deploy early if the functions env lacks a valid `PRIVY_APP_ID` |
| `firebase/scripts/local-hosting-config.mjs` | Generates `firebase.local.json` so the Hosting emulator can reach the other emulators |
| `firebase/scripts/preview-deploy.mjs` | Builds and deploys a Hosting preview channel, optionally with the backend |
| `functions/scripts/mock_data.mjs` | Seeds sample postings into the emulator (`npm run seed`) |
| `functions/scripts/reset-dev-data.mjs` | Deletes all Firestore data, Storage objects and Auth users. Dry run by default |
| `functions/scripts/backfill-metrics.mjs`, `backfill-escrow-progress.mjs` | Rebuild projections after a schema change |
| `functions/scripts/retire-registry.mjs` | Archives records of a retired registry during a maintenance window |

## npm scripts

| Folder | Command | Purpose |
| --- | --- | --- |
| `firebase/` | `npm test` | Firestore and Storage rules tests in the emulator |
| `firebase/` | `npm run emulate` | Build the frontend for the emulators and serve it on the Hosting emulator |
| `firebase/` | `npm run deploy:rules` | Deploy Firestore and Storage rules |
| `firebase/` | `npm run deploy:preview` | Deploy a preview channel. Add `-- --backend` to also deploy rules, indexes and functions |
| `firebase/functions/` | `npm test` | Functions tests with their own emulators |
| `firebase/functions/` | `npm run serve` | Start the emulators |
| `firebase/functions/` | `npm run seed`, `npm run reset` | Seed or reset development data |
