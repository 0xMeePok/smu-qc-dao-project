# Server-side mock funding and mutual matching

This implementation follows Jira QCDAO-81–89 and the requested server-side mock workflow. The user's explicit sequence takes precedence over ticket alternatives: the owner selects an eligible proposal, then its creator gets a fresh full seven days to respond. Re-selection also starts a fresh seven-day window.

## Workflow

1. Active members contribute mock amounts to a submitted proposal, up to that proposal's requested amount. Creators cannot fund their own proposal. Multiple proposals may reach their targets.
2. The problem owner selects one proposal whose trusted expert-evaluation gate is complete and whose funding target is reached. A 10–2000 character selection rationale is mandatory. This records owner approval and starts exactly seven days of server time for its creator to confirm.
3. While confirmation is pending, funding and selection of every sibling proposal are paused. New submitted proposals, corrections and withdrawals are also blocked by Firestore rules.
4. Creator confirmation before the deadline locks all mock contributions to the selected proposal, refunds every pledged sibling contribution and cancels the siblings. The parent confirmed state is authoritative for cancellation, including unfunded proposals without their own matching map.
5. The selected creator may decline with a mandatory 10–2000 character reason. This refunds its contributors, marks it declined and reopens the problem while retaining sibling funding and evaluation results.
6. At or after the deadline, the selected proposal is voided and its contributors are refunded. Other proposals retain their contributions, and funding/selection reopen if the original problem remains open. The voided proposal cannot be funded again.

Funding alone does not constitute matching. The parties must be different accounts. The listing expiry is the deadline for submitting new proposals. Existing proposals remain fundable and selectable after that deadline while the problem remains open. The full seven-day confirmation window also remains available if the submission deadline passes during it.

Once `problems.matching.mode` is `mock`, scheduled and manual legacy opportunity expiry leave settlement to the matching service. This prevents the legacy escrow workflow from expiring a pending match or stranding mock contributions. Opportunities without an initialized mock workflow retain the normal posting-expiry behavior.

## Money and state

All amounts are simulated. No wallet transaction, token transfer, actual escrow, payout or real refund occurs. `mockFunding` is a separate server-owned ledger. Its records never enter `funding`, verified marketplace funding totals or chain audit receipts. Amounts have two decimal places; contributions exceeding the remaining target are rejected.

- `problems.matching.status`: `open`, `awaiting_confirmation`, `confirmed`.
- `problems.matching.proposalId`: selected or confirmed proposal; otherwise null.
- `problems.matching.deadlineAt`: server timestamp during the pending window; otherwise null.
- `problems.matching.totalFundedMinor`: currently pledged/locked amount in integer hundredths; refunded amounts are removed.
- `proposals.matching.status`: `funding`, `awaiting_confirmation`, `confirmed`, `voided`, `declined`, `cancelled`.
- `proposals.matching.fundedMinor`/`fundedAmount`: recorded amount raised. Terminal proposals retain historical amounts; contribution records describe whether those amounts are locked or refunded.
- `mockFunding.status`: `pledged`, `locked`, `refunded`. Refund reasons are `confirmation_expired`, `creator_declined`, `another_proposal_confirmed`, or `moderation_hide`/`moderation_remove`.

Existing proposal and problem publication statuses are preserved. Funding locks publication content; matching is separate from the existing publication/audit lifecycle.

## Callable API

All callables require an active authenticated member, enforce the existing session-revocation checks and production App Check, and use the existing `asia-southeast1` region.

- `getMockMatching({problemId, proposalId?, cursor?})`: safe candidate summaries, effective matching states, server-calculated action permissions and the caller's contributions. `proposalId` includes a focused proposal even outside the current page. `nextCursor` loads another candidate page.
- `fundMockProposal({problemId, proposalId, amount, requestId})`: contribution with an idempotency key of 16–80 letters, digits, underscores or hyphens (UUID supported). Reuse the same key when retrying uncertain network responses. Changed payloads with the same key are rejected.
- `selectMockProposal({problemId, proposalId, rationale})`: problem-owner approval.
- `confirmMockProposal({problemId, proposalId})`: selected creator approval.
- `declineMockProposal({problemId, proposalId, reason})`: selected creator decline and refund.
- `completeMockEvaluation({problemId, proposalId})`: administrator-only **mock evaluation completion** utility. It records a trusted server-side gate, actor and time; it is not a real expert review. Client-authored evaluation records do not authorize selection.
- `forceExpireMockMatch({problemId})`: administrator-only demo utility that runs the same timeout settlement immediately and records the administrator in history.
- `getMockFundingPortfolio()`: the caller's ledger history, up to 1,000 records; `truncated` indicates the limit was reached.

Safe summaries contain title, requested amount, currency and mock progress. Proposal bodies, attachments, researcher identities in candidate summaries and other members' contributions are omitted. Direct client reads and writes to `mockFunding` and `matchingEvents` are denied. Matching history includes decision actor IDs, timestamps, reasons, funding/evaluation gate snapshots and simulated settlement amounts. The latest 100 events are returned; `historyTruncated` reports older history. Events use deterministic IDs for retry safety and `mode: mock`, `chainStatus: pending` as the future matching-contract audit extension. No chain write is claimed.

Owner and creator approval identities/timestamps are stored independently. Evaluation completion and all matching fields are server-owned. Completing the evaluation locks proposal corrections so the evaluated content remains stable. Admin hide/remove uses an atomic settlement planner: affected pledged contributions are refunded, a pending selected match is reset, and confirmed locked contributions remain preserved. Restoring a moderated proposal restores funding eligibility with zero refunded funding and keeps its evaluation result when no confirmed match prevents it.

## Atomicity and limits

Every mutation reads and writes the problem inside a Firestore transaction, serializing competing funding, selection and settlement requests. Request IDs prevent duplicate contributions. Owner/creator retries preserve the existing decision and do not extend deadlines. Trusted time is refreshed inside transaction attempts. Expiry commits before a rejected late action so refunds are not rolled back by that rejection.

The mock supports at most 200 contribution records per problem, including refunded history, to keep settlement below 500 writes. Candidate pages contain 200 published proposals; drafts do not count, and every ledger-referenced proposal is independently loaded for settlement. New submissions or a large list cannot strand existing funds. The parent confirmed state cancels all unfunded siblings without requiring an unbounded transaction.

`expireMockMatchingWindows` runs every five minutes and handles up to 100 expired problems per run. Matching reads, portfolio reads and mutations also settle expired windows lazily. The deadline is enforced from server time even before the scheduler runs.

## Deployment and verification

Deploy the Functions, Firestore rules, Storage rules and Firestore indexes together, then deploy the frontend. The schedulers need Cloud Scheduler support. Existing published data requires no migration; mock state is created on the first contribution or mock evaluation. This change does not replace publication's existing blockchain audit flow.

Tests:

```sh
node --test firebase/functions/test/matching.test.mjs
cd firebase/functions
./node_modules/.bin/firebase emulators:exec --config ../firebase.json --only firestore --project qc-dao-matching-transactions 'node --test test/matching.emulator.test.mjs'
```

The unit suite covers evaluation/rationale gates, creator decline, admin-only demo operations, audit idempotency, moderation settlement, mutual approvals, exact deadline boundaries, refunds/locking, idempotency, roles, overfunding, moderation, privacy, candidate pagination and settlement with hundreds of new drafts/proposals. The real Firestore emulator test runs duplicate contributions, overfunding attempts and competing owner selections concurrently, and checks deadline refunds.

## In-app matching notifications

Matching events enqueue a private `matchingNotificationJobs` record. The event trigger immediately delivers owner/selected-creator notices; a one-minute scheduler resumes the remaining authors and funders in pages of 100 source records. Every proposal author is reached regardless of candidate-list pagination. Delivery and cursor updates commit together; deterministic event/recipient IDs prevent duplicate notices and preserve read acknowledgements across retries and overlapping roles.

Selection explains the creator deadline and temporary funding pause. Confirmation explains locking, cancellation and refunds. Decline and expiry explain refunds and reopening. Trusted gate events notify the owner when evaluation and the funding target are both complete. Notices live in the shared in-app `moderationNotifications` feed with a link to the problem. No email or external message is sent. A pending-job index and both notification functions must deploy with this module.

## Moderation (QCDAO-87–89)

Members can report a visible problem statement, their accessible proposal, or an existing discussion comment. The server applies the original content access rules, accepts one report per member/item, and limits new reports to 20 per UTC day. Reporter identities stay in the server-only report collection and are returned only to administrators. Comments attached to private proposals are never included in the problem's public discussion view. This work adds reporting for existing comments; it does not add a comment-authoring workflow.

The administrator's Content moderation tab combines member reports and rule-flagged submissions. Deterministic screening flags excessive external links, repeated text and explicit abusive phrases; screening queues review and never removes content automatically. The queue offers type/status filters, oldest/most-reported sorting, pagination, pending counts, full text and parent context, attachment downloads, reports and decision history.

Hide, remove and restore require a reason. Server-owned moderation fields preserve original workflow status and sponsor identity, so restoring a proposal restores access. Hidden/removed content is accessible only to its author and administrators and is excluded from ordinary browse, comparison, selection and revision/attachment reads. Moderation events retain the actor, reason, sequence and future on-chain status. Authors receive a private notice in Profile → Content & matching notices.

Hide/remove refunds affected outstanding mock pledges in the same transaction as the visibility change. If the selected proposal is affected, its confirmation window closes and the other proposals reopen. Confirmed locked funds remain locked. Restoration preserves the evaluation result and restores eligible proposals with zero refunded funding; it never invents new pledges.

Moderation callables: `submitContentReport`, `listModerationQueue`, `getModerationContext`, `moderateContent`, `listModerationNotifications`, `markModerationNotificationRead`, and `listReportableComments`. Three content-write triggers screen new or amended problems, proposals and comments. Queue pages contain 50 items; report/history context contains up to 100 entries; notices show the latest 50. Comment pages scan 100 records with privacy filtering and return `nextCursor`; Load more remains available even when a page contains no visible comments. Pass cursors unchanged to preserve exact timestamp precision.

## Demo walkthrough

1. Publish a problem and two proposals through the existing app workflow, using different accounts for the owner and creators.
2. As an administrator, open the posting and use **Complete mock evaluation** on each proposal.
3. As a member other than the relevant creator, use **Fund proposal** to bring both proposals to their targets.
4. As the problem owner, select either evaluated proposal and enter a rationale. Verify all proposal funding is paused.
5. As the selected creator, confirm to lock its funding and refund/cancel the other proposal. Review the decision record and the funder's portfolio.
6. On another selection, test **Decline selection**, or use the administrator's **Expire window for demonstration**. Verify the selected proposal's funders are refunded, while remaining proposals keep their funding/evaluation and become available again.
7. Report a posting or accessible proposal, then review it under **Admin → Content moderation**. Hide/remove it, inspect the author notice, and restore it with an appropriate recorded reason.

The matching and moderation receipts are server records pending future contract integration, not blockchain transactions. The expert evaluation control is an administrator-operated simulation. This implementation intentionally does not simulate actual token balances, smart-contract escrow or milestone payouts.
