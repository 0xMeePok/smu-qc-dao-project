# Delivery evidence storage boundary

Both immutable evidence stores now use the same trusted quota transaction:

- Main: `proposals/{proposalId}/deliveryEvidence/{hash}` through the member callable `saveDeliveryEvidence`.
- Independent: `proposals/{proposalId}/independentFundingEvidence/{hash}` through `prepareIndependentFundingAction`.

Direct client creates, updates, and deletes are denied. Main reads keep their existing proposal visibility rules. Independent readable evidence still comes from verified funding state. Neither path changes on-chain evidence hashes, document paths, receipt recovery, voting, or refunds.

The common limits, defined in `firebase/functions/evidenceQuotas.js`, are **30 new documents per member per UTC day**, **300 globally per UTC day**, **100 per proposal for its lifetime**, **1,000 per member for their lifetime**, and **10,000 globally for the lifetime of this evidence budget**. Both evidence kinds spend these same counters. These are separate from attachment storage reservations and their ten-file cap. Existing summary/URL size limits bound the content of each document; finite document counts also bound repeated retained creations and accounting metadata.

The persistence transaction rechecks the member profile, session cutoffs, proposal author, published status, funding terms, registry maintenance, and retirement marker. The server canonicalizes and checks the existing `qcdao.escrow.delivery.v1` digest. Main URLs retain the old rules' whitespace prohibition; independent normalization remains compatible with its historical hash scheme. Proposal IDs up to 128 characters remain supported.

An authorized exact retry returns the original immutable document without changing its timestamp or counters, including when limits have been reached. Conflicting content fails. Every distinct retained document is charged even if contract simulation rejects, the wallet is cancelled, a response is lost, or no transaction is broadcast. There is no expiry, delete endpoint, or automatic refund: staged bytes are still stored. A reached lifetime limit requires an administrator's policy decision; deleting counters or resetting migration state is not a supported workaround.

## Migration and release sequence

New distinct writes fail closed until `maintenanceState/evidenceQuotasV1` has `{ version: 1, ready: true }`. Exact authorized retained retries and existing read/transaction recovery paths do not require that marker. A newly initialized empty database must run the same migration; the two empty group passes establish readiness.

1. Enable existing registry maintenance to stop member Function writes. Deploy the new evidence rules, which also stop old browser clients and queued direct SDK writes. Keep maintenance active.
2. Deploy new Functions, including `saveDeliveryEvidence` and the updated independent prepare implementation. Allow old in-flight Functions to drain before scanning. Independent prepares have a 180-second timeout; if using the existing registry cutover procedure, honor its longer 540-second drain. Do not retire or reset the database for this migration.
3. Run the bounded migration with trusted Admin credentials for the intended project:

   ```sh
   cd firebase/functions
   node scripts/backfill-evidence-quotas.mjs --project=PROJECT_ID --apply
   ```

   Each invocation processes at most ten pages of 100 documents. Re-run until `done: true`. The API is `backfillEvidenceQuotaPage({ db, now, pageSize = 100 })`; `pageSize` is limited to 1–100.
4. Verify marker readiness and accounting totals. Keep all existing evidence, including malformed, unbroadcast, orphaned, and retired-parent documents. Existing totals may exceed the new caps; reads and exact retries remain available, while new distinct writes then return a quota error.
5. Release the frontend using the callable writer and disable maintenance. Old SDK clients cannot create evidence after reconnecting; refresh and retry through the updated client. No legacy direct-create exception is retained.

The migration scans the actual `deliveryEvidence` and `independentFundingEvidence` collection groups, ordered by complete document name. It does not depend on existing proposal roots or valid digest IDs. The marker stores `version`, `ready`, `phase` (0 for main, 1 for independent), `lastPath`, and `updatedAt`. A cursor advances only after its page is charged. Concurrent or interrupted runs cannot move the cursor backwards or double charge documents.

Each retained document has one server-owned `evidenceCharges/{sha256(fullDocumentPath)}` record. The charge stores its source path, proposal path, owner bucket, charged day, and creation time. Counters live under `evidenceQuotas`. Valid legacy wallet owners are lowercased; invalid or missing owners use the explicit `legacy-invalid-owner` bucket and still spend proposal/global budgets. A valid stored Firestore creation timestamp selects its historical UTC day; malformed or missing timestamps use the migration page's UTC day. The migration leaves every evidence document unchanged and does not enforce caps against old retained data.

After readiness, all new trusted writers must use the shared persistence helper. Adding an Admin SDK writer without that helper would bypass the boundary. Retiring a parent does not free evidence charges; archival/retention cleanup is outside this change. Preserve charge and counter records during backups, restoration, and registry cutovers.

## Verification

Before the fix, the actual rules accepted 35 distinct syntactically valid digest IDs beneath one eligible proposal. The independent prepare fixture retained 35 unique unbroadcast documents and another document before a forced simulation rejection. After the fix, rules deny all direct creates, and a real Firestore transaction test checks orphaned collection-group backfill, concurrent common-budget enforcement across both stores, and immutable retries.

Focused tests cover all five limits, UTC rollover, concurrent duplicate requests, unauthorized/draft/missing parents, profile suspension and session revocation races, maintenance/retirement, canonical hashes, main URL whitespace rejection, 128-character IDs, incomplete migration, malformed owners, interrupted and concurrent migration runners, over-limit legacy datasets, and unchanged receipt/refund UI behavior.
