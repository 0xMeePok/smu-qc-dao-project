# Firestore workflow schema

Firestore rules enforce these client-writable workflow contracts. Every create uses
server timestamps for `createdAt` and `updatedAt`; every update preserves `createdAt`,
sets `updatedAt` to the server timestamp, and keeps ownership/reference fields
immutable. Amounts are numbers from 0 through 1,000,000,000.

| Collection | Required fields | Optional fields | Initial status |
| --- | --- | --- | --- |
| `problems` | Shared: `ownerId`, `organisation`, `title`, `amount`, `currency`, `categories`, `expiresAt`, `status`, `createdAt`, `updatedAt`; business problem: `summary`, `businessContext`, `currentApproach`, `currentLimitations`, `expectedOutcome`, `successCriteria`, `dataAvailability`; open funding: `opportunityType: "open-funding"`, `fundingThesis`, `eligibilityNotes`, `tags` | Both: `attachments`, `audit`; legacy drafts retain the older optional fields | `draft` or complete form submission as `submitted` |
| `proposals` | `researcherId`, `problemId`, `status`, `createdAt`, `updatedAt`; from `submitted` onwards also `title`, `summary`, `amount`, `postingOwnerId`, `opportunityType`, `category`, `currency`, and every approach field | `outcomes`, `deliverables`, `attachments`, `audit`, `withdrawalReason` | `draft` or complete form submission as `submitted` |
| `evaluations` | `evaluatorId`, `proposalId`, `title`, `score`, `feedback`, `status`, `createdAt`, `updatedAt` | none | `draft` |
| `funding` | `funderId`, `proposalId`, `problemId`, `title`, `amount`, `status`, `createdAt`, `updatedAt` | `tranches` | `pledged` |

A `proposals` document in `draft` is exempt from the submission schema, which is
what lets an unfinished proposal save; its text is bounded but nothing is
required. A draft carries **no** `postingOwnerId` — that field is the sponsor's
read ACL and their dashboard filter, so a draft that set it would appear in their
queue before it was sent. It is bound to the parent opportunity's owner on the
`submitted` path and may not be introduced on any other.

A `problems` document in `submitted` or `open` must additionally carry every
optional field above, with non-empty text, at least one category, an amount above
zero, a future expiry, and an `organisation` matching the owner's profile. Drafts
are exempt, which is what lets an unfinished form save. At most two attachments.

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

- Opportunities: `draft → submitted/open/cancelled`; `submitted → open/in_review/cancelled`; `open → in_review/matched/cancelled`; `in_review → open/matched/cancelled`; `matched → funded/completed/cancelled`; `funded → completed/cancelled`.
- Proposals: `draft → submitted/withdrawn`; `submitted → under_review/withdrawn`; `under_review → accepted/rejected/withdrawn`.
- Evaluations: `draft → submitted → accepted`.
- Funding: `pledged → approved/cancelled`; `approved → disbursing/cancelled`; `disbursing → completed/cancelled`.

An update that leaves a status unchanged is permitted when its other fields remain
valid. Terminal statuses cannot transition again from an untrusted client.

## Correcting and withdrawing a proposal (QCDAO-57)

A proposal author may correct their own work while its status is still
`submitted`. `under_review` means an evaluator has opened it, and from that point
the content is locked so the record being scored cannot move underneath them. A
correction must leave a complete, valid proposal against an opportunity that is
still open, and it may only touch the content fields — the researcher, the
opportunity, the sponsor, the opportunity type, the currency and the status are
all immutable.

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
