# Firestore workflow schema

Firestore rules enforce these client-writable workflow contracts. Every create uses
server timestamps for `createdAt` and `updatedAt`; every update preserves `createdAt`,
sets `updatedAt` to the server timestamp, and keeps ownership/reference fields
immutable. Amounts are numbers from 0 through 1,000,000,000.

| Collection | Required fields | Optional fields | Initial status |
| --- | --- | --- | --- |
| `problems` | Shared: `ownerId`, `organisation`, `title`, `amount`, `currency`, `categories`, `expiresAt`, `status`, `createdAt`, `updatedAt`; business problem: `summary`, `businessContext`, `currentApproach`, `currentLimitations`, `expectedOutcome`, `successCriteria`, `dataAvailability`; open funding: `opportunityType: "open-funding"`, `fundingThesis`, `eligibilityNotes`, `tags` | `attachments`, `audit`, `withdrawalReason`; server-only: `expiryReason`, `expirySource`, `expiryActor`, `expiryActorName`, `expiredAt`; legacy drafts retain the older optional fields | `draft` or complete form submission as `submitted` |
| `proposals` | Attached: `researcherId`, `problemId`, `status`, `createdAt`, `updatedAt`; from `submitted` onwards also `title`, `summary`, `amount`, `postingOwnerId`, `opportunityType`, `category`, `currency`, and every approach field. Independent (`proposalKind: "independent"`): `researcherId`, `proposalKind`, `status`, timestamps; from `submitted` onwards also `title`, `summary`, `methodology`, `addressedProblems`, `maturity`, `team`, `category`, `amount`, `currency`, `expiresAt`. Independent records omit `problemId`, `postingOwnerId`, and `opportunityType`. | `attachments`, `audit`, `withdrawalReason`; attached also `outcomes` / `deliverables`; independent also optional draft `expiresAt` | `draft` or complete form submission as `submitted` |
| `evaluations` | `evaluatorId`, `proposalId`, `title`, `score`, `feedback`, `status`, `createdAt`, `updatedAt` | none | `draft` |
| `funding` | `funderId`, `proposalId`, `problemId`, `title`, `amount`, `status`, `createdAt`, `updatedAt` | `tranches` | `pledged` |

A `proposals` document in `draft` is exempt from the submission schema, which is
what lets an unfinished proposal save; its text is bounded but nothing is
required. A draft carries **no** `postingOwnerId` — that field is the sponsor's
read ACL and their dashboard filter, so a draft that set it would appear in their
queue before it was sent. It is bound to the parent opportunity's owner on the
`submitted` path and may not be introduced on any other.

Independent proposals are a distinct shape in the same collection. They carry
immutable `proposalKind: "independent"` and **must not** set `problemId` or
`postingOwnerId`. The author owns the listing (`researcherId`). Publication uses
the same proposal statuses. The listing's own `expiresAt` is chosen from the
documented 30 / 60 / 90 / 180 day windows. On-chain, an independent listing is
anchored as AuditRegistry kind `FundingRequest` (2) under **hash scheme 2**,
because `commitProposal` requires a live parent opportunity. Attached proposals
keep hash scheme 1 and their frozen v1 field list; adding independent fields
must not change those historical hashes.

Onboarded members browse published, unexpired independent listings through the
`listIndependentListings` callable. Client `list` on `proposals` stays
author/sponsor-only; members `get` a published independent record by id.

A `problems` document in `submitted` or `open` must additionally carry every
required published-content field for its type, with non-empty text, at least one
category, an amount above zero, a future expiry, and an `organisation` matching the
owner's profile. Drafts are exempt, which is what lets an unfinished form save. At
most two attachments.

Both opportunity kinds have that exemption. Open funding did not until QCDAO-57:
every field was required on every write, so an unfinished funding call had
nowhere to go. A draft of either kind is bounded but never required, and is held
to the full contract only on the write that leaves `draft`.

Attachments are also shared by both kinds as of QCDAO-57 — a funder's call has
terms and scope notes worth sharing as a PDF, exactly as a problem statement
does. The same two-entry cap, PDF-only rule and `problems/{ownerId}/{id}/` storage
path apply, so `storage.rules` needed no change.

Open funding anchors its attachments the way a posting does, with one difference:
the key is **omitted** from the canonical payload when there are none, rather than
sent as an empty list. Every open-funding opportunity anchored before QCDAO-57 has
no attachments, and adding `attachments: []` to their payload would change their
content hash and break verification of all of them.

References must exist. A funding record's proposal must also refer to its stated
problem. Evaluation scores are 0–100. Lists and text fields have bounded lengths;
funding tranches require a non-negative numeric amount and one of `pending`,
`released`, or `cancelled`.

## Discover aggregates

`opportunityMetrics/{problemId}` is a server-owned projection used by Discover and
the posting detail page. Firestore triggers rebuild it whenever the opportunity or
a related proposal/funding record is created, updated, moved, or deleted. This also
keeps the percentage correct when the requested amount changes and removes stale
metrics when an opportunity is deleted. The document contains only public-safe totals:

- `proposalCount` counts `submitted`, `under_review`, `accepted`, and `rejected`
  proposals. Drafts and withdrawn proposals remain private and do not affect the
  marketplace count.
- `fundedAmount` sums `pledged`, `approved`, `disbursing`, and `completed` funding.
  Cancelled funding does not count.
- `fundingProgressPercent` is derived from the opportunity's requested amount and
  capped at 100 for display.

Clients may retrieve one metrics document when they can browse its corresponding
opportunity, but cannot list, create, update, or delete aggregate documents. The
underlying proposal and funding records keep their role-scoped read rules.

`problems` is the shared opportunity feed, despite its legacy collection name.
Missing `opportunityType` means `business-problem`; `open-funding` is a separate
shape with no fixed-problem fields or attachments. The discriminator is immutable
because it maps to the immutable `OpportunityKind` stored by `AuditRegistry`.

Allowed status transitions:

- Opportunities: `draft → submitted/open`; `submitted → open/cancelled`; `open → cancelled`; `in_review → cancelled`. `submitted` and `open` may transition to server-only `expired`. Clients cannot move a live posting to `in_review` or `matched` (those leave the lapse query and marketplace read ACL). `expired` is terminal.
- Proposals: `draft → submitted/withdrawn`; `submitted → under_review/withdrawn`; `under_review → accepted/rejected/withdrawn`.
- Evaluations: `draft → submitted → accepted`.
- Funding: `pledged → approved/cancelled`; `approved → disbursing/cancelled`; `disbursing → completed/cancelled`.

An update that leaves a status unchanged is permitted when its other fields remain
valid. Terminal statuses cannot transition again from an untrusted client.

## Withdrawing an opportunity (QCDAO-57)

A problem owner or funder may withdraw their own live opportunity (`submitted`,
`open`, or `in_review`) the same way a researcher withdraws a proposal: the
wallet signs `withdrawOpportunity` first, then Firestore stores `status:
cancelled` and the `withdrawalReason`. A declined transaction leaves the
opportunity listed. Retrying after a successful anchor only repeats the
Firestore write, with the anchored reason locked.

Withdrawal requires a non-empty `withdrawalReason` of at most 1,000 characters.
The reason is frozen once written. Discover still only lists `submitted` and
`open`, so a withdrawn opportunity leaves the marketplace; members who already
have access may still read it, including the reason. Existing proposals are not
cascade-withdrawn — the chain simply refuses new commits against a withdrawn
opportunity.

## Correcting an opportunity (QCDAO-57)

A problem owner or funder may correct their own live posting (`submitted` or
`open`) the same way a researcher corrects a proposal: the wallet signs
`updateOpportunity` first, then Firestore stores the new content and a pending
audit receipt. Full content is allowed only while `opportunityMetrics.proposalCount`
is zero. After the first proposal, the write may only touch `attachments`,
`audit` and `updatedAt`.

### `problems/{problemId}/revisions/{revisionId}`

The post-publication edit trail for both problem statements and open funding
calls. **Server-owned**: `recordOpportunityEdit` computes the diff with the
Admin SDK, and no client may create, update or delete an entry. Each entry
carries `changedFields`, `actor`, `at`, `previousStatus`, `status`, the content
hash before and after, `withdrawalReason` on a withdrawal, and expiry fields when
applicable. Draft saves are absent.

## Correcting and withdrawing a proposal (QCDAO-57)

A proposal author may correct their own work while its status is still
`submitted`. `under_review` means an evaluator has opened it, and from that point
the content is locked so the record being scored cannot move underneath them. A
correction must leave a complete, valid proposal against an opportunity that is
still open, and it may only touch the content fields — the researcher, the
opportunity, the sponsor, the opportunity type, the currency and the status are
all immutable.

Independent listings (`proposalKind: "independent"`) use the same `submitted`
correction window, but they have no parent posting. Rules must not
`get(problems/{problemId})` on that path. Allowed content keys include
`addressedProblems` and `maturity`. Currency, `expiresAt`, attachments,
`proposalKind` and escrow `fundingTerms` stay frozen. Edit and withdraw are
blocked once escrow has deposits or matching is locked, without calling
`getMockMatching` on a parent. On-chain, an independent amendment is
`updateOpportunity` and a withdrawal is `withdrawOpportunity` (hash scheme 2),
not `updateHashes` / `withdrawProposal`.

A correction may not carry a `confirmed` `audit` receipt, because that is a
server attestation about the content the edit has just replaced. Anything still
in flight is accepted — including the `pending` receipt for the `updateHashes`
amendment the author has just had mined, which is how a correction normally
arrives now that the chain is written first — as is no receipt at all. This is
the only place a `confirmed` receipt may be dropped; doing so destroys a receipt
rather than minting one.

Withdrawal is also signed before it is stored: `withdrawProposal` anchors a hash
of the exact reason, so the chain holds proof of the words given and Firestore
holds the text. A declined transaction leaves the proposal in evaluation.

Withdrawal requires a non-empty `withdrawalReason` of at most 1,000 characters.
The reason is frozen once written — rewriting the stated reason after the fact is
precisely what the audit layer exists to prevent — and it cannot be set on a
proposal that is not being withdrawn. Withdrawal releases the author's
`proposalAuthors` slot, so a replacement can be filed while the opportunity is
open, and removes the proposal from the marketplace count, evaluation and
selection.

### `proposals/{proposalId}/revisions/{revisionId}`

The post-submission edit trail. **Server-owned**: a Firestore trigger
(`recordProposalEdit`) computes the diff with the Admin SDK, and no client may
create, update or delete an entry — a record the edited party can forge or erase
settles no dispute, which is the only reason it exists. Each entry carries
`changedFields`, `actor`, `at`, `previousStatus`, `status`, the content hash
before and after, and `withdrawalReason` on a withdrawal.

Both parties may read the trail. `researcherId` and `postingOwnerId` are copied
onto every entry so authorisation needs no document lookup and a long history
stays within Firestore's per-query document-access limit; a query must therefore
carry the matching equality filter. Entries are keyed on the trigger's event id,
so a retried Firestore event cannot double-count one edit.

Draft saves are deliberately absent from the trail. A draft is private,
unevaluated and rewritten freely by design, so recording every save would bury
the entries a dispute actually turns on.

## Owner interim review

The designated problem owner (`problems.ownerId`, including the funder who owns an open-funding posting) may record an interim review on a proposal that is still under consideration (`submitted` or `under_review`, parent matching still `open`, and the proposal not already in a winner-selection state).

Outcomes are `feedback`, `revision_requested`, and `not_progressing`. Each requires a rationale of 10–2000 characters. The record stores `actorId`, `actorRole` (`problem_owner`, server-derived), `outcome`, `rationale`, and `createdAt`.

`revision_requested` is accepted only while the author can already correct the proposal: status `submitted`, no mock funding, evaluation not complete, and matching still open. It leaves the proposal `submitted` so the author uses the existing edit path. It does not unlock a funded, evaluated, or `under_review` proposal.

These records do not set `selected`, `awaiting_confirmation`, `accepted`, or `rejected`, and they do not call winner selection or rejection. Evaluator recommendation comments stay advisory and cannot create a review.

### `proposals/{proposalId}/ownerReviews/{reviewId}`

Append-only and server-owned. Clients cannot read or write the subcollection or `ownerReviewLatest/current`. The author, the designated owner, and administrators read the trail through `listOwnerReviews`. The author's queue reads the latest summary through `listMyProposalQueue`. A retried submit with the same `requestId` returns the original record.

## Workflow status model (QCDAO-91)

Stored fields keep their values; what members see is derived from them by one
shared module, `firebase/functions/workflowStatus.js`, which Cloud Functions and
the frontend both import (`frontend/src/config/workflowStatus.js` re-exports it).
It holds the enumeration and, per status, the label, colour tone, icon, what it
means and what happens next. The frontend renders every status through
`StatusBadge`, whose tooltip shows that meaning; the full legend is on the help
page (`#/architecture`). `frontend/test/unit/workflow-status.test.js` fails if a
status is rendered outside the mapping.

| Status | Shown for |
| --- | --- |
| Draft | `problems.status` or `proposals.status` = `draft` |
| Submitted | opportunity `submitted` / `open` / `in_review`; proposal `submitted` / `under_review` while open, fully funded or paused |
| Awaiting evaluator feedback | proposal with no qualifying evaluator recommendation (a second badge beside its lifecycle status) |
| Selected | proposal `matching.status` = `awaiting_confirmation` |
| Pending approval | opportunity `matching.status` = `awaiting_confirmation`; a pledged contribution |
| Accepted | proposal `matching.status` = `confirmed` (or legacy `accepted`); a locked contribution |
| Decision recorded | opportunity `matching.status` = `confirmed` (or legacy `matched` / `funded` / `completed`) |
| Invalidated | opportunity `matching.status` = `invalidated`; its selected proposal (`voided`) |
| Declined | opportunity `cancelled` (owner withdrew); proposal `withdrawn`, `rejected` or `matching.status` = `declined` |
| Expired | opportunity `expired`, or still open past `expiresAt` |
| Refunded | proposal `matching.status` = `cancelled`, or not chosen when another proposal was confirmed; a refunded contribution |

Evaluator outcomes (`Recommend`, `Recommend with revisions`, `Do not recommend`)
and owner review outcomes (`Feedback recorded`, `Revision requested`,
`Not progressing`) are entries in the same mapping. Matching events map to the
status they leave behind for the decision record, and member notices store it as
`workflowStatus` (older notices derive it from `kind` or `eventType`).

With two or more evaluations a proposal shows one `Combined evaluations` badge
("3 evaluations"): one icon per outcome given, a lone outcome shown twice; green
if all recommend, red if none do, amber otherwise. Hovering lists how many
recommended, recommended with revisions, and did not recommend.

### `proposals/{proposalId}.matching.recommendations`

Server-maintained map of evaluator id → `{ commentId, recommendation, at }`, one
entry per evaluator with a qualifying recommendation. It is rebuilt from the
qualifying comments on every comment write, so proposals that still carry the
earlier single `recommendedBy` / `recommendationCommentId` / `recommendation`
fields converge to the map on their next comment write; readers fall back to
those fields until then.
