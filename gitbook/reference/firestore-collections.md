# Firestore collections

"Client access" is what `firebase/firestore.rules` allows from the browser. "Callable only" means members reach the data only through Cloud Functions, which check permissions themselves. The field-level schema for the main collections is in `docs/FIRESTORE_WORKFLOW_SCHEMA.md` and `firebase/README.md`.

## Accounts and sessions

| Collection | Holds | Client access |
| --- | --- | --- |
| `users/{address}` | Private profile: name, organisation, role, email, Privy id, `stats`, terms, suspension, session cutoff | Owner can get, create and update allowed fields. No list. No delete |
| `publicProfiles/{address}` | Name, organisation, biography and expertise only | Anyone can get one by address. No list |
| `privyIdentities/{address}` | Binding of email and Privy id written at sign-in | None |
| `sessionRevocations/{address}` | Session cutoff after sign-out or suspension | None. Rules read it |

## Postings and proposals

| Collection | Holds | Client access |
| --- | --- | --- |
| `problems/{problemId}` | Postings: funded business problems and open funding calls. The name is historical | Active members get, list (at most 50 per query), create and update within the rules. Drafts are private to the owner |
| `problems/{id}/revisions` | Server-written edit trail after publication | Members read. No writes |
| `problems/{id}/proposalAuthors/{uid}` | One-proposal-per-author slot | The author only |
| `problems/{id}/activity/latest` | Content-free change signal for live refresh | Members who can see the posting |
| `proposals/{proposalId}` | Proposals on postings and independent listings (`proposalKind: "independent"`) | Members get. List only the viewer's own or received proposals. Create and update within the rules |
| `proposals/{id}/revisions` | Server-written edit trail after submission | Members read. No writes |
| `proposals/{id}/deliveryEvidence/{hash}` | Immutable delivery evidence for escrow milestones | Author creates. Parties to the proposal read. No update or delete |
| `proposals/{id}/ownerReviews`, `ownerReviewLatest` | Owner interim reviews | Callable only |
| `proposals/{id}/activity/latest` | Content-free change signal | Members who can see the proposal |
| `opportunityMetrics/{problemId}` | Public-safe proposal counts and funding progress | Get when the posting can be browsed. No list or writes |
| `comments/{id}` | Comments, replies and evaluator recommendations | Callable only |
| `proposalFeedbackSummaries/{id}` | Evaluator feedback summaries | Callable only |
| `publicationProofs/{scope_id}` | Server proof that a record's anchor was mined | None. Rules read it |

## Funding

| Collection | Holds | Client access |
| --- | --- | --- |
| `escrowFundingEvents`, `escrowFundingSummaries`, `escrowFundingPositions` | Reconciled on-chain escrow events, totals and per-wallet positions | Callable only |
| `escrowFundingJobs`, `escrowAdminCancellationJobs`, `escrowPostingPauseJobs`, `escrowModerationVoidJobs`, `escrowModerationAnchorJobs`, `escrowRefundNotificationJobs`, `escrowRefundTriggers` | Server work queues and the platform transaction outbox | None |
| `openFundingSummaries`, `openFundingSelections` | Grant pool projections | Callable only |
| `independentFundingSummaries`, `independentFundingEvidence`, `independentFundingJobs`, `independentFundingCancellationJobs` | Independent crowdfunding state and work queues | None |
| `fundingApproaches`, `fundingApproachSlots` | Funding approaches to independent proposals | Callable only |
| `funding/{id}`, `evaluations/{id}` | Older collections from the first schema | Limited reads by the funder or evaluator. Not used by the current flows |
| `mockFunding`, `matchingEvents`, `matchingNotificationJobs` | Legacy mock matching ledger, events and notices | None |

## Moderation and governance

| Collection | Holds | Client access |
| --- | --- | --- |
| `contentReports`, `moderationQueue`, `moderationEvents`, `moderationNotifications`, `moderationReportLimits`, `moderationStats` | Reports, queue, decisions, notices, rate limits and counters | Callable only |
| `audits/{auditId}` | Administrator decisions, role changes, suspensions, session revocations, expiry actions | Administrators read. No writes |

## Server bookkeeping

| Collection | Holds |
| --- | --- |
| `proposalAuditJobs` | Proposal audit confirmation queue |
| `recordReservations`, `uploadReservations`, `uploadQuotas`, `creationQuotas` | Record and upload reservations and per-member quotas |
| `publicationAttempts` | Per-minute rate limiting for `attestPublication` |
| `metricContributions` | Inputs to `opportunityMetrics` |
| `privySessionRateLimits` | Sign-in rate limiting per source |
| `walletFaucetAttempts` | Faucet claim rate limiting per member |
| `jobState` | Checkpoints for scheduled jobs |
| `maintenanceState/registryCutover` | Marker that pauses member actions during a registry cutover |
| `registryArchives` | Archived records of a retired registry |

None of these has client access.
