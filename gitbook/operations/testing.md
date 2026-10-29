# Testing

Each package has its own test suite. Suites that need emulators start and stop them by themselves, so you only need the dependencies installed and, for Firebase suites, Java.

## Suites

| Suite | Command, from the repository root | Test files | Needs |
| --- | --- | --- | --- |
| Frontend unit, integration and accessibility | `npm test --prefix frontend` | 126 | `firebase/functions` installed (shared modules) |
| Firestore and Storage rules | `npm test --prefix firebase` | 20 | Java |
| Cloud Functions | `npm test --prefix firebase/functions` | 69 | Java |
| Audit registry contracts | `npm test --prefix contracts/audit-registry` | 3 | Nothing else |
| Funding escrow contracts | `npm test --prefix contracts/funding-escrow` | 19, plus script and verifier tests | `contracts/audit-registry` installed, Node 22.13 or newer |
| Faucet contracts and site | `npm test --prefix contracts/stable-faucet`, then `npm test --prefix contracts/stable-faucet/site` | 1 and 7 | Both packages installed |
| AI review script | `node --test .github/scripts/security-review.test.mjs` | 1 | Nothing else |

Run the three application suites in one go:

```bash
npm test --prefix frontend && npm test --prefix firebase && npm test --prefix firebase/functions
```

If a suite fails to start with a port error, an emulator from another terminal is still running. Stop it with `pkill -f "firebase.*emulators"`.

## What the suites cover

* **Frontend:** route access for every role (`test/routeAccess.test.js`), validation, the idle timeout, the session state machine, workflow status labels, audit hashing golden vectors, escrow adapters, and component tests for each major panel. Accessibility tests run axe-core and colour contrast checks.
* **Rules:** a member can only create and read their own profile, `stats` cannot be written, the member list cannot be enumerated, `role` never leaks, publication proofs are required, drafts stay private, moderation boundaries hold, and Storage uploads are PDF only, owner only and immutable.
* **Functions:** Privy sign-in (including refusing an external wallet, a missing wallet or a browser-named address), EIP-7702 upgraded wallets, admin actions, the selected-proposal export, publication attestation, audit confirmation and recovery, expiry, escrow funding and settlement, moderation, notifications and the attachment sweeper.
* **Contracts:** accounting, fees, decimals, milestones, refunds, voting, token policy, moderation pauses, factory wiring, grant pools and independent crowdfunding, plus reconciliation of real receipts with the production event reconciler.

## End-to-end scripts

`scripts/main-funding-e2e.mjs` and `scripts/open-funding-e2e.mjs` run the real contracts on an isolated local chain with the production backend modules and a Firestore emulator. They cover both payment modes, rejections, refunds, expiry and grant top-ups. See [Local development](../setup/local-development.md#end-to-end-funding-tests) for the commands. Saved results are in `docs/testing/`.

## Manual checks before a release

Automated tests do not drive the real Privy modal or its paymaster. Before a demo or a major release, run through these on the live site or a preview channel, each with its own test account:

1. Sign in by email, complete onboarding, sign out and sign back in. The same address and profile return.
2. Publish a business problem with a PDF attachment and check its audit receipt shows **Verified match**.
3. As a second account, submit a proposal, then claim test tokens from the account menu.
4. As a third account, fund the proposal to its target.
5. As the problem owner, select it and approve. As the researcher, approve. Check that the upfront 50% is paid.
6. Submit delivery evidence, approve it from both owners and check the final payment.
7. As an administrator, report and remove a comment, then find the action in the audit trail.
8. Check **Admin Audit**, **Service health** shows no failing dependency.

`docs/testing/workflow-repeat-validation-2026-10-02.md` records an earlier run of these flows. Its MetaMask steps predate the move to Privy.
