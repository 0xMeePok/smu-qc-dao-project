# Workflow repeat validation — 2 October 2026

This report distinguishes automated contract/service checks from Chrome and MetaMask actions on the local application. Both funding workflows completed through payment in the browser. Exact expiry boundaries and closed-pool withdrawals were checked through isolated integration tests.

| Automated validation | Result | Scope |
| --- | ---: | --- |
| Main funding integration | 12 groups passed | Real local EVM, canonical receipts, production services, Firestore emulator and settlement outbox |
| Open funding integration | 15 groups passed | Real local EVM, production grant services, Firestore emulator and exact dashboard accounting |
| Latest backend service/unit run | 495 passed | 37 files on the current main base, including consolidated audit additions |
| Earlier broader backend run | 475 passed | Included five real Firestore contention, moderation and pagination checks |
| Live callable integration | 64 cases validated | Local Functions/Auth/Firestore: SIWE, roles, suspension, session revocation and resource boundaries |
| Database and attachment rules | 356 cases validated | Publication, access, immutable evidence, reservations, storage and moderation |
| Frontend suite | 897 passed | 378 Node and 519 Vitest tests on the current main base; production build passed |
| Focused receipt/recovery checks | 63 passed | Follow-up checks for the receipt-handling changes |

Final verification integrated the changes with main commit `4126fda`, preserving the consolidated audit view. These runs overlap and must not be added together as a unique test total. Three callable fixtures were aligned with the local project hosts/deployment manifest; Storage fixtures were aligned with the emulator project used for cross-service profile reads. Those initial environment mismatches passed after alignment.

Main integration covered full-funding owner selection, one pending winner, a full seven-day dual handshake, sibling funding pause without premature refunds, 50% upfront release, losing-proposal refunds, both-owner final approval, optional strict weighted-majority voting, rejection by either owner, scheduler expiry and parent-lock cleanup. It also verified that earlier posting closure does not shorten the handshake.

Grant integration covered owner-only prefunding, two 50,000 USDC awards from a 100,000 pool, over-allocation rejection, researcher acceptance into separate escrows, independent 50%/50% payouts, top-ups, closing submissions and withdrawal of only unreserved custody. Dashboard amounts were checked against confirmed `depositorSummary` values. Pool custody and escrow awards were counted separately. Fresh release summaries ignored deliberately stale cached amounts and performed no settlement or cache writes.

Exact seven-day expiry/void boundaries were tested in isolated integration chains. The shared browser chain clock was kept aligned; it was not advanced to manufacture expired offers. Other backend coverage included independent listings, evaluator comments, owner reviews, comparisons, notifications, revisions, expiry, audit recovery, resource cleanup, metrics and deployment retirement.

**Chrome and MetaMask — confirmed**

- Grant: actual publication, pool creation, 100,000 USDC token approval and deposit; two actual 50,000 selections and acceptance by each researcher. Each acceptance transferred 50,000 into a separate canonical escrow. Both upfront 25,000 payments confirmed. Researcher A submitted evidence; both owners approved it and the remaining 25,000 paid. A subsequent 10,000 top-up left 110,000 deposited, 100,000 awarded, zero reserved and 10,000 available.
- Main: actual posting publication, draft save/resume, proposal publication and a 50,000 token approval/deposit. A separate fully funded fixture was selected with a seven-day timer; the posting owner and researcher approved the upfront 50,000 payment. Matching delivery evidence and both final approvals paid the remaining 50,000.
- Main voting: replaced fixture evidence with matching content, confirmed both final owner approvals and a funder vote representing exactly 50% of contributions. The final 50,000 remained held at that tie. A second vote crossed the strict majority and the final payment confirmed.
- Main rejection/refund: a locked selection was rejected and its 100,000 USDC refund was claimed through MetaMask.
- Discovery filters, 390-pixel mobile navigation and the console were checked; zero console errors were observed in those checks before the funding interactions.
- Funder dashboards, researcher proposal/payment summaries and owner action queues were checked after these transitions. The owner dashboard accounted for 500,000 committed, 225,000 released, 100,000 refunded and 175,000 held; the grant pool's unused 10,000 was separate. A cancelled but unclaimed 100,000 escrow remained held, correctly excluded from claimed refunds. The owner had exactly one remaining action: select the newly funded proposal. After integration with current main, the same totals and action were verified again; completed/refunded researcher rows had no obsolete posting countdown, paid portions stayed paid, and refunded portions showed no longer payable. Main briefs with accepted solutions showed Decision Recorded; the grant call remained open with two proposals.

Canonical local fixtures were prepared for the remaining branches using temporary Anvil impersonation solely for preparation signatures. The wallet actions listed above were performed through MetaMask. Fixture preparation did not read wallet private keys, overwrite profiles, change active contracts/manifests or advance the shared clock; all impersonations stopped afterward.

The initial proposal publication attempt overlapped fixture preparation and produced no mined failure receipt or saved hash. It published successfully after preparation stopped. Browser checks found and fixed two-confirmation reconciliation races, adjacent grant/escrow refresh, stale dashboard decisions and tracker status/deadline projections. Closing/withdrawal and exact seven-day expiry were verified automatically; the shared browser chain was not advanced to its 90-day posting deadline. Researcher B's accepted award was left after its upfront payment; independent final settlement was covered by researcher A and integration tests.

**Evidence and deployment limits**

Local evidence logs include `/tmp/qcdao-main-dashboard-repeat.log`, `/tmp/qcdao-grant-dashboard-repeat.log`, `/tmp/qcdao-backend-repeat-tests.log`, `/tmp/qcdao-repeat-callables-aligned.log` and `/tmp/qcdao-repeat-storage-aligned.log`. Read-only wallet snapshots and fixture expectations are retained in `/tmp/qcdao-shared-wallet-snapshot.json` and `/tmp/qcdao-main-branch-fixtures.json`. Final rebased suite logs are `/tmp/qcdao-backend-pure-rebased-final.log`, `/tmp/qcdao-integrated-final-frontend-tests.log` and `/tmp/qcdao-integrated-final-frontend-build.log`. The follow-up commit range also passed Gitleaks with no leaks. MetaMask was restored to its previously selected QC DAO Faucet account and public Arbitrum Sepolia RPC after testing. These temporary artifacts supplement this authored report; no credentials, private keys or transaction hashes are embedded here.

Validation used isolated local contracts and demo Firebase projects. No production deployment or production signing occurred. Rollout still requires compatible verified contract deployment, matching manifests, backend/frontend publication and the configured settlement signer. These local results do not establish that the currently hosted deployment supports the updated workflows.
