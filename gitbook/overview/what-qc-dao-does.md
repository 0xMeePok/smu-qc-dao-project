# What QC DAO does

QC DAO lets organisations that do not fully trust each other run one shared funding workflow for quantum and quantum-adjacent solutions. Content stays in Firebase. The decisions that people might later dispute, such as when a proposal was submitted, which proposal was selected and where escrowed money went, are anchored on Arbitrum Sepolia so anyone can check them.

SMU is the pilot. Cross-organisation behaviour is shown with simulated stakeholders, test data and mock stablecoins on a testnet. No real money moves.

## Who uses it

Every account is identified by the wallet address that Privy creates for its email. Access is controlled by one number on the user's profile, `users/{address}.role`, which only the server can change.

| Access level | Who | Capabilities in the app | How it is granted |
| --- | --- | --- | --- |
| Guest | Anyone not signed in | Browse Home and Discover, read published postings | Default |
| `0` member | Every new account | Problem owner, researcher and funder | Automatic on first sign-in and onboarding |
| `2` evaluator | Members trusted to review | Member capabilities plus the evaluation queue | An administrator, in **Admin Audit, Users & access** |
| `1` administrator | Platform operators | Admin workspace only: moderation, users, escrows, audit records, service health | `ADMIN_BOOTSTRAP_EMAILS` on first sign-in, or another administrator |

One account can act in several roles. A member can post a problem, submit a proposal elsewhere and fund a third posting without switching accounts. Administrators deliberately get only the admin workspace.

## Main workflows

### Funded business problem (main workflow)

1. A problem owner posts a structured problem statement with a funding amount, technology categories, optional PDF attachments and an expiry window of 30, 60, 90 or 180 days (90 by default). The wallet anchors a hash of the posting before Firestore stores it.
2. Researchers submit proposals with a requested amount, a currency (mock XSGD, USDT or USDC) and a fixed 50% upfront, 50% on completion payment plan. Each proposal gets its own on-chain escrow.
3. Evaluators may post one recommendation comment per proposal: Recommend, Recommend with revisions, or Do not recommend. Recommendations are advisory. The problem owner can also record interim feedback.
4. Funders deposit test tokens into a proposal's escrow, up to its requested amount. Deposits stay locked until the posting window ends, unless a refund opens earlier.
5. When a proposal is fully funded, the problem owner selects it. Selection opens a seven-day window and pauses funding of the other proposals. Both owners must approve before the first 50% is released.
6. The researcher submits delivery evidence. Both owners approve it, and if the proposal chose funder voting, funders holding more than 50% of the deposits must also vote yes. The final 50% is then released.
7. A 0.1% platform fee (10 basis points) is taken from each payout. Deposits and refunds carry no fee.
8. Funders can claim refunds when the target is not met, nothing is selected, the window expires, either owner declines, or an administrator cancels an unpaid escrow. A decline reopens the posting for the rest of its window.

### Open funding call (grant pool)

A funder posts a call without a fixed problem. The form does not ask for a funding amount. The saved `amount` is `0` so older audit payloads still validate, and it is not a balance. Discover and proposal sidebars say **View grant pool**. The funder then deposits test tokens into a single-owner pool. `getOpenFundingSummary` reads that pool's deposited, reserved and available balances from the `OpenFundingPool` contract. Researchers propose problems and solutions against the call. The funder can select several proposals while the pool covers them. Each selected researcher has seven days to accept, which moves the requested amount into that proposal's escrow. After the call closes, the funder can withdraw unreserved funds.

### Researcher-led proposals

A researcher can publish an independent proposal that is not tied to any posting. Funders and problem owners discover it under **Solutions** and either send a funding approach, which the researcher accepts or declines, or contribute to the listing's own crowdfunding escrow. Crowdfunding pays 50% when the researcher accepts a fully funded listing. The final 50% needs two things: funders holding more than half of the deposits vote yes on the completion evidence, and an administrator then reviews that evidence and releases the payment through the platform signer. A researcher who also funds their own listing can therefore not vote the final payment out alone.

### Discussion, review and moderation

Members comment on proposals in threaded discussions. Anyone can report content. Administrators review a moderation queue and hide, remove or restore postings, proposals and comments with a recorded reason. Moderation actions are anchored on-chain and appear in the audit trail.

### Dashboards and audit trail

Each member has an **Action Needed** tab listing what waits on them, plus role views for owned problems, own proposals, evaluations and funding. Every verified event has an audit receipt that recomputes the record hash and compares it with the chain. The consolidated audit trail can be filtered by event type, date, actor role and entity.

### Account wallet

The account menu shows the member's email, wallet address and test-token balances. It can send test tokens, claim tokens from the test-token faucet, and open **Add funds**. Add funds is a labelled testnet simulation of a fiat on-ramp and an off-ramp. It does not move money. The same button is on the escrow funding panel. The escrow panel does not mint test tokens; that remains the account-menu faucet and the standalone faucet site.

### Local currency and drafting

A header control and the private profile can show funding amounts as an indicative local-currency estimate. `getFxRates` reads Google Finance. The estimate is cached, labelled as indicative, and never submitted as a payment. Token amounts stay the settlement unit.

Problem, open-funding and proposal forms can **Draft with AI**. `draftWithAI` fills only empty text fields, and `findSimilarProposals` points at existing proposals before publish. Amounts, currency, expiry and dates stay with the author. A published record can be marked AI-assisted. See `docs/fx-rates.md` and `docs/ai-assistance.md`.

## What lives where

| Kept off-chain in Firebase | Anchored on Arbitrum Sepolia |
| --- | --- |
| Profiles, emails and roles | Hashes of postings and proposals, and every revision |
| Full text of postings, proposals and comments | Withdrawal reasons as hashes |
| PDF attachments | Escrow deposits, approvals, votes, payouts and refunds |
| Evaluator recommendations and owner reviews | Moderation decisions |
| Notifications, dashboards and projections | Funding approach decisions |

Evaluator comments and scores are never written on-chain.

## What is simulated

* All tokens are six-decimal mock XSGD, USDT and USDC on Arbitrum Sepolia, minted by a test faucet.
* Gas is sponsored by Privy on testnet, so members never hold ETH.
* **Add funds** is a local on-ramp and off-ramp simulation. It does not call a card provider or Due, and it does not change token balances.
* An older off-chain mock matching flow (QCDAO-81 to 86, see `firebase/MOCK_MATCHING.md`) is still in the code. Every proposal published under the current registry uses on-chain escrow instead, and Cloud Functions refuse mock actions on escrow proposals.
