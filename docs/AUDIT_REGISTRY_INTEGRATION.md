# Audit registry integration

QCDAO-75 through QCDAO-79 use the existing `AuditRegistry` as an integrity
anchor. Firestore remains the authoritative application database; the chain
stores only deterministic hashes and the wallet that submitted each anchor.

## Canonical format

The application has one supported hash format: canonical JSON version 1 followed
by `keccak256` over its UTF-8 bytes. The version is part of the off-chain
canonical envelope and Firestore receipt, not a Solidity argument.

- Object keys are sorted recursively.
- Array order is preserved.
- Strings use Unicode NFC normalization.
- Numbers must be finite safe integers; `-0` becomes `0`.
- Dates use `{ "$timestamp": "<ISO-8601>" }`.
- Byte arrays use `{ "$bytes": "0x..." }`.
- `undefined`, cyclic values, and custom object instances are rejected.

The envelope is:

```json
{
  "entityType": "opportunity | proposal",
  "hashScheme": 1,
  "payload": {}
}
```

No client timestamp is sent to the contract. The transaction and emitted
anchor event provide the chain timestamp. Opportunity expiry remains a business
field and is therefore still passed as `expiresAt`.

Stable entity IDs use the same normalization and `keccak256`, domain-separated
with `qcdao.audit.entity`, the entity type, format version, and Firestore record
ID. Golden vectors in `frontend/test/unit/auditRegistry.test.js` prevent silent
serialization changes.

## Contract calls

- Opportunities: `commitOpportunity(entityId, kind, contentHash, expiresAt)`. Funded
  business problems use kind `0`; QCDAO-51 open-funding calls use kind `1`, which
  the contract records with the `Funder` actor role. An edit of a live posting is
  `updateOpportunity(entityId, contentHash, expiresAt)` — never a second
  `commitOpportunity`, which reverts because the id is taken. Withdrawal is
  `withdrawOpportunity(entityId, evidenceHash)` after the owner signs a hash of
  the exact reason; Firestore then stores `cancelled` and `withdrawalReason`.
- Proposals: `commitProposal(entityId, opportunityId, proposalHash, solutionHash, expectedOpportunityRevisionIndex)`
- Proposal updates: `updateHashes(entityId, proposalHash, solutionHash, expectedOpportunityRevisionIndex)`

Every proposal version must carry the opportunity revision the researcher viewed.
Submission and update calls revert if that revision is no longer current when
the transaction executes.

Evaluations are platform records and are not anchored by this contract.

## Receipt lifecycle and retries

All application contract writes (opportunity publication, proposal submission,
and proposal hash updates) request fresh Arbitrum Sepolia EIP-1559 fees before
opening the wallet. The shared adapter doubles the estimated `maxFeePerGas`
while preserving `maxPriorityFeePerGas`, allowing base-fee movement during wallet
confirmation. This is a fee cap, not a fixed charge or an increased gas limit.
Fee-estimation failure stops before wallet submission. A fee-cap rejection is
shown with explicit retry guidance; the next user-initiated attempt estimates
again. Transactions are never automatically rebroadcast to adjust fees.

Opportunity creation is chain-first: the application prepares the final Firestore content,
asks the signed-in wallet to commit its deterministic hash, verifies the confirmed
contract state, and only then writes the record. A failed or declined anchor leaves
the form intact and does not publish unverifiable content. Recovery state uses
`queued`, `submitted`, `pending`, `confirmed`, or `failed`; a known transaction
hash is polled for its receipt and never rebroadcast. Every audit result shown in
the frontend is read from the configured contract and compared with a freshly
computed opportunity hash. Transient receipt reads are capped at three attempts.

The current Arbitrum Sepolia deployment is
`0x8E0BB204c2b805d4c8654791a56f3Bd96e8FD1CD` (transaction
`0x7df4e661d7dbd82b3bc0e00727d10d581a604614d23d1a7e16f4e571d242403b`).
It is the checked-in frontend default. `VITE_AUDIT_REGISTRY_ADDRESS` may override
it for a later deployment; an invalid override disables on-chain verification
without blocking the Firestore workflow.

## Swapping the contract

The frontend reads the chain ID, default address, and complete ABI from
`frontend/src/config/auditRegistry.contract.json`. Do not maintain a second ABI
by hand.

After compiling or deploying a replacement from this repository, refresh the
frontend manifest with:

```bash
cd frontend
npm run sync:audit-registry
```

The command reads the default Hardhat artifact and Arbitrum Sepolia deployment
record. A different artifact or deployment can be selected explicitly:

```bash
npm run sync:audit-registry -- \
  --artifact /absolute/path/to/AuditRegistry.json \
  --deployment /absolute/path/to/deployment.json
```

To keep the checked-in ABI and change only the address for one environment, set
`VITE_AUDIT_REGISTRY_ADDRESS`. The environment override is validated as a
non-zero EVM address before any contract request is made.

## Opportunity withdrawal (QCDAO-57)

Problem statements and open funding calls withdraw the same way as proposals:
chain first. `prepareOpportunityWithdrawal` hashes `{ recordId, ownerId, reason }`
and the owner wallet signs `withdrawOpportunity`. Firestore then writes
`status: cancelled` and the frozen `withdrawalReason`. A declined signature
changes nothing; a Firestore failure after a mined transaction retries only the
write, with the anchored reason locked.

| Action | Contract call | Written to Firestore |
| --- | --- | --- |
| Submit | `commitOpportunity` | after the transaction is mined and verified |
| Correct | `updateOpportunity` | after the transaction is mined and verified |
| Withdraw | `withdrawOpportunity` | after the transaction is mined |
| Save draft | none | immediately — a draft is private |

A correction keeps the same entity id. `commitOpportunity` reverts once that id
is taken, which is what produced multi-million-dollar gas estimates in the
wallet: Arbitrum returns a block-sized limit for a reverting call. The client
reads `opportunityRevisionCount` and calls `updateOpportunity` when the
opportunity already exists. The wallet is not opened until that call simulates
successfully.

Full content may be edited while status is `submitted` or `open` and no proposal
has been received. After the first proposal, only supporting attachments may
change — the funded ask is what researchers already responded to.

Every post-publication edit and withdrawal is written to
`problems/{id}/revisions` by `recordOpportunityEdit`, with the actor, changed
fields, content hashes, timestamp and (on withdrawal) the stated reason.

## Proposal implementation (QCDAO-59/60 + QCDAO-75–79)

Proposals are **chain first**, like opportunities. QCDAO-57 changed this: they
were Firestore first, which meant a proposal could sit in evaluation before it
had been anchored or paid for, and an edit landed on the record before the
amendment was signed. Every proposal write now signs first.

| Action | Contract call | Written to Firestore |
| --- | --- | --- |
| Submit | `commitProposal` | after the transaction is mined and verified |
| Correct | `updateHashes` | after the transaction is mined and verified |
| Withdraw | `withdrawProposal` | after the transaction is mined |
| Save draft | none | immediately — a draft is private and unevaluated |

The record that is hashed is the record that is written; it is built once and
passed through, never rebuilt in between. A declined or failed transaction
changes nothing, which is the point of the ordering.

`confirmed` remains a server attestation that no browser may write, so a
transaction this client watched being mined is stored as `pending` carrying its
real hash, and `confirmProposalAudit` promotes it. The queued audit job means the
server still promotes it if the tab closes first.

The one asymmetry with opportunities: a proposal's Firestore write can be refused
after a successful anchor, because the rules re-check the parent opportunity and
the one-proposal-per-author slot at write time. The author is told the
transaction succeeded and that resubmitting reuses the same anchor, rather than
being shown a bare write error.

### Corrections (QCDAO-57)

A proposal corrected before evaluation keeps its entity id, so its second
anchoring is an amendment: `commitProposal` reverts once the id is taken, and
`updateHashes` appends a revision beside the original instead of replacing it.
Both calls carry the same hashes for the same stored record, so
`verifyProposalAudit` and the trusted server confirmation accept either.

Which call to make is read from the registry (`revisionCount`), never inferred
from Firestore: the correction drops the stored receipt, because the hash it
attests to no longer describes the record, and a dropped or never-saved receipt
would otherwise send the wrong call.

The correction path is `frontend/src/lib/proposalAudit.js`. Off-chain, the same
edit is written to `proposals/{id}/revisions` by a Cloud Functions trigger with
the changed fields, the actor and the timestamp, so the on- and off-chain records
of one edit can be reconciled through the content hashes the entry carries.

### Reproducing proposal hashes

`firebase/functions/auditCanonical.js` is the pure canonical implementation shared
by browser and backend. `proposalAuditPayload.js` freezes the proposal v1 field
list independently of future form changes. Both funded-problem and open-funding
proposals use the following fields (sorted by the canonical serializer):

`researcherId`, `problemId`, `postingOwnerId`, `opportunityType`, `category`,
`amount`, `currency`, `title`, `summary`, `methodology`, `suitability`,
`expectedOutcomes`, `successCriteria`, `timeline`, `milestones`, `team`,
`proposedProblem`, `relevance`, `thesisFit`.

Missing/null fields become `""`. Amount is the JavaScript decimal string of the
stored numeric value, so fractional token amounts are supported. The proposal
hash covers `{document: "proposal", value: <fields above>}` inside the canonical
proposal envelope. A second solution hash covers
`{document: "solution", value: {methodology, attachments}}`; attachments retain
all stored metadata, ordered by their generated IDs using the existing v1
`localeCompare` ordering. Storage rules make submitted PDF bytes immutable.
New proposal attachments also store a lowercase SHA-256 digest of the complete
PDF. Submission rules require that digest, the solution hash commits to it, and
downloads recompute it before releasing the file to the browser. Legacy records
without attachments retain their historical v1 hash; an older proposal attachment
without a digest must be backfilled before its first audit confirmation.
Status, receipt delivery metadata and Firestore creation/update timestamps are
excluded; withdrawal and retry do not change submission hashes. The on-chain
submission timestamp comes from the mined event. Proposal revision linkage remains
revision 0 because the integrated posting workflow publishes only that revision.

The registry anchor digest is `keccak256(abi.encode(proposalHash, solutionHash))`.
For an independently fetched Firestore record, including its document ID:

```js
import { prepareStoredProposal } from "./firebase/functions/proposalAuditPayload.js";
const prepared = prepareStoredProposal(record);
console.log(prepared.canonicalPayload, prepared.canonicalSolution);
console.log(prepared.proposalHash, prepared.solutionHash, prepared.anchorHash);
```

Golden vectors for both proposal variants are in
`firebase/functions/test/proposal-audit.test.mjs`. Unsupported scheme versions
are reported as unavailable instead of silently being treated as v1. Existing
v1 hashes are preserved.

### Confirmation and recovery

The browser records queued → submitted → pending delivery states. After checking
the chain it calls `confirmProposalAudit`; only the author can call this endpoint.
The server reads current Firestore content and verifies the mined transaction's
success, chain, registry address, researcher and exact calldata, then checks the
receipt and transaction belong to the same canonical block and waits for two
block confirmations before checking the current registry proposal. Only the
server persists `confirmed` and its block number. A non-final observation remains
pending and is retried. Rules reject client confirmation, preserve the first
non-empty transaction hash, and prevent downgrading a server-confirmed
receipt. Client state remains a display hint; **Check again** fetches the current
record from the server and recomputes both hashes on every invocation.

`queueProposalAudit` creates private `proposalAuditJobs/{proposalId}` records for
saved submissions. `retryPendingProposalAudits` checks up to 25 jobs every minute.
Transient failures, including missing/dropped transaction receipts and network
outages, retry after 1, 2 and 4 minutes, with at most three attempts per cycle.
A 90-second transactional lease prevents concurrent recovery workers from racing.
The original transaction reference is retained; recovery never broadcasts another
transaction. Reverts and mismatches require attention rather than automatic retry.

In **Admin → Governance Audit Trail → Verification queue**, administrators can inspect the
paginated proposal audit trail, open receipts, re-verify current content and retry
confirmation after the automatic budget is exhausted. Jobs with no transaction
show **Waiting for researcher wallet**. An administrator can reset wallet attempt
limits, after which the author starts verification from their proposal receipt.
Browser receipt polling picks up server updates without reloading the page.

There is **no platform signer** in this deployment: `commitProposal` binds the
researcher to `msg.sender`. The connected wallet manages its own nonce and gas.
Neither scheduled recovery nor administrators submit transactions or impersonate
researchers, so concurrent recovery jobs do not allocate nonces or spend gas.
Creating a platform signer, relaying researcher signatures, evaluation anchors and
receipts for later workflow events require separate contract/workflow changes.
Those are outside this integration against QCDAO-59/60.

During a testnet outage the submission remains saved, the receipt explains the
verification issue, and the admin queue retains exhausted jobs. A wallet
transaction that was never submitted cannot be recovered without its author.
The contract's expiry/revision checks still apply when a delayed transaction is
mined; an off-chain submission does not override those constraints.

### Deployment and demonstration

Deploy the frontend, new Cloud Functions, Firestore rules and indexes together.
The backend uses `ARBITRUM_SEPOLIA_RPC_URL` and optional `AUDIT_REGISTRY_ADDRESS`;
its address must match `VITE_AUDIT_REGISTRY_ADDRESS`. `npm run sync:audit-registry`
now refreshes both frontend and backend manifests. Recovery continues in the
scheduler after the browser closes. Existing proposals enter the queue the next
time their receipt is updated; new submissions are queued by their write trigger.

After the merged application reaches the live site, use dedicated test proposals
and funded test wallets to check:

1. Submit against a funded problem and an open funding opportunity. Confirm the
   saved proposal stays usable during anchoring, then compare its confirmed hash,
   actor and transaction reference with Arbiscan.
2. Decline the wallet request, then retry. The proposal remains saved and only the
   successful wallet submission creates an anchor.
3. Close the browser after the transaction hash has been saved. Reopen after the
   recovery worker runs and verify the same transaction becomes confirmed.
4. Interrupt RPC access, then restore it and resume verification. Check that
   pending/unavailable messages stay distinct from a content mismatch.
5. Inspect the admin queue, retry an exhausted confirmation job and check access
   is refused for a non-admin account. Capture proposal IDs and transaction
   references as acceptance evidence.

To demonstrate tamper detection locally:

1. Use Firebase emulators and an isolated test proposal. Complete submission and
   obtain a matching receipt using the configured test registry.
2. Keep its receipt open. In the emulator Firestore UI, change the saved `title`
   (or attachment metadata) without changing its transaction reference.
3. Select **Check again**. The fresh server read is hashed against the original
   registry record and displays **Mismatch detected** prominently.
4. Restore the original content and check again to recover **Verified match**.
   Disconnect the RPC endpoint to demonstrate **Unable to verify**, which is
   distinct from a mismatch and leaves the proposal available.
