# Registry-linked proposal escrow

Implements the escrow work for [QCDAO-109](https://qc-dao-fyp.atlassian.net/browse/QCDAO-109),
the deposit interface for [QCDAO-110](https://qc-dao-fyp.atlassian.net/browse/QCDAO-110),
settlement for [QCDAO-113](https://qc-dao-fyp.atlassian.net/browse/QCDAO-113), and funding
audit reconciliation for [QCDAO-117](https://qc-dao-fyp.atlassian.net/browse/QCDAO-117), extended
with milestone tranches, admin voids, partial refunds and optional funder voting.

**Replacement contracts and application rollout completed on Arbitrum Sepolia.** The existing non-upgradeable `AuditRegistry`
cannot acquire an escrow creation hook. This package supplies `EscrowAuditRegistry`,
a new linked deployment inheriting its posting, proposal, revision and audit logic.
The existing `AuditRegistry.sol` source is preserved exactly so live bytecode
verification remains compatible. A versioned `AuditRegistryExtensible.sol` copy
provides the public/virtual hooks for inheritance. The active manifest and both
application configurations now select registry `0x2C23b72d6717E982cccd6F4eBe92C9d3448BFcD0`
and factory `0xDF28146Bfe0f4e2c926bf3bc1bb5750A72CAAc66` on chain 421614.
Both passed runtime-bytecode and wiring verification. On 2026-09-29, the signed
50%/50% smoke test passed and Firebase backend and
[Hosting](https://qcdao-a0c7a.web.app) deployment completed. All 66 Functions were
updated or created, all eight new services are active, five escrow indexes are ready,
and the settlement scheduler is enabled. The owner/platform signer, existing tokens
and 10 BPS fee are unchanged. Explorer source publication was not requested for this
replacement; runtime-bytecode verification is complete.
See [deployment addresses and smoke-test evidence](../../docs/ESCROW_REGISTRY_INTEGRATION.md).

### Open funding grant scope (2026-10-01)

The source now implements open funding as a separate single-owner grant pool.
This grant version has been tested on local chains; it has **not been deployed**.
The historical Arbitrum Sepolia addresses above still identify the previous pooled
workflow. Enabling grants requires a new verified registry/factory deployment and
an application manifest explicitly declaring the grant capability.
The main workflow's pending selection, full seven-day handshake and immediate
rejection refund changes below also apply to this undeployed source version.

1. The funder posts an `OpenFunding` opportunity, then calls
   `FundingEscrowFactory.createOpenFundingPool(postingId, token)`.
2. Only the posting owner approves that pool as token spender and calls
   `deposit(amount)`. Prefunding must occur before a proposal can be submitted.
   Top ups are allowed after awards and after the submission deadline; a withdrawn
   posting stops further deposits. Every proposal uses the pool's token.
3. Each researcher submits their requested target and immutable milestone plan
   through `commitProposalWithEscrow`. Grant proposal escrows reject ordinary
   pooled deposits and the main workflow's platform selection operation.
4. The owner calls `pool.selectProposal(proposalId)` to reserve its full requested
   target. Several proposals may be selected. A 100,000-unit pool can reserve two
   50,000-unit proposals; an additional selection must fit the unreserved balance.
5. The proposal researcher has exactly seven days to call
   `pool.acceptProposal(proposalId)`. Acceptance is allowed before, but never at,
   `acceptanceDeadline`, even if the posting's submission deadline has since passed.
   Acceptance atomically transfers the reserved amount into its canonical escrow.
   Owner selection and researcher acceptance count as the initial dual approval;
   the platform may then release its initial tranche using `selectionId = proposalId`.
   Later milestone submission, dual approval, fees and payment controls are retained.
6. At or after the deadline, anyone can call `pool.expireProposal(proposalId)` to
   void the unanswered offer and return its reservation to available custody.
   A withdrawn or admin-voided proposal can be synchronized sooner. Voided offers
   cannot be selected again. Separate grant awards never invalidate one another.
7. After submission closes or the posting is withdrawn, the owner may call
   `withdrawAvailable(amount)` for unreserved custody. Pending awards remain
   protected. Once funds enter an accepted escrow, any unpaid escrow refund belongs
   directly to the posting owner's wallet through `claimRefund()`.

Read `openFundingPoolForPosting(postingId)` for the canonical pool. Pool reads are
`owner`, `token`, `tokenDecimals`, `totalDeposited`, `totalAllocated`, `totalWithdrawn`,
`reservedAmount`, `availableBalance`, `getOffer(proposalId)`, `proposalCount` and
`proposalAt(index)`. `getOffer` returns `(amount, acceptanceDeadline, state)`, with
states `0=None`, `1=Pending`, `2=Accepted`, `3=Voided`. Deadlines need a transaction
to synchronize custody; an expired pending offer is never acceptable even before
that synchronization happens.

`FundingEscrowDeployer` and `OpenFundingPoolDeployer` are created by the canonical
factory constructor and accept creation calls only from that factory. Keeping
creation bytecode in those contracts preserves the EVM runtime size limit.
Runtime verification resolves helper outputs from the factory's exact build-info
compilation, including their Solidity metadata. Standalone helper compilations may
have different dependency remappings and metadata hashes.
Export the current compiled interfaces with `npm run export:abis`; use
`-- --output /path/to/interfaces.json` for an alternate output location. ABI bundles
contain no deployment addresses. New deployment records declare `workflowVersion: 2`
and `open-funding-grants`, and include both creation helper addresses.

## Run and validation

Use Node 22.13+ from the repository checkout (the local `audit-registry` dependency
must be present):

```sh
cd contracts/funding-escrow
npm ci
npm test
npm run coverage
npx hardhat compile --build-profile production
```

Validated on 2026-09-27: 263 escrow tests and 63 original registry regression tests
passed. Escrow package Solidity coverage: 99.12% lines / 99.31% statements;
`FundingEscrow.sol` and `TokenDecimals.sol` each reported 100%. Coverage is not a
proof of all possible execution paths. Tests run on isolated local Hardhat chains.

Validated on 2026-10-01 against the undeployed source version: 305 escrow and grant
tests, nine deployment-script tests and eight read-only deployment-verifier tests
passed. Main workflow cases cover exclusive pending selection, both rejection
roles, immediate refund claims, exact seven-day expiry, completion approvals and
strict funding-weighted majority. A separate case runs two independent grants
while a business posting's handshake is pending.

Solidity 0.8.28, Hardhat 3.13, OpenZeppelin 5.6.1; Cancun EVM, optimizer 200 runs.
The test token in `contracts/test` is only a local regression fixture.

## Contracts and trust

- `EscrowAuditRegistry`: proposal creation and escrow deployment are one atomic
  transaction. Proposal/posting owners come from the registry. Every funding
  action appends a proposal-scoped audit anchor and emits detailed events.
- `FundingEscrowFactory`: one escrow per proposal, token allowlist, configurable
  fee and revocable moderation admins. Only its immutable registry can create escrows.
- `FundingEscrow`: immutable plan, repeated funding, approval/voting, sequential
  payouts, per-user deposit history, and pull refunds.

The registry owner wires a matching factory once. Factory ownership is two-step
and cannot be renounced. Only the factory owner can change fees/listings or delegate
`setEscrowAdmin(wallet, enabled)`. The current factory owner is always an escrow
admin. Revocation and ownership changes take effect for moderation immediately.
The fee recipient remains the owner snapshotted when that escrow was created.

The platform signer selects fully funded proposals after an authenticated request
from the problem owner and executes approved payments. The backend relay uses
the `ESCROW_PLATFORM_PRIVATE_KEY` Secret Manager secret; it is never placed in
frontend configuration or committed to source control. Wallet approvals stay with
the two owners. The relay persists the signed transaction and its hash before
broadcast and resumes pending work without signing a duplicate payment.
It cannot choose another proposal recipient, approve on anyone's behalf, bypass
votes, or withdraw funds. The problem and proposal owners must be different wallets.
Each owner signs its own on-chain approval. A lost platform key delays payments,
but refund deadlines remain permissionless. The admin can stop unpaid work and
open refunds; it cannot redirect those refunds or claw back previous payments.

Only trust addresses from the configured factory's `escrowForProposal` and the
linked registry's `proposalEscrow`, not contracts claiming similar IDs or names.

The main business workflow reserves one canonical pending proposal as soon as its
selection is locked. Other proposal escrows stop accepting deposits and selections
while that handshake is pending; their custody remains intact and cannot be refunded
as invalidated merely because of the temporary lock. Rejection or handshake expiry
refunds the selected escrow and reopens the other proposals while the posting is open.
The first payout permanently binds the accepted proposal to its posting. The other
proposals then remain closed and their invalidated-proposal refund path is available.
These posting-wide locks do not apply to independent open funding grant awards.
The platform signer can also
set a reversible posting funding pause when moderation hides a posting. A pause
blocks funding and payments but does not itself permanently invalidate the escrow
or open refunds; removing the pause restores the existing approval deadlines.

## Atomic proposal creation

The application standard is **50% upfront and 50% on completion**, with either
both-owner approval or both-owner approval plus a funding-weighted funder majority
for completion. Application validation and publication rules require `[5000, 5000]`
for every proposal; custom application plans are no longer accepted. The generic
contract still supports the immutable tranche mechanics described below. This
policy change does not redeploy the contracts. The whole target is deposited before
the upfront payment; both halves are gross amounts before configured fees.

The new registry rejects the legacy `commitProposal` entry point. Use the proposal
owner's wallet and actor-scoped IDs, as required by the original registry:

```js
const terms = {
  token: tokenAddress,
  target: parseTokenAmount("1000", Number(await factory.tokenDecimals(tokenAddress))),
  funderVoting: true,
  trancheBps: [5000, 5000],             // 50% upfront, 50% on completion
  reviewWindows: [604800, 7776000],     // 7 days upfront; 90 days to deliver and approve
  milestoneHashes: [hash1, hash2],      // immutable milestone descriptions
};
await registry.connect(proposalOwner).commitProposalWithEscrow(
  proposalId, postingId, proposalHash, solutionHash, expectedPostingRevision, terms,
);
const escrowAddress = await registry.proposalEscrow(proposalId);
```

There must be 1–5 positive tranche ratios totaling exactly 10,000, equally sized
window/hash arrays, nonzero description hashes, and windows of 1 second–365 days.
The parent posting must have a finite future expiry. Token, target, owners, fee,
ratios, descriptions, windows and voting mode are fixed at creation. The toggle is
chosen before funding and cannot be changed after funders have committed.

For cumulative ratio `C[i]`, tranche `i` is:

```text
floor(target * C[i] / 10000) - floor(target * C[i-1] / 10000)
```

Full-precision multiplication avoids intermediate overflow. Amounts sum exactly
to the target, including the final rounding unit. Plans yielding a zero-unit
tranche are rejected (especially relevant to zero-decimal tokens or tiny targets).
A single `[10000]` tranche is the lump-sum option.

Proposal hashes may be revised only before its first deposit. Parent content freezes
when any child proposal receives funding. Posting expiry cannot change on the linked
registry, even before funding. Posting and proposal withdrawal remain available;
they immediately block further deposits and payments. Call `refundInvalidated()`
from any wallet to synchronize the withdrawal into immediate refund status.
Unfunded proposal snapshots can retain an earlier posting revision; display both
pinned proposal and current parent revision as in the original audit registry.

## Deposits, approvals and voting

1. Funder approves the selected ERC-20 and calls `deposit(amount)`. Repeated top-ups
   add to `contributions(wallet)` and `depositCounts(wallet)`. Funding cannot exceed
   the target. No deposits are accepted after selection or expiry.
2. At full funding, platform calls `lockSelection(uniqueSelectionId, proposalOwner)`.
   The recipient must equal the registered proposal owner. The first approval
   deadline is exactly seven days after selection, independent of posting expiry
   and the configurable first milestone window. Selection must begin before the
   posting closes, but its handshake can finish after submission closes.
3. Both owners call `approveSelection(selectionId)`. Platform calls `release(selectionId)`
   before the deadline. This pays only tranche zero. Funder voting never gates it.
4. For each later tranche, proposal owner calls `submitMilestone(index, evidenceHash)`.
   Both owners call `approveMilestone(selectionId, index, evidenceHash)`.
5. If `funderVoting` is enabled, funders also call `voteMilestone(index, evidenceHash, yes)`.
   Platform calls `releaseMilestone(selectionId, index, evidenceHash)` once all gates pass.

**Later payouts always need both owner approvals. With voting enabled, they also
need strictly more than 50% of all deposited units voting yes.** Votes are weighted
by each wallet's full cumulative contribution, including top-ups, fixed at full
funding. Exactly 50% fails; abstentions do not lower the denominator. There is no
currency conversion or headcount vote. A single funder with >50% controls the funder
vote but still cannot bypass either owner's approval. Voting never transfers tokens.

A wallet votes once per tranche/evidence version. A replacement evidence hash resets
both owner approvals and both vote totals. Previously used evidence hashes cannot
be reinstated for that tranche. Stale selection/index/hash calls revert. Votes and
approvals never carry into the next tranche; tranches cannot be skipped or paid twice.

Each later review deadline starts when the previous tranche is paid. Evidence edits
cannot extend it. Later milestones can continue after the posting funding expiry.
At the deadline, anyone can call `expire()`, or a funder can call `claimRefund()`
directly, to refund the unpaid balance. Missed votes or an unavailable owner therefore
cannot lock the balance forever. Pending approval does not reserve a late payout.

Before the first payout and strictly before the approval deadline, either main
workflow owner can call `rejectSelection(selectionId, reasonHash)`. The platform
can also invalidate a selection. Both make the selected escrow terminal with
immediate fee-free refunds and clear the posting's pending selection. At or after
the handshake deadline, permissionless `expire()` or `claimRefund()` opens those
refunds. Refunding is a wallet claim transaction rather than an automatic transfer.
Ordinary platform `cancel(reasonHash)` retains the original posting refund deadline.
Admin moderation uses
`voidEscrow(reasonHash)` to make refunds available immediately.

## Fees and partial refunds

`factory.setFeeBps(10)` sets 0.1% for **future escrows**; 10,000 means 100%.
Fee rate and owner recipient are snapshotted at escrow creation. Existing escrow
terms do not change when the owner changes the global rate or transfers ownership.

For each payment:

```text
cumulativeFee = floor(cumulativeGrossReleased * feeBps / 10000)
thisTrancheFee = cumulativeFee - previouslyPaidFees
proposalOwnerReceives = thisTrancheGross - thisTrancheFee
```

Rounding is cumulative, so splitting a payment does not avoid fees. `totalReleased`
is gross and already includes `feePaid`; never subtract the fee twice in a dashboard.
A 100% fee leaves zero net payment. Both transfers and all accounting/audit changes
are atomic; a failed transfer leaves the tranche available for retry or later refund.

When an admin voids the escrow, **only `totalDeposited - totalReleased` becomes
refundable, immediately and with no refund fee**. Prior payouts and their fees
remain paid. Example: target 1,000, upfront tranche 500, fee 1%: proposal owner receives
495 and fee recipient receives 5; a subsequent void refunds the remaining 500.

Deposits maintain each funder's cumulative contribution in first-deposit order,
including every top-up. These intervals become fixed when the target is reached.
For remaining pool `R`, original total `T`, and a wallet's interval `(start, end]`,
its refund is:

```text
floor(R * end / T) - floor(R * start / T)
```

These amounts telescope to exactly `R`, are independent of claim order, and differ
from exact proportional shares by less than one token base unit. Very small shares
can be zero; the dashboard shows those as released. Intermediate per-wallet gross
release estimates may move by a rounding unit between tranches; contract-wide
totals remain exact. No residue is diverted to the admin or fee recipient.

There is **no fixed limit on funding wallets**. A cumulative-sum tree is updated as
deposits arrive, so selection locking never enumerates funders. Admin voiding only
changes state, opens the unpaid pool, and records the audit event; it sends no tokens.
Each funder calls `claimRefund()` to withdraw their own unpaid share. There are no
bulk refund transfers or loops through the funder list.

Locking and voiding use constant work. Deposits and partial-refund share lookups
use logarithmic bookkeeping in the number of distinct funders; a claim transfers
to only its caller. This preserves exact, claim-order-independent rounding without
requiring a wallet cap. `fundingPrefixEnd(wallet)` is a live view before full funding
and remains fixed afterwards; unknown wallets return zero. Gas still depends on
ordinary token and registry execution costs.

## Tokens and decimals

Reuse the deployed Arbitrum Sepolia mocks from [stable-faucet](../stable-faucet/README.md):

| Token | Address | Decimals |
| --- | --- | --- |
| XSGD | `0xC2FE292771719Ae948506bab3c156A622de9a415` | 6 |
| USDT | `0x5f079A5934C864D6881EF30cf74Fe1363F58B856` | 6 |
| USDC | `0x4CBf2C15243678206dF8F248D01a0e117C8ce0cd` | 6 |

No faucet or token is redeployed. The owner can `setTokenAllowed(token, true/false)`.
Delisting blocks new escrows and further deposits; existing approvals, payments and
refunds continue. `getAllowedTokens()` provides the current choices.

Listing requires deployed code and valid `decimals()` metadata, in the explicit
range 0–77. The first value is permanently recorded and snapshotted by escrows;
missing, malformed, reverting, changed or out-of-range metadata blocks new funding.
Deposits check metadata both before and after transfer. Delist/relist cannot change
the scale. Existing payouts/refunds use original base units even if metadata breaks.
Amounts must fit uint256: e.g. two whole tokens at 77 decimals do not fit.

All math stays in the token's own base units. Use `lib/tokenAmounts.js`:

```js
const decimals = Number(await escrow.tokenDecimals());
const amount = parseTokenAmount("1.25", decimals); // exact bigint, rejects excess precision
await token.connect(funder).approve(escrowAddress, amount);
await escrow.connect(funder).deposit(amount);
const summary = await escrow.depositorSummary(funder.address);
const display = formatTokenAmount(summary.claimable, decimals);
```

The parser rejects floats, signs, exponent notation, whitespace, zero deposits,
excess precision and overflow. Use `bigint`/decimal strings throughout application
storage. Never rescale old deposits using a token's newly reported metadata or
sum different currencies' raw units.

`SafeERC20`, exact sender/recipient balance checks and a shared re-entrancy guard
protect all fourteen escrow mutations. Fee-on-transfer, no-op and inconsistent
transfers revert atomically. Tokens with no return value are supported if their
balance movement is exact. Listed tokens must still be reviewed: a token can lie
about balances, blacklist users, rebase or stop transfers. Delisting cannot repair
its behavior. Direct donations create no claim and have no admin sweep.

## Dashboard and audit interface

The frontend proposal page's **Open escrow** button opens a wallet-backed panel.
It verifies the canonical registry/factory links, immutable terms and current
proposal hashes, then reads contract state and the connected wallet's balances at
one block. It shows the funded target, gross released amount, unpaid balance,
contribution, claimable refund and current deadline. Writes require the connected
Arbitrum Sepolia wallet to match the signed-in account and the applicable on-chain
role. Firebase administrator status does not substitute for the platform signer.

The panel supports exact-amount token approvals/deposits and top-ups; platform
selection; both owners' upfront approvals; platform upfront release; delivery
evidence submission; each owner's separate completion approval; optional weighted
funder votes; platform final release; expiry/withdrawal refund opening; and each
wallet's refund claim. The application always uses two halves, `[5000, 5000]`.
Before payout two, the proposal owner must confirm completion and the problem owner
must accept it as delivered; when enabled, funder yes votes must exceed 50% of all
contributed units. Evidence submission alone does not approve completion.

Readable evidence is saved before its wallet transaction in the immutable Firestore
path `proposals/{proposalId}/deliveryEvidence/{evidenceHash}`. Its digest is Keccak-256
of UTF-8 `JSON.stringify({ scheme: "qcdao.escrow.delivery.v1", summary, url })`, in that
field order. The summary is trimmed/NFC-normalized (2–4,000 characters); the required
HTTPS URL is trimmed only (at most 2,048 characters). The record contains only those
two fields, the authenticated proposal owner's `ownerId`, and server `createdAt`.
Only that author can create it; authorized parent proposal viewers can read it;
clients cannot update or delete it. The UI recomputes the hash before displaying
evidence for approval, voting or final release. A missing/mismatched record disables
those actions, and replacing evidence resets approvals/votes on-chain. The URL's
remote content is not itself committed by this digest.

The wallet service refreshes verified state before each action, waits for receipts,
and never automatically retries a write. An unknown confirmation result can be
checked by its existing transaction hash. Opportunity lists and advisory evaluator
comparisons link escrow proposals to this panel; they do not offer mock funding or
selection. Functions independently reject mock mutations for escrow proposals.
The current wallet view is per proposal; a global portfolio/indexer and contract
moderation/selection-management controls are not included in this panel.

`depositorSummary(wallet)` returns `{ deposited, depositCount, refunded, claimable,
released, status }`. `deposited` and top-up count are lifetime history and never
cleared. `released` includes the wallet's gross share of fees; `claimable` is the
currently refundable amount after any previous refund.

| Status | Meaning |
| --- | --- |
| None (0) | Never deposited |
| Locked (1) | Funding/first approval pending |
| RefundPending (2) | Cancelled; original posting expiry not reached |
| Refundable (3) | Claimable now |
| Refunded (4) | Wallet received its complete remaining refund (possibly after some payouts) |
| Released (5) | No remaining unpaid share |
| PartiallyReleased (6) | Some gross funding distributed; remaining balance still committed |

Index factory `EscrowCreated` and registry `ProposalEscrowLinked` from their deployment
blocks, then `Deposited` from canonical escrows. Filter by indexed depositor, posting
and proposal. Top-ups include individual amount, cumulative amount and deposit
number. Also index `TrancheReleased`, `MilestoneVoted`, `RefundsOpened`, `EscrowVoided`
and `RefundClaimed`; read `milestoneAt`, approval flags, vote weights and deadlines.
Registry `FundingEventAnchored` / `fundingAnchorAt` provide proposal-scoped history.

Use bounded log ranges, confirmed blocks, reorg handling and deduplication by
`(chainId, transactionHash, logIndex)`. Refresh summaries at one consistent block.
A registry withdrawal blocks payments immediately, but the dashboard should call
or offer `refundInvalidated()` before presenting the escrow as immediately claimable.
Time-based refund status is derived automatically even before an `expire()` transaction.
A user can be refunded in proposal A while remaining committed in proposal B.

State values preserve the original 0–5: Open, Locked, Released, Refunded, Cancelled,
Expired; appended values are Active (6, later tranches) and Voided (7, immediate refunds).
`Refunded` means the unpaid refund pool has been fully claimed, not that prior payouts
were reversed. Empty terminal pools may remain Expired/Voided without a claim.

## Deployment and application migration

```sh
cp .env.example .env
# Set owner/deployer, platform signer, existing tokens and fee.
# Plan migration, then set ESCROW_NEW_REGISTRY_ACK=true.
npm run deploy:arbitrum-sepolia
```

The script enforces Arbitrum Sepolia (421614), validates existing tokens, requires
the owner to be the deployment signer, deploys the new registry and factory, and
performs the one-time wiring. It records each broadcast transaction before waiting
for two confirmations, then verifies wiring and optionally explorer source.
If interrupted, inspect the saved deployment JSON and chain receipts; reuse confirmed
addresses and complete pending wiring rather than blindly deploying replacements.
Two-step ownership transfers can be performed after setup if another owner is desired.

The frontend proposal form and Firebase verifier now support the linked registry's
atomic `commitProposalWithEscrow` call and immutable funding terms. The deployment
verifier and manifest sync support the new registry/factory pair. See
[application integration and cutover instructions](../../docs/ESCROW_REGISTRY_INTEGRATION.md).
The replacement registry/factory pair is confirmed, bytecode/wiring-verified and
selected in the frontend and Firebase manifests. Matching Functions and rules were
deployed before the rebuilt Hosting bundle; both deployments completed on
2026-09-29. Publication verification, escrow routing markers, mock-action rejection
and immutable delivery-evidence access must agree for future rollouts too. Contracts
cannot wake themselves to execute a release; the enabled backend relay executes
approved payments and resumes queued transactions. Its scheduled attempt at
15:02:02 UTC on 2026-09-29 reported status 0.

Old registry postings/proposals do not move automatically. Retain their original
registry namespace and audit history; create new linked postings/proposals through
their actual owners for the new workflow. Preserve an explicit application mapping
between old/new identities; do not silently reuse old evidence or relabel old funds.
The previous deployment and a one-mock-USDC smoke test completed on 2026-09-27. That smoke test
checked two payouts, funder voting, top-ups and fee-free partial pull refunds,
then returned the mock tokens and unused test-wallet gas. Its transaction journal
is in `manifests/arbitrumSepolia-smoke.json`. That earlier generic-contract fixture
used 40%/30%/30%, before the fixed application split; it was not a signed live test
of the new wallet UI.

The replacement's one-mock-USDC 50%/50% smoke test passed on 2026-09-29, with
[committed evidence](manifests/arbitrumSepolia-2026-09-29-smoke.json). It confirmed
20 transactions (19 business transactions and one gas return), paid 500,000 base
units gross in each half, charged 1,000 base units total in fees, and matched 13
funding audit events. Cleanup-only recovery verified the receipts and returned all
mock tokens; 0.0000221284796 test ETH remains reserved in the recoverable derived
test wallet. The signed test exercised contracts and the real frontend/Firebase
verification modules; it did not exercise a full authenticated browser workflow.
After manifest synchronization, 95 focused tests and nine cleanup regression tests
passed. The rollout scope is QCDAO-110, QCDAO-113 and QCDAO-117; no Jira records were
changed. No historical records were migrated or retired. The previous linked deployment is archived in
`../audit-registry/legacy/pre-qcdao-110-arbitrumSepolia.deployment.json`, and its ABI
remains in `firebase/functions/auditRegistry.history.json` at the repository root.
The current confirmed deployment record is `../audit-registry/manifests/arbitrumSepolia.json`;
do not deploy replacements when testing or retrying explorer source verification.

## Security evidence

Tests cover all 1–5 tranche counts, decimals 0/6/18/77 for tranche arithmetic, broader
metadata cases up to 77 decimals, large multiplication, malformed plans, stale/duplicate
approvals and votes, exact majority boundaries, deadline expiry, all partial-void
positions, fee rates up to 100%, failing transfers with rollback, token callbacks into
all mutations, claim-order independence, donations, 258-funder participation and
individual refund gas bounds, interleaved top-ups across growing cumulative ranges,
failed-deposit rollback, selection relocking, ownership,
and canonical registry/audit integration. Original registry regression tests also pass.

```text
totalDeposited == outstandingBalance + totalRefunded + totalReleased
tokenBalance >= outstandingBalance
feePaid == floor(totalReleased * feeBps / 10000)
```

The deep security scan was canceled at the user's request on 2026-09-27; its
coverage is incomplete. Its preserved report covers the snapshot before the
versioned-base compatibility move, additional maximum-uint256 test, and removal of
the funder cap. Its retained low-severity admission-cap finding is addressed in
this source by removing both the cap and the full-funder selection snapshot.
The focused regression exercises 258 funders, repeated top-ups, one tranche payout,
an admin void with no transfers, and individual claims returning the entire unpaid
pool without refund fees. The deep scan has not been restarted or completed; do not
describe this implementation as having passed a completed security audit.

A dependency advisory check reported zero production dependency advisories and
eight low-severity development-tool entries tracing to the `elliptic` dependency
of Hardhat's verification tooling; the audit reported no available fix. There
were no moderate, high or critical npm advisory entries in that check.
Tests and automated review cannot establish an exhaustive absence of vulnerabilities.
