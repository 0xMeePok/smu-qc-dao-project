# Project status

As of 25 October 2026, Sprints 1 to 5 are complete and Sprint 6 (26 October to 8 November 2026) is about to start. The core workflow, the on-chain audit layer, the escrow lifecycle and Privy email sign-in are live on testnet. The remaining scope is the selected-proposal export, local-currency display, the funding entry points for email wallets, and final stabilisation and UAT.

The backlog is the Jira project [`QCDAO`](https://qc-dao-fyp.atlassian.net/browse/QCDAO).

## Epics

| Epic | Name | Jira status | Done items | What exists |
| --- | --- | --- | --- | --- |
| QCDAO-27 | Account, Authentication and Role Access | Done | 7 | Sign-in, sessions, route guards, profiles, user administration |
| QCDAO-28 | Opportunity Posting and Discovery | In Progress | 11 | Posting, drafts, open funding calls, discovery, expiry, attachments. Open: QCDAO-155 |
| QCDAO-29 | Solution Proposal and Evaluator Recommendations | Done | 9 | Proposals, tracking, evaluator queue and recommendations, comparison, owner feedback, notifications |
| QCDAO-30 | Structured Commenting and Rule-Based Grading | Done | 2 | Threaded comments. Rule-based grading was dropped in favour of the export (QCDAO-107) |
| QCDAO-31 | Blockchain Audit and Verification Layer | Done | 7 | Registry contract, hashing, anchoring, receipts, re-verification, trust indicators |
| QCDAO-32 | Owner Selection and Dual Approval | Done | 6 | Selection, seven-day window, dual approval, decline and reopen |
| QCDAO-33 | Administrator Content Moderation | Done | 4 | Reports, queue, remove and restore, audit trail entries |
| QCDAO-34 | Role-Based Dashboards and Consolidated Audit Trail | Done | 8 | Status model, role dashboards, admin dashboard, audit trail with filters |
| QCDAO-35 | Researcher-Led Proposals and Funding Approach | Done | 5 | Independent proposals, browsing, funding approaches |
| QCDAO-36 | QFT Token Creation and Simulation | In Progress | 1 | QFT contract. Open: QCDAO-107 export |
| QCDAO-37 | Testnet Funding Escrow Simulation | Done | 10 | Escrow contracts, deposits, custody lock, pooled progress, release, refunds, lifecycle view, admin cancellation, on-chain events |
| QCDAO-39 | Secondary X-Factors and Platform Polish | In Progress | 2 | Platform status dashboard, RPC performance work. Open: QCDAO-118, QCDAO-157 |
| QCDAO-153 | Integrating Privy Wallet, Dropping MetaMask | In Progress | 8 | Email sign-in, embedded wallet signing, gas sponsorship, EIP-7702, hosting config, data reset, wallet actions. Open: QCDAO-147, QCDAO-151 |

Three Done items have no epic: two security fixes (QCDAO-121, QCDAO-132) and a frontend refactor with UI tests (QCDAO-130).

## Delivery by sprint

Done Jira items per sprint, including bugs and tasks:

| Sprint | Dates | Theme | Done items |
| --- | --- | --- | --- |
| 1 | to 30 Aug 2026 | Onboarding and role access, token and test-token contracts | 9 |
| 2 | to 13 Sep 2026 | Posting and discovery, proposal submission and the audit registry (pulled forward) | 17 |
| 3 | to 27 Sep 2026 | Proposals, evaluator recommendations, commenting, owner selection and dual approval | 20 |
| 4 | to 11 Oct 2026 | Moderation, dashboards, audit trail, researcher-led proposals, escrow payments | 23 |
| 5 | to 25 Oct 2026 | Privy email sign-in and gas sponsorship, the full escrow lifecycle | 14 |
| 6 | 26 Oct to 8 Nov 2026 | Export, local currency, funding entry points, stabilisation and UAT | 7 open |

The final demo and handover is planned for 15 November 2026 (Week 13).

## Where the build differs from older documents

The proposal and the early Jira descriptions changed during the project. When they disagree with the code, the code at `main` is what runs. Known differences:

| Older description | What the code does now |
| --- | --- |
| Epics QCDAO-28, 29, 32 and 37 require qualifying evaluator recommendations before selection | Recommendations are optional and advisory. Selection needs only a fully funded proposal (changed 25 September 2026) |
| QCDAO-32 says funder voting is out of scope | Each proposal can opt into a funder vote on the final payment, which needs yes votes from funders holding strictly more than 50% of deposits. A tie fails |
| QCDAO-30 describes a rule-based comment grading model | Dropped on 14 September 2026. The selected-proposal export (QCDAO-107) replaces it and is still open |
| The proposal says the embedded wallet signs a sign-in challenge | No signature is used at sign-in. The server verifies Privy's access token and reads the wallet from Privy |
| QCDAO-81 to 86 describe an off-chain mock matching flow | Still in the code, but every proposal under the current registry uses on-chain escrow |
| Early README text says QFT is not deployed | Jira marks QCDAO-103 Done, but no deployment address is recorded in the repository. Confirm with the team before relying on it |

Some ticket numbers are missing because descoped stories were deleted rather than closed: QCDAO-42, 65, 71, 72, 73 and 120. They included the evaluation-completion gate and the comment-grading model.
