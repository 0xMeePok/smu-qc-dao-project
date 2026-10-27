# Test-token faucet

Members need mock XSGD, USDT or USDC to fund escrows. A small faucet service mints them. It runs on Vercel, separate from Firebase, so the faucet key never reaches the Firebase backend or the browser.

## How it fits together

1. In the account menu, a member chooses **Faucet** and a token.
2. The embedded wallet signs the faucet's mint message, which includes the token and an issued-at time.
3. The app calls the `claimWalletTokens` function. It derives the recipient from the verified Firebase account, never from the browser, and relays the signed request to `https://smu-qc-dao-project.vercel.app/api/faucet`.
4. The faucet API checks the signature with EIP-191 address recovery and calls the token's owner-only `faucetMint`. The faucet wallet pays the gas.

Each claim mints 10,000 tokens. Each token contract enforces a one-hour cooldown per recipient and a cap of one billion tokens.

| Token | Address | Decimals |
| --- | --- | --- |
| XSGD | `0xC2FE292771719Ae948506bab3c156A622de9a415` | 6 |
| USDT | `0x5f079A5934C864D6881EF30cf74Fe1363F58B856` | 6 |
| USDC | `0x4CBf2C15243678206dF8F248D01a0e117C8ce0cd` | 6 |

## Joining the existing project

Ask the owner of the Vercel project behind `smu-qc-dao-project.vercel.app` to add you to its team. The faucet wallet needs a little Arbitrum Sepolia ETH for gas. When a claim would take its balance below a 0.005 ETH reserve, the faucet API refuses with "The faucet is paused for replenishment", and members see "The test-token faucet is temporarily unavailable". Top the wallet up with Arbitrum Sepolia ETH when that happens.

## Deploying your own faucet

The site and API are in `contracts/stable-faucet/site`.

1. Test locally:

   ```bash
   cd contracts/stable-faucet
   npm ci && npm test
   cd site
   cp .env.example .env
   npm ci && npm test
   vercel dev -L
   ```

2. In Vercel, import the repository with `contracts/stable-faucet/site` as the project root.
3. Add the five variables from `site/.env.example` under **Project Settings**, **Environment Variables**, and mark `FAUCET_PRIVATE_KEY` as sensitive:

   | Variable | Value |
   | --- | --- |
   | `ARBITRUM_SEPOLIA_RPC_URL` | An Arbitrum Sepolia RPC |
   | `FAUCET_PRIVATE_KEY` | The key that owns the three token contracts. Never prefix it with `VITE_` |
   | `XSGD_TOKEN_ADDRESS`, `USDT_TOKEN_ADDRESS`, `USDC_TOKEN_ADDRESS` | The token addresses above |

4. Point the backend at your deployment: change `FAUCET_URL` in `firebase/functions/walletFaucetFunctions.js` and redeploy the functions.

Keep the token addresses identical in the faucet, `frontend/src/config/auditRegistry.contract.json`, the functions manifest and the escrow factory's allow-list. Avoid replacing the tokens: existing escrows stay bound to the old addresses, and new ones would have to be allowed in the factory (`setTokenAllowed`, owner only) and added to every config.

## Older standalone faucet site

The same Vercel site also has a page for browser-wallet users. It connects through `window.ethereum`, so email members cannot use it. They use the account menu instead.
