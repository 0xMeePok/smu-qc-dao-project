# TAP faucet release

This folder is a self-contained release bundle for the Arbitrum Sepolia mock-token faucet. It contains only the three-token contract project, the public deployment record, and the Vite/Vercel site.

## Current token deployments

- XSGD: `0xC2FE292771719Ae948506bab3c156A622de9a415`
- USDT: `0x5f079A5934C864D6881EF30cf74Fe1363F58B856`
- USDC: `0x4CBf2C15243678206dF8F248D01a0e117C8ce0cd`

Each mock token uses 6 decimals, distributes 10,000 tokens per claim, and enforces a one-hour cooldown per wallet. The contracts are owned by the dedicated faucet signer.

## Test or redeploy contracts

```bash
cp .env.example .env
npm ci
npm test
```

Only set `DEPLOYER_PRIVATE_KEY` to a dedicated Arbitrum Sepolia account. To intentionally deploy replacements after testing, run:

```bash
ALLOW_REDEPLOY=true npm run deploy:faucet
```

The public deployment details are written to `deployments/arbitrumSepolia-faucet.json`.

## Run or deploy the site

```bash
cd site
cp .env.example .env
npm ci
npm test
```

Use `vercel dev -L` for local frontend and Function testing. For Vercel, import the `site` directory as the project root and add the five variables from `site/.env.example` in Project Settings. Mark `FAUCET_PRIVATE_KEY` as sensitive. Never prefix the private key with `VITE_`.

No real private key is included in this release folder.
