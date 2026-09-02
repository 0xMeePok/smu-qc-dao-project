# Firestore workflow schema

Firestore rules enforce these client-writable workflow contracts. Every create uses
server timestamps for `createdAt` and `updatedAt`; every update preserves `createdAt`,
sets `updatedAt` to the server timestamp, and keeps ownership/reference fields
immutable. Amounts are numbers from 0 through 1,000,000,000.

| Collection | Required fields | Optional fields | Initial status |
| --- | --- | --- | --- |
| `problems` | `ownerId`, `title`, `summary`, `amount`, `status`, `createdAt`, `updatedAt` | `organisation`, `businessContext`, `currentApproach`, `currentLimitations`, `expectedOutcome`, `successCriteria`, `dataAvailability`, `categories`, `currency`, `expiresAt`, `attachments` | `draft` |
| `proposals` | `researcherId`, `problemId`, `title`, `summary`, `amount`, `status`, `createdAt`, `updatedAt` | `outcomes`, `deliverables` | `draft` |
| `evaluations` | `evaluatorId`, `proposalId`, `title`, `score`, `feedback`, `status`, `createdAt`, `updatedAt` | none | `draft` |
| `funding` | `funderId`, `proposalId`, `problemId`, `title`, `amount`, `status`, `createdAt`, `updatedAt` | `tranches` | `pledged` |

A `problems` document in `submitted` or `open` must additionally carry every
optional field above, with non-empty text, at least one category, an amount above
zero, a future expiry, and an `organisation` matching the owner's profile. Drafts
are exempt, which is what lets an unfinished form save. At most two attachments.

References must exist. A funding record's proposal must also refer to its stated
problem. Evaluation scores are 0–100. Lists and text fields have bounded lengths;
funding tranches require a non-negative numeric amount and one of `pending`,
`released`, or `cancelled`.

Allowed status transitions:

- Problems: `draft → open/cancelled`; `open → in_review/matched/cancelled`; `in_review → open/matched/cancelled`; `matched → funded/completed/cancelled`; `funded → completed/cancelled`.
- Proposals: `draft → submitted/withdrawn`; `submitted → under_review/withdrawn`; `under_review → accepted/rejected/withdrawn`.
- Evaluations: `draft → submitted → accepted`.
- Funding: `pledged → approved/cancelled`; `approved → disbursing/cancelled`; `disbursing → completed/cancelled`.

An update that leaves a status unchanged is permitted when its other fields remain
valid. Terminal statuses cannot transition again from an untrusted client.
