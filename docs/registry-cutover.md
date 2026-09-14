# Fresh testnet registry cutover

The user selected retirement of existing testnet records on 2026-09-14. The replacement uses actor-bound entity IDs (scheme 2). Existing contracts remain immutable on-chain; retirement removes their records from the active site while retaining an operator-accessible archive. Users create new opportunities/proposals afterward. User profiles, authentication, token contracts and unrelated audits are preserved.

## Preparation

- Preserve the old ABI/address in `contracts/audit-registry/legacy/arbitrumSepolia.contract.json`. Never mark scheme 2 on the old address.
- The replacement is already deployed: `0x47dA28cAEf8021dD88fe18B80e367746e0036964`, transaction `0x02f73510e1b9e1753c14f6c2c2a0ca7ce213c94f31fee101fa7b436f59a2d36a`, block `308652359`. Its source is verified on Arbiscan. **Do not redeploy it**; the local frontend and Functions manifests already match.
- Authenticate the Firebase CLI with `firebase/node_modules/.bin/firebase login --reauth`. Administrative migration scripts also require Application Default Credentials or a server-only `GOOGLE_APPLICATION_CREDENTIALS` file with access to the intended project. Never put credentials in frontend environment variables or source control.
- Inventory the actual target project and take a managed Firestore backup/export. Read-only preview of the bounded retirement pass:

```sh
node firebase/functions/scripts/retire-registry.mjs --project=PROJECT_ID --registry=OLD_ADDRESS
```

A preview reports at most 100 records per phase. It is not a whole-database inventory. The archive/migration operates on `recordReservations`, `uploadReservations`, `problems`, `proposals`, `evaluations`, `funding`, `proposalAuditJobs`, `publicationProofs`, `opportunityMetrics`, `metricContributions`, and the known `revisions`/`proposalAuthors` children. Unexpected child paths abort the run. Existing PDFs remain in Storage with permanent retirement markers protecting their namespaces.

## Coordinated maintenance

1. First deploy the maintenance Firestore/Storage rules:

```sh
firebase/node_modules/.bin/firebase deploy --config firebase/firebase.maintenance.json --only firestore:rules,storage --project PROJECT_ID
```

2. Verify client access is denied, stop active client sessions, and start the trusted maintenance marker:

```sh
node firebase/functions/scripts/retire-registry.mjs --project=PROJECT_ID --registry=OLD_ADDRESS --begin-maintenance --maintenance-rules-installed
```

Deploy the new Functions (including retirement-aware quota, attachment, and audit-history handling) and required indexes while client access is closed. The new sweeper and member resource endpoints pause while this marker is active. Allow in-flight Functions to finish: `--apply` enforces a 540-second drain from the marker's creation, matching the longest configured function. Keep maintenance active through cutover.

3. Run the bounded, resumable retirement command repeatedly until `done: true`:

```sh
node firebase/functions/scripts/retire-registry.mjs --project=PROJECT_ID --registry=OLD_ADDRESS --manifest=contracts/audit-registry/legacy/arbitrumSepolia.contract.json --apply --maintenance-rules-installed
```

Each invocation processes at most ten pages of 100 records. Every source removal and its typed archive copy commit in the same transaction. Originals are stored under `registryArchives/OLD_ADDRESS/records`, keyed by the SHA-256 of `sourcePath`; per-phase checkpoints live in the same archive. Existing reservations become permanent tombstones, keeping storage charges while the archived bytes exist. Retry never replaces an original with a tombstone. Late audit events route to the archive rather than recreating active subcollections.

4. Verify source collections and known child collections are empty, archived records match their originals, and the archive metadata is complete. Preserve the managed backup and the old manifest independently. Do not proceed if a phase failed or the archive is incomplete.

5. Synchronize the **confirmed** replacement manifest with `node frontend/scripts/sync-audit-registry.mjs --deployment=contracts/audit-registry/manifests/arbitrumSepolia.json`. Rebuild the site using its existing production Firebase/App Check configuration, deploy the Functions with the same new registry, then deploy Hosting and the final Firestore/Storage rules together. The final rules reject reuse of retired record IDs even by the original owner or an old tab with a cached proof. Clear the maintenance marker only after the registry, site and backend agree. Refresh old browser tabs.

6. Test a fresh authenticated journey: profile, draft, PDF upload/removal, opportunity publication/correction, proposal submission/correction/withdrawal, marketplace paging and metrics. Verify old IDs are rejected and archived PDFs are retained. Existing financial records are archived, so there is no old funding total to promote or certify.

Do not restore old records into a live scheme-2 namespace. Recovery requires a coordinated restore of the backup and its matching old manifest during maintenance; doing so would restore the old registry's known first-writer vulnerability. Keep the hardened rules and the archive available for investigation.
