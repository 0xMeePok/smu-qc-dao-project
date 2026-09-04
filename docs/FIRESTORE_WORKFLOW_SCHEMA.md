# Firestore workflow schema

Firestore rules enforce these client-writable workflow contracts. Every create uses
server timestamps for `createdAt` and `updatedAt`; every update preserves `createdAt`,
sets `updatedAt` to the server timestamp, and keeps ownership/reference fields
immutable. Amounts are numbers from 0 through 1,000,000,000.

| Collection | Required fields | Optional fields | Initial status |
| --- | --- | --- | --- |
| `problems` | Shared: `ownerId`, `organisation`, `title`, `amount`, `currency`, `categories`, `expiresAt`, `status`, `createdAt`, `updatedAt`; business problem: `summary`, `businessContext`, `currentApproach`, `currentLimitations`, `expectedOutcome`, `successCriteria`, `dataAvailability`; open funding: `opportunityType: "open-funding"`, `fundingThesis`, `eligibilityNotes`, `tags` | Business problem: `attachments`; both: `audit`; legacy drafts retain the older optional fields | `draft` or complete form submission as `submitted` |
| `proposals` | `researcherId`, `problemId`, `title`, `summary`, `amount`, `status`, `createdAt`, `updatedAt` | `outcomes`, `deliverables` | `draft` |
| `evaluations` | `evaluatorId`, `proposalId`, `title`, `score`, `feedback`, `status`, `createdAt`, `updatedAt` | none | `draft` |
| `funding` | `funderId`, `proposalId`, `problemId`, `title`, `amount`, `status`, `createdAt`, `updatedAt` | `tranches` | `pledged` |

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
