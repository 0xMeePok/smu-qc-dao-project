# Server-side mock funding and mutual matching

QCDAO-81–86 use an entirely off-chain, server-side mock workflow. The accepted requirements override the older Jira references to evaluation prerequisites, a separate owner approval action, and on-chain matching events. The owner selects a fully funded proposal, which records owner acceptance. The creator must respond within seven days or by the original posting deadline, whichever comes first. QCDAO-87–89 moderation remains integrated with the mock ledger.

## Workflow

1. Active members contribute mock amounts to a submitted proposal, up to that proposal's requested amount. Problems are not funded. Creators cannot fund their own proposal. Multiple proposals may reach their targets.
2. The problem owner selects any active, fully funded proposal without an evaluation prerequisite. A 10–2000 character rationale is mandatory. Selection records owner acceptance and starts a creator response window ending at the earlier of seven days later and the original posting expiry. The actual deadline and any shortened window are visible to both parties. Evaluator recommendations remain optional and advisory: none of the three outcomes ranks or blocks a funded proposal.
3. While confirmation is pending, funding and selection of every sibling proposal are paused. New submitted proposals, corrections and withdrawals are also blocked by Firestore rules. Nonselected authors are notified of the temporary pause.
4. Creator acceptance before the deadline locks all mock contributions to the selected proposal, refunds every pledged sibling contribution and cancels the siblings. The parent confirmed state is authoritative for cancellation, including unfunded proposals without their own matching map. A confirmed match cannot be rejected through the pending-selection action.
5. Either the owner or selected creator may reject a pending selection with a mandatory 10–2000 character reason. This refunds only that proposal's contributors, marks it declined, and reopens the problem until its original posting deadline. Siblings retain their existing funding, evaluation results and comments. A new selection starts a new response window, again capped by the original posting expiry; the declined proposal remains excluded.
6. At or after the response deadline, the posting is invalidated and every still-pledged contribution for all its proposals is refunded. Funding and selection remain closed. Expiry does not reopen the posting. The original posting deadline also closes and refunds an open mock workflow even when no proposal is currently selected.

Funding alone does not constitute matching. The parties must be different accounts. Neither funding nor selection may extend the original posting expiry. Exact deadline boundaries use trusted server time; the UI countdown is informative, not the authority for permission.

Once `problems.matching.mode` is `mock`, scheduled and manual legacy opportunity expiry leave settlement to the matching service. This prevents the legacy escrow workflow from expiring a pending match or stranding mock contributions. Opportunities without an initialized mock workflow retain the normal posting-expiry behavior.

## Money and state

All amounts are simulated. No wallet transaction, token transfer, actual escrow, payout or real refund occurs. `mockFunding` is a separate server-owned ledger. Its records never enter `funding`, verified marketplace funding totals or chain audit receipts. Amounts have two decimal places; contributions exceeding the remaining target are rejected.

- `problems.matching.status`: `open`, `awaiting_confirmation`, `confirmed`, `invalidated`.
- `problems.matching.proposalId`: selected or confirmed proposal; preserved after invalidation for audit context, cleared when rejection reopens the posting.
- `problems.matching.deadlineAt`: server timestamp during the pending window; otherwise null. It is capped by the original posting expiry. `deadlineLimitedByPosting` identifies a shortened acceptance window.
- `problems.matching.totalFundedMinor`: currently pledged/locked amount in integer hundredths; refunded amounts are removed.
- `proposals.matching.status`: `funding`, `awaiting_confirmation`, `confirmed`, `voided`, `declined`, `cancelled`.
- `proposals.matching.fundedMinor`/`fundedAmount`: recorded amount raised. Terminal proposals retain historical amounts; contribution records describe whether those amounts are locked or refunded.
- `mockFunding.status`: `pledged`, `locked`, `refunded`. Refund reasons are `confirmation_expired`, `admin_force_expired`, `posting_expired`, `owner_declined`, `creator_declined`, `another_proposal_confirmed`, or `moderation_hide`/`moderation_remove`.

Existing proposal and problem publication statuses are preserved. Funding locks publication content; matching is separate from the existing publication/audit lifecycle.

## Callable API

All callables require an active authenticated member, enforce the existing session-revocation checks and production App Check, and use the existing `asia-southeast1` region.

- `getMockMatching({problemId, proposalId?, cursor?})`: safe candidate summaries, effective matching states, server-calculated action permissions and the caller's contributions. `proposalId` includes a focused proposal even outside the current page. `nextCursor` loads another candidate page.
- `fundMockProposal({problemId, proposalId, amount, requestId})`: contribution with an idempotency key of 16–80 letters, digits, underscores or hyphens (UUID supported). Reuse the same key when retrying uncertain network responses. Changed payloads with the same key are rejected.
- `selectMockProposal({problemId, proposalId, rationale})`: problem-owner approval.
- `confirmMockProposal({problemId, proposalId})`: selected creator approval.
- `declineMockProposal({problemId, proposalId, reason})`: owner or selected creator rejection, selected-proposal refund and reopening within the original posting expiry.
- `completeMockEvaluation({problemId, proposalId})`: administrator-only **mock evaluation completion** utility. It records a trusted server-side evaluation marker, actor and time; it is not a real expert review and does not gate selection.
- `forceExpireMockMatch({problemId})`: administrator-only demo utility that runs the same timeout settlement immediately and records the administrator in history.
- `getMockFundingPortfolio()`: the caller's ledger history, up to 1,000 records; `truncated` indicates the limit was reached.

Safe summaries contain title, requested amount, currency and mock progress. Proposal bodies, attachments, researcher identities in candidate summaries and other members' contributions are omitted. Direct client reads and writes to `mockFunding` and `matchingEvents` are denied. Matching history includes decision actor IDs, timestamps, reasons, funding and optional evaluation snapshots, and simulated settlement amounts. Funding-event actors are redacted for every non-administrator, including problem owners and proposal creators; administrators retain the complete audit history. Raw funding metadata is excluded from member history responses, while each funder can still view their own ledger. The latest 100 events are returned; `historyTruncated` reports older history. Events use deterministic IDs for retry safety, `mode: mock`, and `chainStatus: not_applicable`. Decision records include the server-known actor role and wallet when available. `posting_reopened` and `posting_invalidated` provide explicit lifecycle records alongside the rejection or expiry event. These are off-chain application records, not pending blockchain transactions. Historical records marked pending are also displayed as off-chain mock records.

Owner and creator approval identities/timestamps are stored independently. Evaluation completion and all matching fields are server-owned. Completing the evaluation locks proposal corrections so the evaluated content remains stable. Admin hide/remove uses an atomic settlement planner: affected pledged contributions are refunded, a pending selected match is reset, and confirmed locked contributions remain preserved. Restoring a moderated proposal restores funding eligibility with zero refunded funding and keeps its evaluation result when no confirmed match prevents it.

## Atomicity and limits

Every mutation reads and writes the problem inside a Firestore transaction, serializing competing funding, selection and settlement requests. Request IDs prevent duplicate contributions. Owner/creator retries preserve the existing decision and do not extend deadlines. Trusted time is refreshed inside transaction attempts. Expiry commits before a rejected late action so refunds are not rolled back by that rejection.

The mock supports at most 200 contribution records per problem, including refunded history, to keep settlement below 500 writes. Candidate pages contain 200 published proposals; drafts do not count, and every ledger-referenced proposal is independently loaded for settlement. New submissions or a large list cannot strand existing funds. The parent confirmed state cancels all unfunded siblings without requiring an unbounded transaction.

`expireMockMatchingWindows` runs every five minutes and checks up to 100 expired acceptance windows and 100 open mock postings past their original expiry per run, deduplicating overlapping results. Matching reads, portfolio reads and mutations also settle expired windows lazily. The deadline is enforced from server time even before the scheduler runs.

## Deployment and verification

Deploy the Functions, Firestore rules, Storage rules and Firestore indexes together, then deploy the frontend. The schedulers need Cloud Scheduler support. Existing published data requires no migration; mock state is created on the first contribution or mock evaluation. This change does not replace publication's existing blockchain audit flow.

Tests:

```sh
node --test firebase/functions/test/matching.test.mjs
cd firebase/functions
./node_modules/.bin/firebase emulators:exec --config ../firebase.json --only firestore --project qc-dao-matching-transactions 'node --test test/matching.emulator.test.mjs'
```

The unit suite covers funding eligibility and owner selection without evaluation, selection that waits for full funding, rationale validation, owner and creator rejection, admin-only demo operations, audit idempotency, moderation settlement, mutual approvals, exact deadline boundaries, refunds/locking, idempotency, roles, overfunding, moderation, privacy, candidate pagination and settlement with hundreds of new drafts/proposals. The real Firestore emulator test runs duplicate contributions, overfunding attempts and competing owner selections concurrently, and checks deadline refunds.

## In-app matching notifications

Matching events enqueue a private `matchingNotificationJobs` record. The event trigger immediately delivers owner/selected-creator notices; a one-minute scheduler resumes the remaining authors and funders in pages of 100 source records. Every proposal author is reached regardless of candidate-list pagination. Delivery and cursor updates commit together; deterministic event/recipient IDs prevent duplicate notices and preserve read acknowledgements across retries and overlapping roles.

Selection explains the creator deadline and temporary funding pause. Confirmation explains locking, cancellation and refunds. Rejection explains selected-proposal refunds and reopening until the original deadline. Expiry explains terminal invalidation and refunds of all outstanding pledges. Funding-target events notify the owner without an evaluation prerequisite. Selection notices retain the actual event deadline, including a shortened original-expiry limit, even if delivered later. Lifecycle audit events do not duplicate their primary decision notices. Notices live in the shared in-app `moderationNotifications` feed with a link to the problem. No email or external message is sent. A pending-job index and both notification functions must deploy with this module.

## Moderation (QCDAO-87–89)

Members can report a visible problem statement, their accessible proposal, or an existing discussion comment. The server applies the original content access rules, accepts one report per member/item, and limits new reports to 20 per UTC day. Reporter identities stay in the server-only report collection and are returned only to administrators. Comments attached to private proposals are never included in the problem's public discussion view. This work adds reporting for existing comments; it does not add a comment-authoring workflow.

The administrator's Content moderation tab combines member reports and rule-flagged submissions. Deterministic screening flags excessive external links, repeated text and explicit abusive phrases; screening queues review and never removes content automatically. The queue offers type/status filters, oldest/most-reported sorting, pagination, pending counts, full text and parent context, attachment downloads, reports and decision history.

Hide, remove and restore require a reason. Server-owned moderation fields preserve original workflow status and sponsor identity, so restoring a proposal restores access. Hidden/removed content is accessible only to its author and administrators and is excluded from ordinary browse, comparison, selection and revision/attachment reads. Moderation events retain the actor, reason, sequence and future on-chain status. Authors receive a private notice in Profile → Content & matching notices.

Hide/remove refunds affected outstanding mock pledges in the same transaction as the visibility change. If the selected proposal is affected, its confirmation window closes and the other proposals reopen. Confirmed locked funds remain locked. Restoration preserves the evaluation result and restores eligible proposals with zero refunded funding; it never invents new pledges.

Moderation callables: `submitContentReport`, `listModerationQueue`, `getModerationContext`, `moderateContent`, `listModerationNotifications`, `markModerationNotificationRead`, and `listReportableComments`. Three content-write triggers screen new or amended problems, proposals and comments. Queue pages contain 50 items; report/history context contains up to 100 entries; notices show the latest 50. Comment pages scan 100 records with privacy filtering and return `nextCursor`; Load more remains available even when a page contains no visible comments. Pass cursors unchanged to preserve exact timestamp precision.

## Off-chain receipts and future settlement extension

The matching panel links completed steps to immutable application decision records: selection/owner acceptance, creator acceptance, rejection, reopening and invalidation. Each record includes an event ID, server timestamp, actor identity/role, a reason when required, and the simulated settlement result. Funding actor privacy is preserved. These records are stored by the trusted application server; they are not independently verified by a blockchain, and no matching wallet transaction is requested in QCDAO-81–86.

Sprint 6 can add real escrow settlement through a separate idempotent adapter for committed decision events: `match_confirmed` locks/releases the selected allocation as specified by that sprint; `owner_declined`/`creator_declined` refund the selected proposal; `confirmation_expired`/`admin_force_expired`/`posting_expired` refund every outstanding pledge for the posting. Consume the stable event ID as an idempotency key and record real settlement separately from `mockFunding`. A future adapter must not treat simulated ledger entries as token balances or mark a real payment complete before confirmed settlement. This is a documented extension point, not a live integration or a dependency of QCDAO-81–86.

## Demo walkthrough

1. Publish a problem with a future expiry and two proposals, using different accounts for the owner and creators. Funding can start immediately. Evaluation is optional and does not block selection.
2. As a member other than the relevant creator, use **Fund proposal** to bring a proposal to its target; optionally fund its sibling partially or fully.
3. As the problem owner, open Compare proposals. Select a fully funded proposal without an evaluator recommendation and enter a rationale. Verify owner acceptance, the creator deadline and paused funding for every proposal. For a posting with fewer than seven days left, verify the shorter deadline is shown. Funders and evaluators can read the comparison and have no selection action.
4. As the selected creator, accept before the deadline to lock selected funding and refund/cancel sibling proposals. Review both acceptance records and the funder's portfolio.
5. On another selection, test rejection separately as the owner and creator. Verify selected contributors are refunded and siblings retain their existing funding/comments and reopen only until the original posting deadline. Select another funded proposal and verify its new deadline cannot exceed that original expiry.
6. On a pending selection, use the administrator's **Expire window for demonstration**, or wait for the deadline. Verify the posting is invalidated, every outstanding pledge is refunded, and further funding/selection are blocked. Also verify an open posting's original expiry closes and refunds its mock workflow.
7. Report a posting or accessible proposal, then review it under **Admin → Content moderation**. Hide/remove it, inspect the author notice, and restore it with an appropriate recorded reason.

Matching receipts are off-chain server records. The optional expert evaluation control is an administrator-operated simulation. This implementation does not simulate actual token balances, smart-contract escrow or milestone payouts.
