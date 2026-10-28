# QC DAO Frontend

Vite + React app. Sign-in is email-only, through Privy's login modal: the one-time code
it sends unlocks the member's embedded wallet. The server then verifies Privy's access
token and mints the Firebase session for that wallet's address. See the root
[README](../README.md) for how that works.

## Run locally

Firestore, Auth, Storage and all Cloud Functions are already deployed. Ask the
project owner for the `VITE_FIREBASE_*` values and `VITE_PRIVY_APP_ID` rather than
setting up your own project.

```bash
cp .env.example .env.local
# paste in the values you were given
npm install
npm run dev
```

The app will not start Firebase without `VITE_FIREBASE_API_KEY`,
`VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID` — see `.env.example` for which
fields are required versus optional, and why.

## Tests

```bash
npm test
```

The suite does not need an emulator or network. It does need `firebase/functions`
installed (`npm install --prefix ../firebase/functions`), because the hashing,
escrow and status modules are shared with the Cloud Functions.

## Main business-problem funding

Business problems retain one winner and pooled funding, independently of grant
calls. A proposal must be fully funded before the problem owner selects it.
Selection starts a full seven-day handshake and pauses funding of every other
proposal for that problem. Both the problem owner and proposal owner must approve
before the platform releases the first 50%.

Either owner can reject the unpaid selection. Rejection or seven-day expiry
immediately enables fee-free refund claims for the selected proposal's funders
and reopens the other proposals. Funders claim their own tokens; opening refunds
does not automatically transfer tokens to every wallet. The rejected or expired
escrow stays closed. After the first payment, the winner is permanent and the
other proposals become refundable.

The remaining 50% requires submitted delivery evidence and fresh approval from
both owners. If the proposal chose funder voting, contributions representing
strictly more than 50% of total deposited funding must also vote yes. A tie does
not pass. Submission and replacement of evidence reset approvals and votes.

The new rejection control and full seven-day window require the updated
contracts. Existing deployment manifests are preserved, and the frontend and
backend retain their historical contract compatibility.

With the local Firestore emulator described below running, repeat the real
contract/backend test from the repository root:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/main-funding-e2e.mjs
```

This uses an isolated EVM and demo Firestore project, canonical posting/proposal
receipts, real token transfers and the production settlement worker with its
signed durable transaction outbox. It checks both payment modes, sibling locks,
both rejection roles, complete refunds, scheduler expiry and approval after a
short posting deadline. The [saved validation results](../docs/testing/main-funding-validation.json)
record the run and separate grant regression coverage. Browser wallet interaction
is outside this test; frontend component tests cover the corresponding controls.

## Funder dashboard and open funding grants (QCDAO-94)

The **Funding** dashboard lists your open funding calls, confirmed proposal
commitments, approaches and recorded decisions. Committed, locked, released and
refunded totals use exact token amounts grouped by token. Available pool balances
are separate from proposal commitments. **Manage funding**, **View escrow** and
**Audit receipt** open the corresponding opportunity, funding tab or receipt.

Open funding is a single-owner grant pool, separate from pooled problem funding:

1. Publish the call, choose **Deposit grant funds**, create its pool and deposit
   tokens from the owner wallet.
2. Researchers submit proposals using that token, with a requested amount and
   payment plan. The owner can select several proposals while the pool covers
   their combined reservations.
3. Each selected researcher has a full seven days to accept, including when the
   call closes during that window. Acceptance transfers the requested amount
   into its proposal escrow and records both owners' upfront approvals.
4. Existing escrow settlement handles the upfront payment and later delivery
   approval. Other proposals remain independently eligible for grants.
5. The owner can top up after awards or after submissions close. An expired offer
   rejects acceptance immediately; **Void expired offer** releases its reserved
   funds through a permissionless transaction.
6. After the call closes, the owner can withdraw its unreserved funds. Pending
   grants remain reserved until accepted or voided.

Grant controls are enabled on the current deployment (2026-10-17), because its
synced manifest includes the grant pool ABI (`escrow.openFundingPoolAbi`) and the
factory's `createOpenFundingPool`. A future registry or factory switch must keep
both in the manifest synced with `npm run sync:audit-registry`, or the controls
switch off. Deploy the backend callables, Firestore rules and indexes with the
frontend.

Before switching the active manifest, preserve the current deployment in its
history and arrange continued settlement of any unfinished pooled escrows.
Historical mode supports refund/expiry actions but disables further milestone
approvals and releases; changing the active registry needs a continuation plan.

For the reusable contract/backend/Firestore integration test, compile the
contracts and start a local Firestore emulator:

```bash
# From the repository root
npm --prefix contracts/funding-escrow run compile
cd firebase
npx firebase emulators:start --only firestore --project demo-open-funding
```

Then, in another terminal at the repository root:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/open-funding-e2e.mjs
```

The test creates fresh local wallets and an isolated demo project. It exercises
posting/proposal publication, a 100,000 pool funding two 50,000 proposals,
researcher acceptance, milestone payments, top-ups, role checks, seven-day
expiry and acceptance after the posting deadline. It also checks the grant
summary and funder dashboard. No testnet funds or deployed contracts are used.
Frontend component tests cover wallet gating, exact token approvals, two chain
confirmations, closed-call withdrawals and recovery of an existing transaction
without rebroadcasting it. Browser layout QA also uses wallet/API fixtures.

The 1 October 2026 Chrome/MetaMask run, made before the move to Privy sign-in, used the actual frontend, SIWE sign-in,
Firebase emulators and a verified local contract deployment. It published a
100,000 USDC call and two 50,000 USDC proposals, deposited 100,000 mock USDC,
selected both proposals and added another 10,000. The confirmed pool had 110,000
deposited, 100,000 reserved and 10,000 available; both acceptance windows measured
exactly 604,800 seconds from their selection events. The
[captured evidence](../docs/testing/open-funding-wallet-evidence.json) includes
receipts, deployment verification, contract events and token balances.

That browser run stopped before acceptance when the temporary local servers
terminated and their in-memory chain state was lost. Browser acceptance,
settlement and withdrawal are therefore unverified by that run; the real
contract/backend/Firestore suite covers acceptance, payments, expiry and top-ups,
and component tests cover withdrawal. The original MetaMask RPC and selected
account were restored. No shared testnet deployment was changed.

Published opportunities use the shared countdown. Owners choose or extend a live
deadline by 30, 60, 90, or 180 days.

The pipeline in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
runs the same `npm test` when `frontend/` changes, so a new test file in the existing folders fails **CI** and blocks the deploy.

## Build

```bash
npm run build
```
Preview the production build locally:

```bash
npm run preview
```

## Source layout

```
src/
├── lib/            # Firebase/Privy setup, validation, email sign-in, roles, stats,
│                  #   profile.js (writes users/ + publicProfiles/ in one batch)
├── context/         # WalletContext (Privy + embedded wallet), SessionContext — the
│                    #   Privy login -> verified -> onboarding/signed-in state machine
├── components/      # 81 components: sign-in and onboarding, wallet, forms, escrow, dashboards, audit, moderation, admin
├── pages/            # 14 route-level pages, lazily loaded (AdminPage needs role == 1)
├── App.jsx            # Hash router, marketplace pages, top bar
└── main.jsx             # PrivyProvider -> QueryClientProvider -> WalletProvider -> SessionProvider -> App
```

## Proposal submission (QCDAO-59 / QCDAO-60)

Open a posting in Discover and choose **Submit a proposal**. Funded problems use
an approach form; open funding calls additionally require a proposed problem,
its relevance and fit with the funder's thesis. Submitted records appear in
**My Proposals** and in the sponsor's **Proposals received** section. Authors can
withdraw and submit a replacement while the opportunity remains open.

Submissions are saved before wallet anchoring starts. Receipts support retrying a
failed anchor or resuming a known transaction without broadcasting it again.
The current posting flow creates revision 0; proposal anchors reference that
initial revision. Future posting-revision work must extend this linkage.

Deploy the updated `firebase/firestore.rules` and `firebase/storage.rules`
alongside the frontend. Submission uses an atomic per-author slot at
`problems/{postingId}/proposalAuthors/{uid}` and private supporting PDFs under
`proposals/{uid}/{proposalId}/`. Submitted content and PDF bytes remain immutable;
withdrawal preserves the original record. No new composite indexes are required.
