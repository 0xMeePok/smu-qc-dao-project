# QFT token deployment

Install dependencies:

```bash
npm install
```

Copy `.env.example` to `.env` and set the Arbitrum Sepolia RPC URL, deployer private key, Etherscan API key, initial supply, and optional initial holder. Never commit `.env` or use a wallet that controls mainnet funds.

Deploy and automatically verify on Arbiscan through Etherscan API v2:

```bash
npm run deploy:arbitrum-sepolia
```

The script validates Arbitrum Sepolia chain ID `421614`, archives any prior deployment record, immediately records the new broadcast transaction, and polls for two confirmations. Transient timeouts are retried against the primary RPC before a read-only fallback RPC is used. It never blindly resends a deployment transaction because a timed-out broadcast may already be on-chain. The exact production build is then verified with its constructor arguments. The newest deployment is written to `deployments/arbitrumSepolia.json`, while earlier records are retained under `deployments/history/`.
