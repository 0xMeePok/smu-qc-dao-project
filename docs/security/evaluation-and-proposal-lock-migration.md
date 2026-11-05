# Evaluation expiry and first-proposal locks

Deploy the new Firestore rules before running the migration, or keep client
writes completely disabled by maintenance rules until the new rules are installed.
The rules require
new evaluation rows to carry `expiryAccepted`, and new attached submissions to
create an immutable `opportunityProposalLocks/{problemId}` in the same commit.
During migration, scheduled expiry defers the evaluation-dependent branch and
material opportunity edits fail closed. Receipt delivery, attachment-only edits,
and permitted workflow actions remain available.

Run the bounded, resumable Admin SDK migration with an explicitly selected
project and existing operator credentials:

```sh
node scripts/backfill-security-state.mjs --project=PROJECT_ID --kind=evaluations --apply
node scripts/backfill-security-state.mjs --project=PROJECT_ID --kind=proposal-locks --apply
```

Each invocation processes at most ten pages of 100 documents. Repeat each
command until it reports `done: true`. The database-injected
`backfillSecurityStatePage` entrypoint supports an authorized REST adapter where
Admin credentials are unavailable. No credential values belong in source or
logs. Deploy the new index on `evaluations(proposalId, expiryAccepted)` before
enabling the new expiry function.

`maintenanceState/evaluationExpiryV1` and
`maintenanceState/opportunityProposalLocksV1` are server-only readiness markers.
Do not set `ready: true` manually: a complete pass must create it after the new
write rules are active. The former pass preserves the original
`String(status ?? "").trim().toLowerCase() === "accepted"` interpretation,
including missing statuses, and changes no historical IDs or status text.
Existing duplicate evaluator/proposal rows remain intact; one immutable pair
slot prevents further creates. Legacy rows can still update in place while
maintaining the correct boolean. Deleting an evaluation does not free its slot.

The proposal pass freezes parents with submitted, under-review, accepted or
rejected children, plus withdrawn, hidden or removed children retaining publication
receipt evidence. Drafts and abandoned drafts do not freeze a parent. The lock survives
later withdrawal, rejection, metrics updates and child deletion. Publication
attestation and successful audit recovery also repair a missing lock for an
already published child; requesting a proof for an unpublished child does not
freeze the parent.

SDK callers creating evaluations should use
`frontend/src/lib/evaluations.js:createEvaluation`. Updates can use
`evaluationStatusUpdate`, including for legacy document IDs. New attached
publication proofs retain the reviewed parent snapshot. Submission rules compare
the live parent with that snapshot, so changing terms after proof issuance
cannot be concealed by rewriting receipt metadata.
