# Contract addresses

All on Arbitrum Sepolia, chain id `421614`. Explorer: [sepolia.arbiscan.io](https://sepolia.arbiscan.io). The source of truth is `contracts/audit-registry/manifests/arbitrumSepolia.json` and `independentFunding.contract.json`, synced into `frontend/src/config/` and `firebase/functions/`.

## Active deployment (17 October 2026)

| Contract | Address |
| --- | --- |
| `EscrowAuditRegistry` | [`0x8c12687843B3b40Ad2403946b6E29a93E2Fec6f5`](https://sepolia.arbiscan.io/address/0x8c12687843B3b40Ad2403946b6E29a93E2Fec6f5) |
| `FundingEscrowFactory` | [`0x1B44201bF44Bc3d144994B5246F03bD4b536eaC0`](https://sepolia.arbiscan.io/address/0x1B44201bF44Bc3d144994B5246F03bD4b536eaC0) |
| `FundingEscrowDeployer` | [`0x2b2410eBf06026c25ef7E7b3d0FAD7cE5a35c392`](https://sepolia.arbiscan.io/address/0x2b2410eBf06026c25ef7E7b3d0FAD7cE5a35c392) |
| `OpenFundingPoolDeployer` | [`0xdE607e8cDbEe4C7C00E821Ff03E1B3eFAe3e8Ca6`](https://sepolia.arbiscan.io/address/0xdE607e8cDbEe4C7C00E821Ff03E1B3eFAe3e8Ca6) |
| `IndependentFundingFactory` | [`0x87eaF14f3f5AEe7E6021b863Ef0803570c03003f`](https://sepolia.arbiscan.io/address/0x87eaF14f3f5AEe7E6021b863Ef0803570c03003f) |

| Setting | Value |
| --- | --- |
| Owner, fee recipient and platform signer | `0x1c608C148F64Fb9657bA4e5fB8992345277371C0` |
| Platform fee | 10 basis points (0.1%) of each payout |
| Capabilities | Pooled funding, open funding grants, grant proposal decline |
| Verification | Runtime bytecode and wiring verified read-only on 17 October 2026. Explorer source publication not requested |

Per-proposal escrows, grant pools and independent listing escrows are created by these factories, so their addresses are read from the factories rather than listed here.

## Mock tokens

| Token | Address | Decimals |
| --- | --- | --- |
| XSGD | [`0xC2FE292771719Ae948506bab3c156A622de9a415`](https://sepolia.arbiscan.io/address/0xC2FE292771719Ae948506bab3c156A622de9a415) | 6 |
| USDT | [`0x5f079A5934C864D6881EF30cf74Fe1363F58B856`](https://sepolia.arbiscan.io/address/0x5f079A5934C864D6881EF30cf74Fe1363F58B856) | 6 |
| USDC | [`0x4CBf2C15243678206dF8F248D01a0e117C8ce0cd`](https://sepolia.arbiscan.io/address/0x4CBf2C15243678206dF8F248D01a0e117C8ce0cd) | 6 |

## Earlier registries still used for verification

`firebase/functions/auditRegistry.history.json` keeps these so receipts anchored on them still verify. Records on them are read-only in the app.

| Registry | Deployed | Replaced |
| --- | --- | --- |
| `0xF202ECc872Be5613C184Cc07622346750f9b8fE9` | 9 October 2026 | 17 October 2026 |
| `0xc582a423bbcd08d6B9D930F53bd5ee054965b74f` | 8 October 2026 | 9 October 2026 |

## Retired deployments

These are no longer in the history file, so the app does not verify records against them. Their deployment records stay in the repository for reference.

| Contract | Address | Notes |
| --- | --- | --- |
| `EscrowAuditRegistry` | `0x2C23b72d6717E982cccd6F4eBe92C9d3448BFcD0` | Escrow-linked registry from 29 September 2026, with factory `0xDF28146Bfe0f4e2c926bf3bc1bb5750A72CAAc66`. Smoke-test evidence in `contracts/funding-escrow/manifests/arbitrumSepolia-2026-09-29-smoke.json` |
| Linked registry | `0xb901B23382322090A1Ea7bC6b8a9d2D422e855FD` | Before QCDAO-110. Record in `contracts/audit-registry/legacy/pre-qcdao-110-arbitrumSepolia.deployment.json` |
| `AuditRegistry` (scheme 2) | `0x47dA28cAEf8021dD88fe18B80e367746e0036964` | September 2026 security replacement. Record in `contracts/audit-registry/legacy/pre-escrow-arbitrumSepolia.*.json` |
| `AuditRegistry` (original) | `0x8E0BB204c2b805d4c8654791a56f3Bd96e8FD1CD` | First deployment, 2 September 2026 |

## QFT token

`contracts/qft-tokens/contracts/QFT.sol` is a fixed-supply ERC-20. No deployment address is recorded in the repository. The deploy script writes its record to `contracts/qft-tokens/deployments/`, which is in `.gitignore`, so any record exists only on the machine that ran the deploy. Record the address here once confirmed.
