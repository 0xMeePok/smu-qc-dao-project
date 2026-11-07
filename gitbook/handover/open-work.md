# Open work and known gaps

Checked against the Jira project `QCDAO` and `main` at `a634f09c` on 7 November 2026. Every epic is Done. The only issue that is not Done is [QCDAO-147](https://qc-dao-fyp.atlassian.net/browse/QCDAO-147).

## Done on main, previously listed as open

| Story | What `main` does |
| --- | --- |
| [QCDAO-107](https://qc-dao-fyp.atlassian.net/browse/QCDAO-107) Export proposals and commenters | **Proposal export** writes JSON and CSV for one accepted posting, chosen proposals, or a UTC date range. See [Export selected proposals](../operations/proposal-export.md) |
| [QCDAO-118](https://qc-dao-fyp.atlassian.net/browse/QCDAO-118) Local currency | Indicative Google Finance quotes through `getFxRates`. A profile preference selects the currency. Token amounts stay the settlement unit. No Chainlink feed and no on-chain conversion. See `docs/fx-rates.md` |
| [QCDAO-151](https://qc-dao-fyp.atlassian.net/browse/QCDAO-151) Mocked on-ramp | **Add funds** on the account menu and the escrow panel. `dueSandbox` returns a labelled testnet simulation and does not call Due or move tokens. See [Due sandbox on/off-ramp](../setup/due-on-off-ramp.md) |
| [QCDAO-155](https://qc-dao-fyp.atlassian.net/browse/QCDAO-155) Role promotion | **Users & access**, **Change role** calls `adminChangeRole` with a reason. Access levels are 0 (member), 1 (administrator) and 2 (evaluator). An administrator cannot change their own role |
| [QCDAO-156](https://qc-dao-fyp.atlassian.net/browse/QCDAO-156) Wallet actions | The account menu shows email, address and XSGD, USDT and USDC balances, and can send tokens or claim from the faucet |
| [QCDAO-157](https://qc-dao-fyp.atlassian.net/browse/QCDAO-157) AI drafting | `draftWithAI` fills empty text fields. `findSimilarProposals` warns about existing proposals. Amounts, currency, expiry and dates stay with the author. See `docs/ai-assistance.md` |
| [QCDAO-158](https://qc-dao-fyp.atlassian.net/browse/QCDAO-158) CI/CD | Checks and deploy are jobs in `.github/workflows/ci.yml`. Each area runs when its files change. See [CI/CD and quality checks](../repository/ci-cd.md) |
| [QCDAO-159](https://qc-dao-fyp.atlassian.net/browse/QCDAO-159) UI polish | Done in Jira. Shared styling, spacing and states across the screens added in later sprints |
| [QCDAO-160](https://qc-dao-fyp.atlassian.net/browse/QCDAO-160) Security scan | Done in Jira. Semgrep and Gitleaks still run in CI. Risks the repository still records are in the table below |

## Still not Done

| Story | What is asked | State of the code | Suggested next step |
| --- | --- | --- | --- |
| [QCDAO-147](https://qc-dao-fyp.atlassian.net/browse/QCDAO-147) Get test stablecoins inside QC DAO | A faucet action on the escrow funding panel and in the account menu | Moved back to the product backlog. The account menu **Faucet** calls `claimWalletTokens`. The escrow panel has **Add funds**, which is the QCDAO-151 simulation, and no faucet action | Leave it on the backlog. QCDAO-151's scope keeps minting on the standalone faucet. Reopen only if the escrow panel must mint tokens too |

Final documentation, UAT evidence and the demo still have no tickets.

## Known gaps and risks

| Area | Gap | Why it matters | Suggested action |
| --- | --- | --- | --- |
| Testing | `docs/ESCROW_REGISTRY_INTEGRATION.md` records that the full signed-in browser workflow had not been exercised against the live escrow when it was written on 29 September. The contracts and backend have changed since | Automated tests do not drive Privy's modal or paymaster | Run the [manual release checks](../operations/testing.md#manual-checks-before-a-release) and save the evidence in `docs/testing/` |
| Platform wallet | The wallet `0x1c608C148F64Fb9657bA4e5fB8992345277371C0` is the contract owner, fee recipient and platform signer | Whoever holds it controls fees, the token list and every payout | Decide with the sponsor who holds it after handover. The platform signer cannot be changed without new contracts |
| Contracts | Explorer source verification was not requested for the 17 October deployment. Runtime bytecode and wiring were verified | Arbiscan does not show the source for the active contracts | Run `npm run verify:source` in `contracts/funding-escrow` for the registry and factory |
| QFT token | No deployment address is recorded in the repository, although QCDAO-103 is Done. `contracts/qft-tokens/deployments/` is gitignored, so a record may exist only on the deployer's machine | The sponsor plans to distribute QFT for activity | Ask whoever ran the deploy for the record. If it exists, add the address to [Contract addresses](../reference/contract-addresses.md) and the root README |
| Data | The repository configures no scheduled Firestore backups | A bad migration or reset cannot be undone | Set a backup schedule in the console, or take exports before risky work |
| Local development | No App Check debug provider is wired | A local frontend cannot call the live project's functions | Use emulators or preview channels, or add the debug provider |
| Legacy code | The off-chain mock matching flow (eight callables and a scheduled job) is still deployed | Extra surface to maintain | Remove it once no live record depends on it |
| Licence | `LICENSE` is GPL-3.0, the Solidity files declare MIT, and the README shows a licence placeholder | Unclear terms for the sponsor | Decide the licence with the sponsor and make all three agree |
| CI | The AI review only runs for the four current contributors' GitHub logins | New team members get no review | Update the list in `ai-security-review.yml` |
| Privy | CAPTCHA is off | Sign-up relies on email codes and rate limits only | Enable Turnstile and update the CSP together if abuse appears |
