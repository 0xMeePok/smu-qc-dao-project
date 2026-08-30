# Audit registry

On-chain registry for Sprint 2 workflow hashes on Arbitrum Sepolia. Opportunity postings, proposal/solution pairs, and evaluation completions stay off-chain as full records; this contract stores only hashes, timestamps, and an append-only revision trail.

Writers call from their own wallet:

- Problem owners, funders, and researchers `commitOpportunity` / `updateOpportunity` / `withdrawOpportunity`
- Researchers `commitProposal` / `updateHashes` / `withdrawProposal` against a live opportunity
- Named evaluators (set when the posting is created; can be none, one, or several) `recordEvaluation` with a hash of their review write-up. Public comments stay off-chain for now.

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
