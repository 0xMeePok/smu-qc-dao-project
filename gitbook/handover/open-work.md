# Open work and known gaps

## Sprint 6 stories

[QCDAO-107](https://qc-dao-fyp.atlassian.net/browse/QCDAO-107) is built. An administrator exports an accepted posting, or every accepted posting in a date range, from **Proposal export**. See [Export selected proposals](../operations/proposal-export.md).

[QCDAO-158](https://qc-dao-fyp.atlassian.net/browse/QCDAO-158) is built. `deploy.yml`, `funding-escrow.yml`, `gitleaks.yml` and `semgrep.yml` are jobs in `.github/workflows/ci.yml`, with shared setup in `.github/actions/setup-workspace`. Each area runs only when its files change, and **CI** is the required check. See [CI/CD and quality checks](../repository/ci-cd.md).

Five stories are still open.

| Story | What is asked | State of the code | Suggested next step |
| --- | --- | --- | --- |
| [QCDAO-118](https://qc-dao-fyp.atlassian.net/browse/QCDAO-118) Local currency through a Chainlink price feed | Show an indicative local-currency value beside token amounts, with a profile preference and graceful fallback | Not started | Confirm which Chainlink feeds exist on Arbitrum Sepolia before committing. Read the feed through the existing RPC client. Marked nice-to-have |
| [QCDAO-147](https://qc-dao-fyp.atlassian.net/browse/QCDAO-147) Get test stablecoins inside QC DAO | A faucet action on the escrow funding panel and in the account menu | Partly built. The account menu has **Faucet**, backed by `claimWalletTokens` (pull request #120). The funding panel has no entry point yet | Add the action to `EscrowFundingPanel`, then run the acceptance criteria and close the story |
| [QCDAO-151](https://qc-dao-fyp.atlassian.net/browse/QCDAO-151) Add funds through Privy's on-ramp, mocked on testnet | An **Add funds** button that hands off to the faucet on testnet and opens Privy's funding window on mainnet | Partly built. The account menu's **Add funds** opens an informational on-ramp preview | Add the funding panel entry point, the testnet hand-off to the faucet, and the mainnet setting |
| [QCDAO-155](https://qc-dao-fyp.atlassian.net/browse/QCDAO-155) Administrator and evaluator promotion | Promote members to administrator or evaluator from the user directory | Built. **Users & access**, **Change role** calls `adminChangeRole` with a reason | Run the acceptance criteria with Privy accounts and close the story |
| [QCDAO-157](https://qc-dao-fyp.atlassian.net/browse/QCDAO-157) Draft a posting or proposal from its title with AI | Generate editable drafts for every text field, never amounts or dates, with rate limits | Not started | Needs a model provider key in Secret Manager and a new callable. Keep it server-side so no key reaches the browser |

The proposal's Sprint 6 milestone also includes final documentation, UAT evidence and the demo, which have no tickets.

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
