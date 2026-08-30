# Firestore workflow schema

Firestore rules enforce these client-writable workflow contracts. Every create uses
server timestamps for `createdAt` and `updatedAt`; every update preserves `createdAt`,
sets `updatedAt` to the server timestamp, and keeps ownership/reference fields
immutable. Amounts are numbers from 0 through 1,000,000,000.

| Collection | Required fields | Optional fields | Initial status |
| --- | --- | --- | --- |
| `problems` | `ownerId`, `title`, `summary`, `amount`, `status`, `createdAt`, `updatedAt` | `outcomes`, `deadline`, `benefits`, `deliverables`, `type`, `opportunityType` | `draft` |
| `proposals` | `researcherId`, `problemId`, `title`, `summary`, `amount`, `status`, `createdAt`, `updatedAt` | `outcomes`, `deliverables` | `draft` |
| `evaluations` | `evaluatorId`, `proposalId`, `title`, `score`, `feedback`, `status`, `createdAt`, `updatedAt` | none | `draft` |
| `funding` | `funderId`, `proposalId`, `problemId`, `title`, `amount`, `status`, `createdAt`, `updatedAt` | `tranches` | `pledged` |

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
