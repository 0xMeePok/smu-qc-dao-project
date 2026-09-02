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
  "entityType": "opportunity | proposal | evaluation",
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

- Opportunities: `commitOpportunity(entityId, kind, contentHash, expiresAt)`
- Proposals: `commitProposal(entityId, opportunityId, proposalHash, solutionHash)`
- Evaluations: `recordEvaluation(proposalId, evaluationHash, revisionIndex, revisionDigest)`

Evaluator eligibility is enforced by the platform. The contract intentionally
does not store an evaluator list or restrict `recordEvaluation` by wallet; it
only records the calling wallet as the event actor.

## Receipt lifecycle and retries

The application creates the Firestore record first, then updates its embedded
audit receipt through `queued`, `submitted`, `pending`, `confirmed`, or
`failed`. A known transaction hash is only polled for its receipt and is never
rebroadcast. Transient receipt reads are capped at three attempts. Posting use
is not blocked if anchoring fails, and users can retry from the visible receipt.

The current Arbitrum Sepolia deployment is
`0xd119C050E51e7012B4Dea180c3e4F2727F354447` (transaction
`0xdb85cd262f365958ef1ae767cbaecd1408fbc4963088839f191fb7bc0742c916`).
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
