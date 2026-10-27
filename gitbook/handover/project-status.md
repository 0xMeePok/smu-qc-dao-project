# Project status

As of 27 October 2026, Sprints 1 to 5 are complete and Sprint 6 (26 October to 8 November 2026) is underway. The core workflow, the on-chain audit layer, the escrow lifecycle and Privy email sign-in are live on testnet. The selected-proposal export is in the admin workspace. The remaining scope is local-currency display, the funding entry points for email wallets, and final stabilisation and UAT.

The backlog is the Jira project [`QCDAO`](https://qc-dao-fyp.atlassian.net/browse/QCDAO).

## Epics

| Epic | Name | Jira status | Done items |
| --- | --- | --- | --- |
| [QCDAO-27](https://qc-dao-fyp.atlassian.net/browse/QCDAO-27) | Account, Authentication and Role Access | Done | 7 |
| [QCDAO-28](https://qc-dao-fyp.atlassian.net/browse/QCDAO-28) | Opportunity Posting and Discovery | In Progress | 11 |
| [QCDAO-29](https://qc-dao-fyp.atlassian.net/browse/QCDAO-29) | Solution Proposal and Evaluator Recommendations | Done | 9 |
| [QCDAO-30](https://qc-dao-fyp.atlassian.net/browse/QCDAO-30) | Structured Commenting and Rule-Based Grading | Done | 2 |
| [QCDAO-31](https://qc-dao-fyp.atlassian.net/browse/QCDAO-31) | Blockchain Audit and Verification Layer | Done | 7 |
| [QCDAO-32](https://qc-dao-fyp.atlassian.net/browse/QCDAO-32) | Owner Selection and Dual Approval | Done | 6 |
| [QCDAO-33](https://qc-dao-fyp.atlassian.net/browse/QCDAO-33) | Administrator Content Moderation | Done | 4 |
| [QCDAO-34](https://qc-dao-fyp.atlassian.net/browse/QCDAO-34) | Role-Based Dashboards and Consolidated Audit Trail | Done | 8 |
| [QCDAO-35](https://qc-dao-fyp.atlassian.net/browse/QCDAO-35) | Researcher-Led Proposals and Funding Approach | Done | 5 |
| [QCDAO-36](https://qc-dao-fyp.atlassian.net/browse/QCDAO-36) | QFT Token Creation and Simulation | In Progress | 1 |
| [QCDAO-37](https://qc-dao-fyp.atlassian.net/browse/QCDAO-37) | Testnet Funding Escrow Simulation | Done | 10 |
| [QCDAO-39](https://qc-dao-fyp.atlassian.net/browse/QCDAO-39) | Secondary X-Factors and Platform Polish | In Progress | 2 |
| [QCDAO-153](https://qc-dao-fyp.atlassian.net/browse/QCDAO-153) | Integrating Privy Wallet, Dropping Metamask | In Progress | 8 |

Three Done items have no epic: two security fixes (QCDAO-121, QCDAO-132) and a frontend refactor with UI tests (QCDAO-130).

## Epic descriptions

Copied word for word from the Jira epics on 26 October 2026.

### QCDAO-27 Account, Authentication and Role Access

Deliver Function 1 of the Function Model. Users register and log in through Firebase Authentication, select one of the five platform roles (client/problem owner, solution developer/researcher, funder, expert evaluator, administrator), optionally connect a Web3 wallet on Arbitrum Sepolia, and hold an authenticated session that carries their role.

Role-based navigation guards restrict which screens and actions each role can reach, and Firestore security rules enforce the same restrictions at the data layer so access control cannot be bypassed from the client. This epic underpins O1-KR1 (all 5 roles complete the workflow) and O1-KR4 (unauthorised route access blocked for 5/5 roles).

### QCDAO-28 Opportunity Posting and Discovery

Deliver Function 2 of the Function Model. Problem owners post structured, funded business problem statements; funders post open funding opportunities that have no fixed problem attached; solution developers browse, search and filter both.

Every posting carries an expiry window that defaults to 3 months and is adjustable at posting time. The funding requirement amount must be reached and the required qualifying evaluator recommendation comments must be submitted inside that window; otherwise the posting lapses and any escrowed funds are refunded. A qualifying evaluator recommendation comment is a visible, top-level comment by an eligible evaluator with a server-derived Evaluator badge and one required outcome: Recommend, Recommend with revisions, or Do not recommend.

This epic replaces the AS-IS reality of problem statements circulating through email, spreadsheets and separate institutional portals.

### QCDAO-29 Solution Proposal and Evaluator Recommendations

Deliver the proposal and evaluator-recommendation half of Function 3. Solution developers submit quantum or quantum-adjacent proposals, including quantum-inspired and annealing-based approaches, against a funded problem statement or an open funding opportunity. Expert evaluators do not complete a rubric, score criteria, or produce weighted metrics. Instead, an eligible evaluator posts a comment on a submitted proposal with a server-derived Evaluator badge and one required overall recommendation: Recommend, Recommend with revisions, or Do not recommend.

The evaluator recommendation-comment gate defined in the proposal lives here: the problem owner cannot select a winning solution until the required qualifying evaluator recommendation comments have been submitted. A qualifying comment is a visible, top-level comment by an eligible evaluator, carrying the server-derived Evaluator badge and one of the three required recommendation outcomes. The gate makes selection defensible without transferring selection authority to an evaluator.

### QCDAO-30 Structured Commenting and Rule-Based Grading

Deliver the commenting half of Function 3. Stakeholders comment on submitted solutions, and a rule-based grading model scores those comments to establish activity reward eligibility for the QFT token.

Evaluator recommendation comments are a separate proposal-selection workflow. An evaluator submits an Evaluator-badged comment and must choose exactly one overall recommendation: Recommend, Recommend with revisions, or Do not recommend. Evaluators do not complete a separate rubric, criterion scores, weighted score, or evaluation-completion form. Their recommendation comments support the proposal-selection workflow but are not proposal scores.

The proposal is explicit that quality metrics analysis and grading are ultimately performed externally by the sponsor. Earlier sprints therefore implement a transparent, configurable rule-based model inside the platform; later sprints pivot to an export of the selected proposal and its commenters so the sponsor can grade and distribute outside the system.

The existing QFT comment-grading model, including any configured author-role rule, remains independent of evaluator recommendations. It must not derive a grade, reward eligibility, weighting, or selection score from an evaluator's recommendation value.

### QCDAO-31 Blockchain Audit and Verification Layer

The project's primary X-Factor. Smart contracts deployed on Arbitrum Sepolia record verification hashes, timestamps and key workflow events so that stakeholders from different organisations can independently verify what happened and when, without any of them trusting a single intermediary and without exposing proposal content on-chain.

Full proposal text and user records stay off-chain in Firestore. For supported anchored events, only a deterministic hash of the canonical record, plus the event type, actor role and timestamp, goes on-chain. Anchored events include proposal submission, selection decision, dual approval, moderation actions and escrow status changes.

Following the revised evaluator workflow, evaluator recommendation comments are processed and stored server-side in Firestore. Each evaluator comment displays the role-derived Evaluator badge and carries one required overall recommendation: Recommend, Recommend with revisions, or Do not recommend. Evaluator comments have no separate evaluation metrics, criterion scores, weighted score, or completion record. Their content, badge, recommendation, hashes and comment-submission events are not stored or anchored on the smart contract; the selection workflow uses them as explicitly off-chain evidence. This epic delivers O1-KR2 and O2-KR1.

### QCDAO-32 Owner Selection and Dual Approval

Deliver Function 4's decision path. Once the required qualifying evaluator recommendation comments have been submitted and the funding requirement amount has been reached, the problem owner selects the winning solution. A 7-day approval window opens from the point those conditions are met; if the owner does not approve inside it, the selection is invalidated and escrowed funds are refunded.

A qualifying evaluator recommendation comment is a visible, top-level comment by an eligible evaluator that carries the server-derived Evaluator badge and records one required overall recommendation: Recommend, Recommend with revisions, or Do not recommend.

Acceptance also requires the solution owner to approve, forming a dual-approval handshake recorded on-chain. If the solution owner declines, escrow is refunded and the posting reopens for the remainder of its expiry window so an alternative solution can be selected. Funder voting is explicitly out of scope following the 16/08/2026 sponsor revision.

### QCDAO-33 Administrator Content Moderation

Administrators are responsible for moderating user-generated content on the platform. This epic gives them a queue and review console covering problem statements, proposals and comments, with the ability to hide, remove or restore content and to record a reason.

Because moderation changes what other stakeholders can see, every moderation action is written to Firestore and surfaced in the consolidated audit trail, so a removal cannot be made silently.

### QCDAO-34 Role-Based Dashboards and Consolidated Audit Trail

Each of the five roles gets a dashboard aggregating the items relevant to them with a consistent workflow status model (draft, submitted, under review, selected, pending approval, accepted, invalidated, refunded, decision recorded), addressing the visibility gap that is the core AS-IS pain point.

Alongside the dashboards sits the consolidated audit trail: a filterable, human-readable view of verified workflow events combining the Firestore record with its on-chain verification hash and transaction reference. Together these deliver the midterm demonstration surface and O2-KR1.

### QCDAO-35 Researcher-Led Proposals and Funding Approach

Deliver Function 5, the third sponsor scenario. A solution developer or researcher posts an independent solution proposal that is not attached to any existing problem statement. Clients and funders discover it and approach the researcher with funding interest, inverting the usual direction of the workflow.

The interaction is recorded in Firestore and selected events are verified on-chain, so a funding approach carries the same audit properties as the main workflow.

### QCDAO-36 QFT Token Creation and Simulation

Deliver the token half of Function 6. An ERC-20 QFT token is created and deployed on Arbitrum Sepolia so it can be used to incentivise participation. Distribution is performed by the sponsor based on user activity and is explicitly out of the team's scope; the platform's job is to create the token, expose balances and transfers, and produce the data the sponsor needs.

That data comes from the selected-proposal export: a JSON file and a CSV file containing each accepted posting, its selected proposal and every comment, including an evaluator's badge and overall recommendation. Quality metrics analysis and grading are performed by the sponsor outside QC DAO. See [Export selected proposals](../operations/proposal-export.md). The token does not represent funding rights, securities, revenue share, or ownership of solution outputs.

### QCDAO-37 Testnet Funding Escrow Simulation

Deliver the escrow half of Function 6 and the second X-Factor. Individuals, corporations and grant providers commit mock stablecoin-style testnet tokens (XSGD, USDC or USDT style) to a problem statement or proposal, and the escrow contract simulates deposit, lock, release, refund and cancel without any real fund custody.

Deposited funds are non-withdrawable until the posting window has elapsed. Where the funding requirement is not reached inside the window, where the required qualifying evaluator recommendation comments have not been submitted, where no solution is selected, where the owner misses the 7-day approval window, or where the solution owner declines, escrowed funds are refunded to their depositors. Evaluator comments replace rubric scores and weighted evaluation metrics; each qualifying comment has the server-derived Evaluator badge and one required recommendation: Recommend, Recommend with revisions, or Do not recommend. This epic delivers O2-KR2 and O2-KR4.

### QCDAO-39 Secondary X-Factors and Platform Polish

The proposal names Chainlink-based local currency display and a platform status dashboard as secondary X-Factors, explicitly subordinate to the core workflow, audit verification and escrow simulation. This epic also carries visual and responsive refinement and notification polish.

Everything in this epic is a candidate for descope if core MVP scope is at risk. Nothing here should be started while any Highest or High priority item in Sprints 1 to 6 remains open.

### QCDAO-153 Integrating Privy Wallet, Dropping Metamask

The Jira epic has no description.

## Delivery by sprint

Done Jira items per sprint, including bugs and tasks:

| Sprint | Dates | Theme | Done items |
| --- | --- | --- | --- |
| 1 | to 30 Aug 2026 | Onboarding and role access, token and test-token contracts | 9 |
| 2 | to 13 Sep 2026 | Posting and discovery, proposal submission and the audit registry (pulled forward) | 17 |
| 3 | to 27 Sep 2026 | Proposals, evaluator recommendations, commenting, owner selection and dual approval | 20 |
| 4 | to 11 Oct 2026 | Moderation, dashboards, audit trail, researcher-led proposals, escrow payments | 23 |
| 5 | to 25 Oct 2026 | Privy email sign-in and gas sponsorship, the full escrow lifecycle | 14 |
| 6 | 26 Oct to 8 Nov 2026 | Export, local currency, funding entry points, stabilisation and UAT | 1 built, 6 open |

The final demo and handover is planned for 15 November 2026 (Week 13).

## Where the build differs from older documents

The project proposal and some older repository text describe earlier designs. When they disagree with the code, the code at `main` is what runs. Known differences:

| Older description | What the code does now |
| --- | --- |
| The proposal says the embedded wallet signs a sign-in challenge | No signature is used at sign-in. The server verifies Privy's access token and reads the wallet from Privy |
| `firebase/MOCK_MATCHING.md` describes an off-chain mock matching flow | Still in the code, but every proposal under the current registry uses on-chain escrow |
| Early README text says QFT is not deployed | Jira marks QCDAO-103 Done, but no deployment address is recorded in the repository. Confirm with the team before relying on it |

Some ticket numbers are missing because descoped stories were deleted rather than closed: QCDAO-42, 65, 71, 72, 73 and 120. They included the evaluation-completion gate and the comment-grading model.
