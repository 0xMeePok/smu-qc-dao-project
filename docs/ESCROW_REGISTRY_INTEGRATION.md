# Escrow-linked registry verification

This branch implements **QCDAO-110, QCDAO-113 and QCDAO-117**. The accepted-proposal
binding and reversible moderation pause require a fresh linked registry/factory
deployment. The addresses below remain the last confirmed deployment until that
replacement is verified and its manifest is synchronized. Backend/Hosting rollout
also requires the platform signing secret and the matching generated configuration.

The contracts are deployed on Arbitrum Sepolia (chain 421614). The **local**
frontend and Firebase manifests select this deployment, and the local frontend now
includes wallet-backed funding, owner approvals, optional funder voting, payments
and refunds. This application work has not deployed Hosting, Cloud Functions or
rules, changed live records, or run a new signed live transaction flow.

| Setting | Deployed value |
| --- | --- |
| EscrowAuditRegistry | `0xb901B23382322090A1Ea7bC6b8a9d2D422e855FD` |
| FundingEscrowFactory | `0xe5d212491E544694d21c51EF9777F71B32fc5D41` |
| Owner, fee recipient and platform signer | `0x1c608C148F64Fb9657bA4e5fB8992345277371C0` |
| Initial fee | 10 BPS = 0.1%, charged only on payouts |

The confirmed deployment record is
[`contracts/audit-registry/manifests/arbitrumSepolia.json`](../contracts/audit-registry/manifests/arbitrumSepolia.json).
The previous scheme-2 deployment and ABI are preserved under
[`contracts/audit-registry/legacy/pre-escrow-arbitrumSepolia.contract.json`](../contracts/audit-registry/legacy/pre-escrow-arbitrumSepolia.contract.json)
and its adjacent `.deployment.json` file. No historical records were migrated or retired.

## Proposal creation and verification

With an `EscrowAuditRegistry` manifest selected, every application proposal uses
**50% upfront and 50% on completion** (`trancheBps: [5000, 5000]`). The split is
read-only in the form and enforced by shared term validation, server publication
attestation and Firestore submission/correction rules. Historical records keep
their original deployment and verification path. No existing proposal dataset
is cleared or automatically migrated during rollout.

The full funding target must be deposited into escrow before the upfront half
can be released, after both the problem owner and proposal owner approve selection.
The proposal owner submits delivery evidence and confirms completion for the final
half. The problem owner must accept that evidence as delivered. The proposal chooses
one of two immutable completion approval variants before funding:

- **Both owners:** evidence plus approval from the proposal owner and problem owner.
- **Both owners and funders:** the same requirements, plus yes votes representing
  strictly more than 50% of all contributed funds. Each wallet's cumulative funding
  is its voting weight. Exactly 50% fails, and abstentions do not lower the threshold.

The default variant is both owners. Replacing evidence resets owner approvals and
funder votes. Each payment is subject to the configured platform fee, with any token
rounding remainder in the final payment. Review windows accept one whole-day value
for both payments or two values (upfront, final), each 1–365 days; the default is seven
days. The first window is capped by the contract at seven days and the posting
deadline. The final window starts with the upfront payout, so it must allow time
for delivery and acceptance. Missing that final deadline opens refunds of the
unpaid balance. If the upfront approval window lapses, the original posting expiry
still governs when ordinary refunds become available.

Drafts retain unfinished inputs in `fundingPlan`. Submission resolves the configured
token address and decimals, produces exact integer base units, and stores the six
contract fields in `fundingTerms`. The target is a decimal integer string so it is
safe to persist in Firestore. The existing proposal amount field remains a number
with its existing 1,000,000,000 limit; the form rejects conversions that would lose
precision. This UI limit does not reduce the contract's uint256 accounting range.
Small amounts are restored to plain decimal input when a draft or submitted
proposal is reopened without scientific notation. Two token base units are the
minimum total needed to fund both halves; each payment must be nonzero.

Each milestone description hash binds the proposal's complete milestones text and
its tranche index under `qcdao.escrow.milestone.v1`. The amount, token, milestone
text, payment percentages, review windows and voting setting are fixed when the
proposal is created. An unfunded proposal can still amend other content; the
contract freezes all proposal edits once funding begins.

The browser submits `commitProposalWithEscrow`, preserving the expected parent
revision before the funding tuple. Firebase independently checks the mined call,
researcher, registry, chain, canonical block and confirmations. It then verifies:

- The registry/factory references in both directions and both proposal-to-escrow mappings.
- The escrow's posting/proposal IDs, owners, token, token decimals, target and voting setting.
- The escrow's registry/factory references, expiry, tranche count, ratios, windows,
  description hashes and exact cumulative-floor gross amounts.

An amendment through `updateHashes` must retain the same escrow terms. Confirmation
also rechecks the stored funding-terms hash before writing its result, so a change
during the RPC reads cannot receive a stale confirmation. The frontend reports a
known escrow mismatch as a mismatch, and network failures remain unverified.
Verification describes record/term integrity, not milestone completion or approval
to spend funds. Historical content can remain verifiable after payments or refunds.

The deployed legacy registry keeps its previous commit path and canonical content
hashes. Never pair its address with the new contract ABI.

## Wallet funding and delivery

Open an escrow proposal and choose **Open escrow**, or its **Match & funding** tab.
The panel reads the canonical escrow through both registry and factory mappings,
verifies its immutable terms and current proposal hashes, and loads balances,
approvals, votes and the connected wallet's refund at one block. The displayed
state refreshes periodically and after confirmed transactions. Proposal and posting
edit checks read on-chain funding rather than simulated matching balances.

Connect the wallet for the signed-in account on Arbitrum Sepolia to act:

1. **Funders** enter an exact token amount up to the remaining target. The wallet
   reuses a sufficient allowance; otherwise it approves the entered amount, first
   clearing an insufficient nonzero allowance when needed, then deposits. Each
   transaction is confirmed before the next step. Repeated deposits add to the
   same wallet's contribution.
2. At full funding, the **problem owner** requests selection. The backend verifies
   ownership, posting eligibility and the canonical escrow, then the configured
   platform signer starts upfront approval.
   The **problem owner and proposal owner** each approve from their own wallets.
   The platform relay then automatically executes the approved upfront 50% payment.
3. The **proposal owner** saves and submits delivery evidence, then separately
   confirms completion. The **problem owner** reviews the same evidence and accepts
   it as delivered. When funder voting is enabled, contributing wallets also vote;
   yes votes must represent strictly more than half of all deposited units.
4. The **platform relay** executes the final 50% payment only after those gates
   pass. Funders can open eligible expiry/withdrawal refunds and claim their own
   unpaid share through the same panel.

Roles come from on-chain wallet addresses and contributions. A Firebase
administrator role alone does not authorize a platform payment. The platform
signer's server key is bound to the settlement functions through Secret Manager as
`ESCROW_PLATFORM_PRIVATE_KEY`. It must never appear in frontend configuration,
deployment manifests or Git. The on-chain platform wallet can still execute an
already-approved payment directly as an operational fallback.

The service re-reads verified state before each requested action and binds final
approvals, votes and payments to the reviewed evidence hash. A transaction with an
unknown confirmation result exposes **Retry confirmation**, which checks the known
hash without rebroadcasting the write. Further actions remain disabled while that
transaction is unresolved. Broadcast hashes are saved per proposal, deployment and
wallet in session storage, so navigation or reloading the same tab preserves
confirmation recovery. If browser storage is unavailable, recovery lasts only for
the current page session. Moderated proposals that the viewer can still access
retain the escrow panel and refund actions while other wallet actions are paused.

Opportunity funding and comparison rows link escrow proposals to this panel and
display **On-chain escrow** instead of simulated balances. Evaluator comparison
remains advisory. Mock selection/funding controls and mock portfolio views are not
used for escrow proposals; Functions also reject escrow proposals at mock mutation
boundaries. The current wallet view is per proposal, not a cross-proposal portfolio.

### Delivery evidence persistence

Before requesting the wallet's `submitMilestone` transaction, the frontend saves
an immutable document at `proposals/{proposalId}/deliveryEvidence/{evidenceHash}`
with exactly `summary`, `url`, `ownerId` and server-generated `createdAt`. The author
must own a published escrow proposal. Reads follow the parent proposal's access
rules, including moderation and parent opportunity visibility. Updates and deletes
are denied; a duplicate save succeeds in the client only if the existing author
and content match exactly.

The hash is Keccak-256 of UTF-8 JSON in this exact field order:

```js
{ scheme: "qcdao.escrow.delivery.v1", summary, url }
```

The summary is trimmed and NFC-normalized, with 2–4,000 characters. The required
HTTPS URL is trimmed only, with at most 2,048 characters; it is not reserialized or
Unicode-normalized. The panel recomputes the digest when loading the saved evidence
and compares it with the on-chain hash. Missing or mismatched content disables
completion approval, voting and final release in the UI while balances and refund
actions remain available. Replacing evidence requires a new document/hash and
resets both owner approvals and funder votes. The hash binds the summary and URL;
reviewers must still assess the linked material, whose remote content can change.

## Verify a confirmed deployment

In `contracts/funding-escrow`, using Node 22.13 or newer:

```sh
npm run compile -- --build-profile production
npm run test:verifier
npm run verify:arbitrum-sepolia -- --deployment=deployments/arbitrumSepolia-TIMESTAMP.json
```

The deployment script now records the contract name, entity ID scheme, confirmed
registry/factory/wiring states, and token symbols/decimals. The read-only verifier
checks the Arbitrum Sepolia chain, compiled runtime code, consistent repeated
immutable slots, mutual wiring and platform signer. It reports current owners and
fee BPS, allowing legitimate fee/ownership changes after deployment. It does not
submit a transaction. Compile without coverage instrumentation before comparing
runtime bytecode.

The existing command in `contracts/audit-registry` also accepts `--deployment` and
dispatches linked records to the new verifier. Its default now checks the active
escrow deployment recorded in `manifests/arbitrumSepolia.json`.

## Prepare the application switch

The local switch has been applied. From the repository root, regenerate a preview
from the confirmed active deployment if needed:

```sh
node frontend/scripts/sync-audit-registry.mjs \
  --deployment=contracts/audit-registry/manifests/arbitrumSepolia.json \
  --output=/tmp/escrow-registry-preview.json
```

The sync tool automatically selects the linked registry artifact and includes the
factory/escrow ABIs and token metadata. It rejects incomplete wiring, a mismatched
chain/address, ambiguous token symbols, and unsupported token precision. Removing
`--output` writes the same manifest to both frontend and Firebase. Remove conflicting
`VITE_AUDIT_REGISTRY_ADDRESS` / `AUDIT_REGISTRY_ADDRESS` overrides when switching;
the linked deployment requires its configured address to agree everywhere.

For testing before publication, use the Firebase emulators with
`VITE_FIREBASE_USE_EMULATORS=true` and the updated local Functions. The wallet and
verification RPC still use real Arbitrum Sepolia. A local frontend connected to the
unchanged live Functions cannot publish escrow-linked proposals: that server still
uses its prior registry configuration. Follow the existing Firebase setup in the
root README; keep the deployer key out of all `VITE_*` variables and browser code.

Deploy the matching Functions, Firestore rules and rebuilt frontend together as
part of the planned registry cutover. This includes the mock-action guards and
the `deliveryEvidence` rules, not only the registry manifests. An updated frontend
against old rules cannot persist delivery evidence, and old Functions do not
provide the escrow routing markers or server-side mock-action guards. Existing records remain in their original
registry namespace; switching a manifest is not a migration. Preserve their audit
history and agree on their handling before enabling a new namespace. The earlier
[registry cutover notes](registry-cutover.md) document the existing retirement
mechanism; this change does not run it or authorize retiring additional records.

The configured token catalog must retain the address and decimals of tokens used
by existing proposals. Add newly listed token metadata deliberately; do not remap
an existing currency symbol to a different address. The current form's currency
choices remain the existing USDC/USDT/XSGD choices. On-chain token delisting still
blocks new funding while preserving exits from existing escrows.

The current scope is QCDAO-110, QCDAO-113 and QCDAO-117. A global deposit/refund
portfolio and the separate QCDAO-111/112/114/115/116 stories are not part of this
rollout. Existing contract refund functions remain available.

## Automatic settlement and funding audit

`prepareEscrowDeposit` checks the latest posting/proposal visibility and funding
eligibility before the browser asks for a token transaction. The contract independently
checks expiry, accepted proposal binding and the mirrored posting moderation pause.
The token and its decimals come from the proposal's immutable contract terms.

`startEscrowSettlement` accepts a proposal selection request only from its problem
owner. `syncEscrowFunding` checks mined canonical receipts, updates funding history,
and advances settlement when the required on-chain approvals are complete. The
scheduled worker resumes queued work when the user closes the browser. A persisted
transaction outbox serializes the platform signer's nonce and retains the signed
transaction/hash before broadcast so retries can check or resend the same transaction.
Neither a browser-supplied amount nor a requested recipient authorizes a payout.

`getEscrowFundingHistory` returns reconciled funding events and their transaction
references. Each event is tied to the configured registry and factory, the exact
proposal escrow, a successful canonical receipt and a recomputed event digest.
Deposit, lock, release, refund, cancellation and expiry events appear in the existing
audit trail under its escrow filter. Evaluator comments and scores stay off-chain.
Release projections notify both owners and populate their dashboard payment summaries.

Configure `ESCROW_PLATFORM_PRIVATE_KEY` in the Firebase project's Secret Manager
before deploying the relay functions. Its derived address must match the factory's
platform signer. Keep `ARBITRUM_SEPOLIA_RPC_URL` in the Functions runtime environment.
Only the browser's public RPC setting may use the `VITE_` prefix; never prefix a
signing key with it. Preserve historical deployment configs before changing the
active manifest, and deploy backend/rules before the frontend that calls them.

## Validation

QCDAO-110/113/117 checks on 2026-09-29 passed:

- 280 escrow contract tests, including three tests that reconcile actual local
  contract receipts with the production funding-event reconciler.
- Six deployment-verifier tests and three manifest-sync tests.
- 320 frontend Node tests and 445 component tests, plus the production build.
- 491 Functions tests and 354 Firestore/Storage emulator tests, followed by 34
  focused funding-service/event tests after the final retry fixes.
- Desktop (1365×1000) and mobile (390×844) rendered checks for the deposit form,
  amount entry, funding action and event filter, without application errors or
  page overflow. These used actual components with local deterministic fixtures.

The replacement testnet deployment and signed live smoke run are pending. The
smoke script now exercises both 50% payments, verifies the accepted-proposal
binding, and reconciles its real receipts against the funding audit anchors.

Wallet UI integration checks on 2026-09-29 passed:

- 294 frontend Node tests and 422 component tests (`npm test -- --maxWorkers 2`),
  including 20 ABI-checked escrow adapter tests.
- 427 Functions tests and all 354 Firestore/Storage emulator tests.
- The production frontend build and its registry override/manifest check.
- Desktop (1365×1000) and mobile (390×844) browser checks for deposits, evidence,
  delivery acceptance, weighted voting, refunds and wallet connection. A temporary
  local fixture rendered the actual escrow view with deterministic contract states;
  it produced no browser errors or mobile overflow.
- Fresh read-only Arbitrum Sepolia checks for chain ID, deployed contract code and
  reciprocal registry/factory links. Frontend and backend manifests match.

These checks cover immutable evidence, visibility, hash mismatches, transaction
recovery and rejection of mock actions for escrow proposals. Wallet interactions
used mocked RPC interfaces or a local UI fixture; no new live signed transaction
was sent through the wallet panel. Frontend, Functions and rules deployment remains
a separate step.

Earlier verification baseline, validated locally on 2026-09-27:

| Suite | Result |
| --- | --- |
| Frontend unit tests, including the production Vite build check | 172 passed |
| Frontend component tests | 392 passed |
| Additional frontend session/integration tests | 102 passed |
| Firebase escrow/proposal verification, publication, revision and validation tests | 75 passed |
| Full Firestore and Storage emulator rule suite | 344 passed |
| Local deployment verifier and compiled ABI compatibility tests | 6 passed |

Regression tests cover legacy hash vectors, atomic escrow calls, nonzero parent
revisions, malformed and altered funding terms, canonical link mismatches, decimal
conversion, read-only deployment identity, confirmation races, form state and
Firestore publication/immutability. Contract tests additionally compare the staged
application ABI bundle against compiled interfaces. The previously canceled deep
security scan remains incomplete and was not restarted.

The deployed contracts passed read-only runtime-bytecode, wiring, owner, signer
and fee checks; see the [verification evidence](../contracts/funding-escrow/manifests/arbitrumSepolia-verification.json).
An earlier 23-transaction smoke test created a labelled proposal and its escrow,
confirmed it through the real frontend and Firebase verifier code, and exercised
the following flow with one mock USDC:

- The first funder deposited 0.3 and topped up by 0.3; a second deposited 0.4.
- Both owners approved a 40% first payout.
- Both owners approved the next 30%; the 60% funder voted yes before its release.
- Payouts totalled 0.7 USDC, with exactly 0.0007 USDC in fees.
- An admin voided the unpaid final 30%. Funders separately claimed 0.18 and 0.12
  USDC, with no additional fee and no remaining escrow balance.
- All mock tokens were returned to the supplied wallet. Unused test-wallet gas was
  returned apart from a small transaction-fee reserve recorded in the report.

That generic-contract fixture used 40%/30%/30% before the fixed 50%/50% application
policy. It does not represent the current proposal form or a live test of the new
wallet panel. The [smoke-test journal](../contracts/funding-escrow/manifests/arbitrumSepolia-smoke.json)
contains the escrow address, hashes and confirmed block numbers. These are labelled
on-chain test records only; no Firestore records were created.

Explorer source publication is separate from successful bytecode verification.
The registry source was submitted by the deployment script and was still pending
when polling stopped. Automatic approval review blocked factory source publication
pending explicit permission to publish repository code to public Arbiscan. No
factory source submission was made. After approval, the source-only retry script
can use the confirmed record without deploying again:

```sh
ESCROW_DEPLOYMENT_RECORD=../audit-registry/manifests/arbitrumSepolia.json \
ESCROW_VERIFY_CONTRACT=factory npm run verify:source
```

Use the same command with `ESCROW_VERIFY_CONTRACT=registry` if its queued request
does not complete. The script bounds the explorer wait at two minutes and records
its result locally.
