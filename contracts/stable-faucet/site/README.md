# TAP faucet

Vanilla TypeScript and Vite faucet for mock XSGD, USDT, and USDC on Arbitrum Sepolia. A user must connect their wallet and sign a short-lived request. The Vercel Function verifies that signature before submitting the token transaction with the server-only faucet key.

## Run locally

```bash
cp .env.example .env.local
npm ci
npm run dev
```

`npm run dev` starts the Vite frontend. Use `vercel dev` when you need the frontend and `/api/faucet` Function together. Replace the placeholder private key in `.env.local` with a dedicated, testnet-only key. Never commit `.env.local` or use an account that holds mainnet assets.

## Deploy to Vercel

Import this directory as a Vite project. Use `npm run build` and the default `dist` output directory. The `api/faucet.ts` file deploys separately as a Vercel Function, so private values never enter the Vite bundle.

Add these server-side environment variables in Vercel Project Settings:

- `ARBITRUM_SEPOLIA_RPC_URL`
- `FAUCET_PRIVATE_KEY` (mark it sensitive)
- `XSGD_TOKEN_ADDRESS`
- `USDT_TOKEN_ADDRESS`
- `USDC_TOKEN_ADDRESS`

Apply them to Production and any Preview environments that should mint. Never prefix secrets with `VITE_`; Vite exposes those values to browser code.

After a successful distribution, the server blocks that wallet from receiving the same token again for one hour. The wallet can still receive each of the other faucet tokens. This in-memory cooldown is isolated to each warm Vercel Function instance and resets when an instance restarts, so it is a best-effort control rather than a globally durable limit. The token contracts must also allow hourly claims; a longer on-chain cooldown cannot be shortened by this server.

Validate before deploying:

```bash
npm test
```
