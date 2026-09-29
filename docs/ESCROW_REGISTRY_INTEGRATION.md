# Escrow-linked registry verification

The new contracts are deployed on Arbitrum Sepolia (chain 421614). The **local**
frontend and Firebase manifests now select this deployment. Hosting, deployed
Cloud Functions, live rules and live records have not been changed; publishing is
deferred until the user finishes testing after Monday.

| Setting | Deployed value |
| --- | --- |
| EscrowAuditRegistry | `0xb901B23382322090A1Ea7bC6b8a9d2D422e855FD` |
| FundingEscrowFactory | `0xe5d212491E544694d21c51EF9777F71B32fc5D41` |
| Owner, fee recipient and platform signer | `0x1c608C148F64Fb9657bA4e5fB8992345277371C0` |
| Initial fee | 10 BPS = 0.1%, charged only on payouts |

The confirmed deployment record is
[`contracts/audit-registry/manifests/arbitrumSepolia.json`](../contracts/audit-registry/manifests/arbitrumSepolia.json).
The previous scheme-2 deployment and ABI are preserved under
[`contracts/audit-registry/legacy/pre-escrow-arbitrumSepolia.contract.json`](../contracts/audit-registry/legacy/pre-escrow-arbitrumSepolia.contract.json)
and its adjacent `.deployment.json` file. No historical records were migrated or retired.

## Proposal creation and verification

With an `EscrowAuditRegistry` manifest selected, every application proposal uses
**50% upfront and 50% on completion** (`trancheBps: [5000, 5000]`). The split is
read-only in the form and enforced by shared term validation, server publication
attestation and Firestore submission/correction rules. There is no exception for
previous custom splits; the existing proposal dataset is to be cleared separately.
These code changes do not delete records or redeploy contracts.

The full funding target must be deposited into escrow before the upfront half
can be released, after both the problem owner and proposal owner approve selection.
The proposal owner submits delivery evidence and confirms completion for the final
half. The problem owner must accept that evidence as delivered. The proposal chooses
one of two immutable completion approval variants before funding:

- **Both owners:** evidence plus approval from the proposal owner and problem owner.
- **Both owners and funders:** the same requirements, plus yes votes representing
  strictly more than 50% of all contributed funds. Each wallet's cumulative funding
  is its voting weight. Exactly 50% fails, and abstentions do not lower the threshold.

The default variant is both owners. Replacing evidence resets owner approvals and
funder votes. Each payment is subject to the configured platform fee, with any token
rounding remainder in the final payment. Review windows accept one whole-day value
for both payments or two values (upfront, final), each 1–365 days; the default is seven
days. The first window is capped by the contract at seven days and the posting
deadline. The final window starts with the upfront payout, so it must allow time
for delivery and acceptance. A missed approval deadline opens refunds of the unpaid
balance.

Drafts retain unfinished inputs in `fundingPlan`. Submission resolves the configured
token address and decimals, produces exact integer base units, and stores the six
contract fields in `fundingTerms`. The target is a decimal integer string so it is
safe to persist in Firestore. The existing proposal amount field remains a number
with its existing 1,000,000,000 limit; the form rejects conversions that would lose
precision. This UI limit does not reduce the contract's uint256 accounting range.
Small amounts are restored to plain decimal input when a draft or submitted
proposal is reopened without scientific notation. Two token base units are the
minimum total needed to fund both halves; each payment must be nonzero.

Each milestone description hash binds the proposal's complete milestones text and
its tranche index under `qcdao.escrow.milestone.v1`. The amount, token, milestone
text, payment percentages, review windows and voting setting are fixed when the
proposal is created. An unfunded proposal can still amend other content; the
contract freezes all proposal edits once funding begins.

The browser submits `commitProposalWithEscrow`, preserving the expected parent
revision before the funding tuple. Firebase independently checks the mined call,
researcher, registry, chain, canonical block and confirmations. It then verifies:

- The registry/factory references in both directions and both proposal-to-escrow mappings.
- The escrow's posting/proposal IDs, owners, token, token decimals, target and voting setting.
- The escrow's registry/factory references, expiry, tranche count, ratios, windows,
  description hashes and exact cumulative-floor gross amounts.

An amendment through `updateHashes` must retain the same escrow terms. Confirmation
also rechecks the stored funding-terms hash before writing its result, so a change
during the RPC reads cannot receive a stale confirmation. The frontend reports a
known escrow mismatch as a mismatch, and network failures remain unverified.
Verification describes record/term integrity, not milestone completion or approval
to spend funds. Historical content can remain verifiable after payments or refunds.

The deployed legacy registry keeps its previous commit path and canonical content
hashes. Never pair its address with the new contract ABI.

## Verify a confirmed deployment

In `contracts/funding-escrow`, using Node 22.13 or newer:

```sh
npm run compile -- --build-profile production
npm run test:verifier
npm run verify:arbitrum-sepolia -- --deployment=deployments/arbitrumSepolia-TIMESTAMP.json
```

The deployment script now records the contract name, entity ID scheme, confirmed
registry/factory/wiring states, and token symbols/decimals. The read-only verifier
checks the Arbitrum Sepolia chain, compiled runtime code, consistent repeated
immutable slots, mutual wiring and platform signer. It reports current owners and
fee BPS, allowing legitimate fee/ownership changes after deployment. It does not
submit a transaction. Compile without coverage instrumentation before comparing
runtime bytecode.

The existing command in `contracts/audit-registry` also accepts `--deployment` and
dispatches linked records to the new verifier. Its default now checks the active
escrow deployment recorded in `manifests/arbitrumSepolia.json`.

## Prepare the application switch

The local switch has been applied. From the repository root, regenerate a preview
from the confirmed active deployment if needed:

```sh
node frontend/scripts/sync-audit-registry.mjs \
  --deployment=contracts/audit-registry/manifests/arbitrumSepolia.json \
  --output=/tmp/escrow-registry-preview.json
```

The sync tool automatically selects the linked registry artifact and includes the
factory/escrow ABIs and token metadata. It rejects incomplete wiring, a mismatched
chain/address, ambiguous token symbols, and unsupported token precision. Removing
`--output` writes the same manifest to both frontend and Firebase. Remove conflicting
`VITE_AUDIT_REGISTRY_ADDRESS` / `AUDIT_REGISTRY_ADDRESS` overrides when switching;
the linked deployment requires its configured address to agree everywhere.

For testing before publication, use the Firebase emulators with
`VITE_FIREBASE_USE_EMULATORS=true` and the updated local Functions. The wallet and
verification RPC still use real Arbitrum Sepolia. A local frontend connected to the
unchanged live Functions cannot publish escrow-linked proposals: that server still
uses its prior registry configuration. Follow the existing Firebase setup in the
root README; keep the deployer key out of all `VITE_*` variables and browser code.

Deploy the matching Functions, Firestore rules and rebuilt frontend together as
part of the planned registry cutover. Existing records remain in their original
registry namespace; switching a manifest is not a migration. Preserve their audit
history and agree on their handling before enabling a new namespace. The earlier
[registry cutover notes](registry-cutover.md) document the existing retirement
mechanism; this change does not run it or authorize retiring additional records.

The configured token catalog must retain the address and decimals of tokens used
by existing proposals. Add newly listed token metadata deliberately; do not remap
an existing currency symbol to a different address. The current form's currency
choices remain the existing USDC/USDT/XSGD choices. On-chain token delisting still
blocks new funding while preserving exits from existing escrows.

Deposit/refund dashboards and platform payment relaying remain separate application
work. The existing mock funding/matching controls have not been replaced with wallet
deposit or payout controls by this verifier integration.

## Validation

Validated locally on 2026-09-27:

| Suite | Result |
| --- | --- |
| Frontend unit tests, including the production Vite build check | 172 passed |
| Frontend component tests | 392 passed |
| Additional frontend session/integration tests | 102 passed |
| Firebase escrow/proposal verification, publication, revision and validation tests | 75 passed |
| Full Firestore and Storage emulator rule suite | 344 passed |
| Local deployment verifier and compiled ABI compatibility tests | 6 passed |

Regression tests cover legacy hash vectors, atomic escrow calls, nonzero parent
revisions, malformed and altered funding terms, canonical link mismatches, decimal
conversion, read-only deployment identity, confirmation races, form state and
Firestore publication/immutability. Contract tests additionally compare the staged
application ABI bundle against compiled interfaces. The previously canceled deep
security scan remains incomplete and was not restarted.

The deployed contracts passed read-only runtime-bytecode, wiring, owner, signer
and fee checks; see the [verification evidence](../contracts/funding-escrow/manifests/arbitrumSepolia-verification.json).
A 23-transaction smoke test then created a labelled proposal and its escrow,
confirmed it through the real frontend and Firebase verifier code, and exercised
the following flow with one mock USDC:

- The first funder deposited 0.3 and topped up by 0.3; a second deposited 0.4.
- Both owners approved a 40% first payout.
- Both owners approved the next 30%; the 60% funder voted yes before its release.
- Payouts totalled 0.7 USDC, with exactly 0.0007 USDC in fees.
- An admin voided the unpaid final 30%. Funders separately claimed 0.18 and 0.12
  USDC, with no additional fee and no remaining escrow balance.
- All mock tokens were returned to the supplied wallet. Unused test-wallet gas was
  returned apart from a small transaction-fee reserve recorded in the report.

The [smoke-test journal](../contracts/funding-escrow/manifests/arbitrumSepolia-smoke.json)
contains the escrow address, hashes and confirmed block numbers. These are labelled
on-chain test records only; no Firestore records were created.

Explorer source publication is separate from successful bytecode verification.
The registry source was submitted by the deployment script and was still pending
when polling stopped. Automatic approval review blocked factory source publication
pending explicit permission to publish repository code to public Arbiscan. No
factory source submission was made. After approval, the source-only retry script
can use the confirmed record without deploying again:

```sh
ESCROW_DEPLOYMENT_RECORD=../audit-registry/manifests/arbitrumSepolia.json \
ESCROW_VERIFY_CONTRACT=factory npm run verify:source
```

Use the same command with `ESCROW_VERIFY_CONTRACT=registry` if its queued request
does not complete. The script bounds the explorer wait at two minutes and records
its result locally.
