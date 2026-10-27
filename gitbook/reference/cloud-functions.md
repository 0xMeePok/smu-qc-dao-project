# Cloud Functions

All 93 functions exported from `firebase/functions/index.js` at `main` @ `7d3907b`, in region `asia-southeast1`. Types: **callable** (`onCall`), **trigger** (Firestore `onDocumentCreated`, `onDocumentUpdated` or `onDocumentWritten`) and **scheduled** (`onSchedule`).

Unless noted, callables require an onboarded, active member and enforce App Check outside the emulator. "Admin" means access level 1 is also required.

## Sign-in and accounts

| Function | Type | Purpose |
| --- | --- | --- |
| `exchangePrivySession` | callable | Verifies a Privy access token, resolves the embedded wallet and returns a Firebase custom token for that address. Open to signed-out callers, rate limited |
| `stampPrivyIdentity` | trigger, `users/{address}` created | Copies email and Privy id onto a new profile. Grants administrator for `ADMIN_BOOTSTRAP_EMAILS` |
| `revokeOwnSessions` | callable | Signs the caller out on every device |
| `adminListUsers` | callable, admin | Searches and pages through users |
| `adminChangeRole` | callable, admin | Sets access level 0, 1 or 2 with a reason. Cannot target yourself |
| `adminSetSuspended` | callable, admin | Suspends or reinstates an account with a reason and revokes its sessions |

## Publication and audit

| Function | Type | Purpose |
| --- | --- | --- |
| `attestPublication` | callable | Checks that a mined transaction anchors exactly this posting or proposal, then writes the proof Firestore rules require |
| `reserveResource` | callable | Reserves a record id against the member's quota before creation |
| `reserveAttachment` | callable | Reserves an attachment upload with its size and SHA-256 |
| `removeAttachment` | callable | Deletes an unpublished attachment and releases its reservation |
| `queueProposalAudit` | trigger, `proposals` written | Queues a proposal audit job |
| `confirmProposalAudit` | callable | Author asks the server to confirm a proposal's audit receipt |
| `retryPendingProposalAudits` | scheduled, every minute | Retries pending proposal audit jobs |
| `recordProposalEdit` | trigger, `proposals` updated | Writes the proposal revision trail |
| `recordOpportunityEdit` | trigger, `problems` updated | Writes the posting revision trail |
| `listAuditTrail` | callable | One chronological, filterable audit trail over records the caller may see |
| `adminListProposalAudits` | callable, admin | Pages through proposal audit jobs |
| `adminVerifyProposalAudit` | callable, admin | Re-verifies a proposal against the chain |
| `adminRetryProposalAudit` | callable, admin | Retries a job after automatic attempts are used up |

## Postings and expiry

| Function | Type | Purpose |
| --- | --- | --- |
| `lapseExpiredOpportunities` | scheduled, every minute | Expires postings past their deadline and hands off refunds. Resumes from a checkpoint |
| `adminForceExpireOpportunity` | callable, admin | Expires a posting early |
| `syncProposalOpportunityMetrics` | trigger, `proposals` written | Rebuilds the public counts on a posting |
| `syncFundingOpportunityMetrics` | trigger, `funding` written | Rebuilds funding progress on a posting |
| `syncProblemMarketplaceMetrics` | trigger, `problems` written | Rebuilds or removes the posting's public metrics |
| `sweepAttachments` | scheduled, daily 03:00 Singapore | Removes unreferenced attachments. Dry run unless enabled |

## Proposals, reviews and comments

| Function | Type | Purpose |
| --- | --- | --- |
| `listPostedProposals` | callable | Proposals on a posting that the caller may see |
| `listIndependentListings` | callable | Published, unexpired independent listings |
| `getProposalComparison` | callable | Side-by-side comparison for a posting, with evaluator feedback |
| `listMyProposalQueue` | callable | The researcher's proposals and their status |
| `listEvaluatorQueue` | callable | Proposals awaiting the evaluator's recommendation |
| `listActionItems` | callable | The **Action Needed** list for the caller |
| `listOwnerDashboard` | callable | The problem owner's postings with counts, funding and feedback readiness |
| `recordOwnerReview` | callable | Owner's interim review on a proposal |
| `listOwnerReviews` | callable | Review history for the author, owner or administrators |
| `createComment`, `editComment`, `deleteComment` | callable | Threaded comments and evaluator recommendations |

## Funding approaches

| Function | Type | Purpose |
| --- | --- | --- |
| `createFundingApproach` | callable | A funder approaches an independent proposal |
| `listFundingApproaches`, `getFundingApproach` | callable | Read approaches the caller is part of |
| `decideFundingApproach` | callable | The researcher accepts or declines |
| `recordFundingApproachAnchor`, `recordFundingApproachDecisionAnchors` | callable | Record the on-chain anchors for an approach and its decision |

## Proposal escrow

| Function | Type | Purpose |
| --- | --- | --- |
| `prepareEscrowDeposit` | callable | Checks eligibility and returns the deposit transaction to sign |
| `prepareRemovedProposalClaim` | callable | Lets a depositor claim a refund from a removed proposal without seeing its content |
| `syncEscrowFunding` | callable | Reconciles a mined funding transaction |
| `getEscrowFundingHistory`, `getEscrowFundingSummary` | callable | Funding events and totals for an escrow |
| `startEscrowSettlement` | callable | The problem owner requests selection. The platform signer then drives the payment steps |
| `getEscrowAdminCancellation` | callable | Status of an administrator cancellation |
| `startEscrowAdminCancellation` | callable, admin | Cancels an unpaid escrow with a reason |
| `queueEscrowFunding` | trigger, `proposals` written | Queues escrow work for a proposal |
| `queueEscrowPostingPause` | trigger, `problems` written | Queues an on-chain funding pause when a posting is moderated |
| `reconcileEscrowFunding` | scheduled, every minute | Sends queued platform transactions, reconciles events, handles independent funding and cancellations |
| `syncEscrowMarketplaceProgress`, `syncEscrowMarketplaceProposal`, `syncEscrowMarketplacePosting` | triggers | Keep confirmed funding progress on postings and listings current |
| `notifyEscrowWorkflow` | trigger, escrow event created | Notifies researchers and owners of selection, rejection and cancellation |

## Open funding grants and independent crowdfunding

| Function | Type | Purpose |
| --- | --- | --- |
| `getOpenFundingSummary` | callable | Pool balances and proposals for a grant call |
| `prepareOpenFundingAction` | callable | Returns the transaction for pool creation, deposits, selection, acceptance, expiry or withdrawal |
| `syncOpenFunding` | callable | Verifies the pool and records accepted proposals |
| `getFunderDashboard` | callable | The funder's calls, commitments and totals |
| `getIndependentFundingState` | callable | State of a listing's crowdfunding escrow |
| `prepareIndependentFundingAction` | callable | Returns the transaction for a crowdfunding action |
| `syncIndependentFunding` | callable | Reconciles a mined crowdfunding transaction |

## Moderation

| Function | Type | Purpose |
| --- | --- | --- |
| `submitContentReport` | callable | Report a posting, proposal or comment |
| `listModerationQueue`, `getModerationContext` | callable, admin | The moderation queue and an item's history |
| `moderateContent` | callable, admin | Hide, remove or restore with a reason |
| `listModerationNotifications`, `markModerationNotificationRead`, `markAllModerationNotificationsRead` | callable | The member's moderation notices |
| `listReportableComments` | callable | Comments the caller may report |
| `screenProblemContent`, `screenProposalContent`, `screenCommentContent` | triggers | Screen new or amended content |
| `listRemovedProblems`, `readRemovedProblem` | callable | What a member may still see of removed postings they were part of |

## Legacy mock matching and notifications

| Function | Type | Purpose |
| --- | --- | --- |
| `getMockMatching`, `fundMockProposal`, `selectMockProposal`, `confirmMockProposal`, `declineMockProposal`, `completeMockEvaluation`, `forceExpireMockMatch`, `getMockFundingPortfolio` | callable | The off-chain mock matching flow from QCDAO-81 to 86. Refused for escrow proposals |
| `expireMockMatchingWindows` | scheduled, every 5 minutes | Expires mock matching windows |
| `notifyMatchingEvent` | trigger, `matchingEvents` created | Sends notices for matching events |
| `resumeMatchingNotificationDelivery` | scheduled, every minute | Retries notice delivery |
| `remindNearingApprovalWindows` | scheduled, every 5 minutes | Reminds owners whose approval window is closing |

## Admin overview and wallet

| Function | Type | Purpose |
| --- | --- | --- |
| `adminGetActivitySummary` | callable, admin | What is happening on the platform now |
| `adminGetPlatformStatus` | callable, admin | Health of the RPC, registry, audit queue and Firestore |
| `claimWalletTokens` | callable | Relays a signed faucet claim to the Vercel faucet for the caller's own address |
