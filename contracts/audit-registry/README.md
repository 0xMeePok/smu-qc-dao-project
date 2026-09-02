# Audit registry

On-chain registry for opportunity and proposal hashes on Arbitrum Sepolia. Full records remain in Firestore; this contract stores hashes, timestamps, and an append-only revision trail.

## Current deployment

| Field | Value |
|---|---|
| Network | Arbitrum Sepolia (`421614`) |
| Address | [`0xF5d66411eBFDc8f58e0224AB60eF4CdFD6D01B3d`](https://sepolia.arbiscan.io/address/0xF5d66411eBFDc8f58e0224AB60eF4CdFD6D01B3d#code) |
| Deployment transaction | [`0x2bf29bdf436837a4086046c4612b27afa0ca4f898af2417fb98e1b98983b17a1`](https://sepolia.arbiscan.io/tx/0x2bf29bdf436837a4086046c4612b27afa0ca4f898af2417fb98e1b98983b17a1) |
| Block | `304644898` |
| Deployed | `2026-09-02T13:00:23Z` |
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

Compile and test:

```bash
npm test
```

Deploy and automatically verify on Arbiscan through Etherscan API v2:

```bash
npm run deploy:arbitrum-sepolia
```

The script validates Arbitrum Sepolia chain ID `421614`, archives any prior deployment record, immediately records the new broadcast transaction, and polls for two confirmations. Transient timeouts are retried against the primary RPC before a read-only fallback RPC is used. It never blindly resends a deployment transaction because a timed-out broadcast may already be on-chain. The exact production build is then verified. The newest deployment is written to `deployments/arbitrumSepolia.json`, while earlier records are retained under `deployments/history/`.
