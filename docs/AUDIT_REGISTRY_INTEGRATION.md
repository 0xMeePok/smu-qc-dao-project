# Audit registry integration

QCDAO-75 through QCDAO-79 use the existing `AuditRegistry` as an integrity
anchor. Firestore remains the authoritative application database; the chain
stores only deterministic hashes and the wallet that submitted each anchor.

## Canonical format

The frontend has one supported hash format: canonical JSON version 1 followed
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
  the contract records with the `Funder` actor role.
- Proposals: `commitProposal(entityId, opportunityId, proposalHash, solutionHash, expectedOpportunityRevisionIndex)`
- Proposal updates: `updateHashes(entityId, proposalHash, solutionHash, expectedOpportunityRevisionIndex)`

Every proposal version must carry the opportunity revision the researcher viewed.
Submission and update calls revert if that revision is no longer current when
the transaction executes.

Evaluations are platform records and are not anchored by this contract.

## Receipt lifecycle and retries

Creation is chain-first: the application prepares the final Firestore content,
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
