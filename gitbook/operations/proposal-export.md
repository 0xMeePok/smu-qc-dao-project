---
description: "How an administrator downloads an accepted posting and its comments as JSON and CSV for grading outside QC DAO."
---

# Export selected proposals

An administrator can download an accepted posting together with its selected proposal and every comment on that proposal. The same action can cover every accepted posting whose proposal was accepted in a UTC date range.

{% hint style="info" %}
Grading and token distribution happen outside QC DAO. The download is the record the sponsor uses. It does not calculate grades, token amounts, or evaluator scores.
{% endhint %}

The action is **Proposal export** in the admin workspace (`#/admin`). It calls `adminExportSelectedProposals`, which reads Firestore with the Admin SDK. Members do not gain a new way to list comments.

## Download a file

{% stepper %}
{% step %}
Open **Admin workspace**, then **Proposal export**.
{% endstep %}
{% step %}
Choose **One accepted posting** and enter its id, or choose **Accepted postings in a date range**. Dates are UTC calendar days, first day and last day included.
{% endstep %}
{% step %}
Choose **Download JSON and CSV**. Both files save together. The screen states how many postings, proposals and comments were included.
{% endstep %}
{% endstepper %}

A posting is accepted when it has an accepted proposal. That is `acceptedProposalId` after escrow release, a confirmed mock match, or a proposal whose status is `accepted` (including an accepted grant on an open funding call). A posting that is only selected, and not yet accepted, is refused.

In a date range, each accepted proposal is kept when its acceptance time falls in the range. Other proposals on the same posting stay out of that file.

## What the file contains

Each posting carries its title, summary, status, workflow status, owner, organisation, categories, amount and currency. Each selected proposal carries its title, summary, status, researcher, amount and category. Every comment on that proposal is included, including replies, deleted comments and comments a moderator has hidden or removed.

A comment has:

| Field | Meaning |
| --- | --- |
| `authorId` | The author's account id |
| `authorRole` | `user`, `evaluator` or `administrator`, as stored on the comment |
| `badge` | `evaluator` when the comment carries the server-derived Evaluator badge, otherwise empty |
| `recommendation` | `recommend`, `recommend_with_revisions` or `do_not_recommend` on an evaluator recommendation |
| `recommendationLabel` | Recommend, Recommend with revisions, or Do not recommend |
| `body` | The comment text |
| `createdAt` | When the comment was written |

The JSON file is the programmatic form. Its shape is published at `docs/schemas/selected-proposal-export.schema.json`. The CSV file has one row per comment, using the column order in that schema's `x-csv-columns` list. A selected proposal with no comments still has one row, with the comment columns empty. Categories stay in the JSON file only.

{% hint style="warning" %}
The JSON body is the exact comment text. In the CSV, a cell that starts with `=`, `+`, `-` or `@` is prefixed with an apostrophe so a spreadsheet does not treat it as a formula.
{% endhint %}

The file also repeats the notice that grading and distribution sit outside the project.

## Audit record

Every export, including one that matches nothing, writes `audits/{id}` with:

* `type`: `proposal_comment_export`
* `actor` and `actorName`
* `scope`: `posting` or `range`, plus the posting id or the two dates
* `postingCount`, `proposalCount` and `commentCount`
* `timestamp`

A single-posting export also sets `problemId`, so it appears on that posting's audit trail. A date-range export appears in the administrator's governance history. **Governance history** has a **Proposal exports** filter. The record is off-chain: the comment text is not anchored.

An export that is refused, because the posting is missing, not accepted, or too large, does not write a record.

## Limits

One export reads at most 500 accepted postings or proposals, and at most 1,000 comments on one proposal. Past either limit the call stops and returns nothing, so a file is never a silent partial extract. Export one posting, or a shorter date range.
