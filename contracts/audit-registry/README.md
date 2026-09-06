# Audit registry

On-chain registry for opportunity and proposal hashes on Arbitrum Sepolia. Full records remain in Firestore; this contract stores hashes, timestamps, and an append-only revision trail.

## Current deployment

| Field | Value |
|---|---|
| Network | Arbitrum Sepolia (`421614`) |
| Address | [`0x8E0BB204c2b805d4c8654791a56f3Bd96e8FD1CD`](https://sepolia.arbiscan.io/address/0x8E0BB204c2b805d4c8654791a56f3Bd96e8FD1CD#code) |
| Deployment transaction | [`0x7df4e661d7dbd82b3bc0e00727d10d581a604614d23d1a7e16f4e571d242403b`](https://sepolia.arbiscan.io/tx/0x7df4e661d7dbd82b3bc0e00727d10d581a604614d23d1a7e16f4e571d242403b) |
| Block | `304652016` |
| Deployed | `2026-09-02T13:29:43Z` |
| Source | Verified on Arbiscan |

The frontend contract manifest is `frontend/src/config/auditRegistry.contract.json`.

Writers call from their own wallet:

- Problem owners, funders, and researchers `commitOpportunity` / `updateOpportunity` / `withdrawOpportunity`
- Researchers `commitProposal` / `updateHashes` / `withdrawProposal` against a live opportunity

Evaluations and evaluator permissions stay in the platform database. They are not written to this contract.

Install dependencies:

```bash
npm install
```

Copy `.env.example` to `.env` and set the Arbitrum Sepolia RPC URL, deployer private key, and Etherscan API key. Never commit `.env` or use a wallet that controls mainnet funds.

Compile and test on a local Hardhat chain (use Node.js 22 or newer):

```bash
npm test
```

The suite covers opportunity and proposal lifecycles, access control, invalid
inputs, revision linkage, withdrawal and public reads. The workflow tests add
exact deadline boundaries, rejected-update rollback, and competing submissions
mined in the same block. These tests deploy fresh local contracts and do not send
transactions to Arbitrum Sepolia. CI runs the suite for changes to this contract
package, and its result is included in the required aggregate CI check.

Deploy and automatically verify on Arbiscan through Etherscan API v2:

```bash
npm run deploy:arbitrum-sepolia
```

The script validates Arbitrum Sepolia chain ID `421614`, archives any prior deployment record, immediately records the new broadcast transaction, and polls for two confirmations. Transient timeouts are retried against the primary RPC before a read-only fallback RPC is used. It never blindly resends a deployment transaction because a timed-out broadcast may already be on-chain. The exact production build is then verified. The newest deployment is written to `deployments/arbitrumSepolia.json`, while earlier records are retained under `deployments/history/`.
