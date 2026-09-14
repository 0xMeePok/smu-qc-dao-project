# QCDAO-131–139 remediation and verification

Date: 2026-09-14. Source: Jira QCDAO-131 through QCDAO-139, read in the signed-in Chrome session.

**Outcome: local remediation and 939 automated tests pass; the fresh registry is deployed, and the live Firebase cutover requires deployment authentication.** The fresh registry is deployed and source-verified at `0x47dA28cAEf8021dD88fe18B80e367746e0036964` (Arbitrum Sepolia, scheme 2). Both local manifests match. The user authorized retiring the old testnet registry records and selected a simple wallet-based test faucet with no shared budget service. Production records have not been retired; nothing has been changed in Jira.

## Changes and security evidence

| Issue | Enforcement and regression evidence |
| --- | --- |
| 131 | `attestPublication` verifies the mined transaction, actor, configured chain/registry, exact canonical content and confirmations before writing a server-only publication proof. Firestore requires an exact matching proof for submitted creates, draft promotion and content corrections; the existing atomic proposal-author slot is preserved. Raw SDK tests reject missing and stale proofs. Verifier tests reject altered content, wrong actors/contracts/chains, reverts, reorgs, withdrawn opportunities and changed attachment bytes. Both opportunity creation pages now supply the mined receipt to the attestation call. |
| 132 | Marketplace queries fetch 25 unexpired records at a time using Firestore cursors. Rules reject unbounded queries and limits above 50. The owner dashboard has a separate 50-record cursor and a load-older control; a component test retrieves and resumes draft number 51. Server-owned reservations cap unique creation at 30 records per member per UTC day and 300 globally. |
| 133 | Clients cannot create, amend or delete financial lifecycle records. Aggregation counts only server-owned records marked verified. Historical unverified funding totals are suppressed in the frontend. A resumable migration rebuilds existing projections without rewriting source records. Tests cover forged client writes, all formerly counted statuses, valid server funding and migration/retry behavior. The current funding portfolio remains a read-only view; no payment verifier or new payment workflow is introduced. |
| 134 | Uploads require expiring server reservations bound to owner, exact tuple/path, size and digest. Reservation IDs use dot separators because dots are excluded from record and attachment IDs; underscore-bearing IDs therefore cannot alias one reservation. Limits are 10 MiB per file, 10 files/100 MiB per record, 500 MiB per member and 5 GiB of additional globally reserved storage. Publication seals referenced files. Direct client deletion is denied; trusted removal closes recreation first and refunds quota only after successful deletion. Failed and cancelled client uploads invoke that trusted cleanup immediately, with the scheduled sweeper as fallback. Cleanup paginates both object namespaces and reservation scans, retains published history, and resumes past retained rows. Tests cover raw alias uploads, alias removal/refunds, concurrent quota use, failed deletion, nonexistent-path tombstone abuse, sealing, cleanup races and pagination starvation. |
| 135 | **User-selected testnet policy:** the token contract maps each wallet to its next claim time (one hour) and permits mints only from the owner. The API validates signed wallet requests, uses a courtesy in-memory throttle, and checks fees, gas and signer balance before sending. There is no external budget database. Separate testing wallets may mint; aggregate issuance and cross-instance gas budgets are intentionally outside the requested policy. This does not claim to eliminate Sybil gas consumption. |
| 136 | Both HTTP adapters count raw chunks before retaining or parsing more than 8 KiB. The Vercel adapter never accesses its parsed `request.body` helper, and the Vercel build disables Node helpers. Tests exercise chunked bodies without Content-Length, early cancellation, whitespace/duplicate-key amplification, malformed lengths and a normal malformed-JSON control. |
| 137 | The replacement Solidity contract enforces the intended actor in the first 20 bytes of each new entity ID. Tests reject copied proposal and opportunity IDs before the owner commits, including attacker-first block ordering. Shared canonical helpers and manifest synchronization support ID scheme 2 while keeping legacy IDs reproducible. The user selected retirement and a fresh registry. The old manifest is archived, and bounded retirement tooling prevents old-ID reuse while retaining records and PDFs. The live site cutover remains pending. |
| 138 | Verification enforces App Check in production, maxInstances=10, a 2,048-byte signature limit, atomic limits of 10 attempts per nonce, 30 per source/minute and 300 globally/minute. Invalid attempts spend quota before cryptography but do not consume the nonce. Emulator tests cover concurrent failures, address rotation from one source, malformed input, honest sign-in and replay rejection. |
| 139 | Draft-only and contribution-neutral events skip aggregation. Relevant events reread the current source and its stored contribution, updating at most two parents transactionally. Event retries, duplicate/out-of-order delivery, concurrent changes, moves and deletions converge without collection scans. Trigger concurrency is capped. Tests use 10,000 unrelated drafts and verify bounded reads; the migration also restores historical counts. |

Implementation is concentrated in `firebase/functions/{index,publication,resourceQuotas,opportunityMetrics,metricsMigration,attachmentSweeper,auditCanonical}.js`, Firestore/Storage rules and indexes, frontend publication/upload/listing callers, and the registry/faucet packages. Tests live beside their owning packages. The security skill's fresh investigator and independent bypass reviewer were used; confirmed review findings were addressed.

## Validation

942 automated tests pass across the six suites below, including the approved retirement and testnet faucet policy.

| Gate | Command | Result |
| --- | --- | --- |
| Frontend regressions | `npm test --prefix frontend` | 195 Node + 234 component tests passed |
| Firestore/Storage boundaries | `PATH=/opt/homebrew/opt/openjdk/bin:$PATH npm test --prefix firebase` | 268 passed |
| Functions unit/integration | `PATH=/opt/homebrew/opt/openjdk/bin:$PATH npm test --prefix firebase/functions` | 153 passed |
| Registry compilation, unit, fuzz and workflows | `npm test --prefix contracts/audit-registry` | 63 passed |
| Faucet lint, server types, unit/integration and production build | `npm test --prefix contracts/stable-faucet/site` | 25 passed; lint, TypeScript and build passed |
| Faucet token contract | `npm test --prefix contracts/stable-faucet` | 4 passed: exact mint amount, cooldown, expiry and owner-only minting |
| Deployed replacement registry | `npm run verify:arbitrum-sepolia --prefix contracts/audit-registry` | Bytecode matches; intended-owner simulation succeeds; foreign actor reverts with AccessDenied; no transaction sent |
| Main-site production build | `npm run build --prefix frontend` | Passed; existing large-chunk and mixed-import warnings remain |
| Patch hygiene | `git diff --check` | Passed |

Chrome checked the local main site at `http://127.0.0.1:5173`: Home, Discover, wallet selection/cancellation, mobile menu/navigation at 390×844 and horizontal overflow. Home content width matched the viewport. No app-origin console errors were observed; installed wallet extensions emitted provider-conflict and local-origin authorization errors. The temporary viewport override was reset. Authenticated flows were covered by component and emulator tests; an actual wallet-signing journey and deployed end-to-end tests remain unverified.

The final runs use scheme 2 fixtures and sequential emulator suites because concurrent files share rate-limit counters and mutable emulator rules. This resolves the observed authentication quota interference and Storage test stall without weakening production enforcement. Earlier failures are superseded by the final passing runs.

The rebuilt faucet was also inspected in Chrome at `http://127.0.0.1:5174`. Its assets, claim amounts and one-hour policy render correctly. The installed MetaMask extension failed to connect; no real browser mint was performed. API tests cover successful signed claims without an external store, cooldown rejection, independent wallets, duplicate claims, nonce-race retry and failed receipts.

## Rollout status and remaining work

The user authorized retiring existing testnet opportunities/proposals for a fresh actor-bound registry. See [the cutover procedure](registry-cutover.md) for maintenance rules, typed archival, permanent retirement markers, preservation of PDFs, synchronized manifests and live validation. No further migration-policy approval is needed.

Firebase CLI project discovery returned `Failed to authenticate, have you run firebase login?`. Live record retirement, Functions/rules/Hosting deployment and deployed end-to-end testing remain blocked by deployment access. The migration also needs an administrative Firebase credential (Application Default Credentials or `GOOGLE_APPLICATION_CREDENTIALS`). Production build configuration and App Check settings must be supplied by the existing deployment environment.

The faucet requires only its existing RPC, dedicated testnet key and token addresses. The shared-budget implementation and its service configuration were removed at the user's request. `vercel.json` retains build-time `NODEJS_HELPERS=0` for the raw body limit; verify this in the actual deployment output. No faucet deployment credentials or local Vercel project configuration were available in this workspace.

After the coordinated cutover, exercise a valid sign-in, draft, upload/removal, publication/correction, proposal submission/correction/withdrawal, pagination, metrics update and faucet claim. Confirm deployed App Check, indexes, scheduled cleanup and actor-bound registry enforcement. These live checks have not run.

Vercel parsing behavior and helper controls were verified against the [official runtime documentation](https://vercel.com/docs/functions/runtimes/node-js#request-body) and [Node builder source](https://github.com/vercel/vercel/blob/main/packages/node/src/build.ts).
