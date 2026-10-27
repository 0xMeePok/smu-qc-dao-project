# Repository docs

The repository has its own Markdown docs next to the code. This page lists them with their state at `main` @ `7d3907b` on 25 October 2026, so you know which to trust.

When two sources disagree, trust them in this order: the code, then this book, then the older docs.

## Updated for this handover

These were checked against the code and corrected in the same change that added this book.

| Document | What it covers | Notes |
| --- | --- | --- |
| `README.md` | Project overview, structure, quick start, contract addresses | Rewritten sections: structure, setup, contracts, status, licence |
| `frontend/README.md` | React app layout, environment, tests | Privy sign-in and the one-hour idle timeout |
| `firebase/README.md` | Functions, rules, collections, emulators | Function counts and tree refreshed |
| `docs/firebase-setup.md` | Creating and connecting a Firebase project | Storage bucket and App Check steps added |
| `docs/ROLE_ROUTE_PERMISSIONS.md` | Capabilities, route matrix, navigation | Rebuilt from `routes.js` and `roles.js` |
| `docs/AUDIT_REGISTRY_INTEGRATION.md` | Canonical hashing, anchoring calls, receipts | Active registry, `commitProposalWithEscrow`, gas sponsorship |
| `docs/ESCROW_REGISTRY_INTEGRATION.md` | Escrow terms, funding, settlement, verification | New current-deployment section. The September rollout and validation results are marked historical |
| `docs/AI_SECURITY_REVIEW.md` | The Fireworks PR security review | Model, chunking and contributor list |
| `docs/contributing.md` | Branches, commits, pull request rules | Semgrep advisory rule count |
| `contracts/funding-escrow/README.md` | Escrow, grant pool and crowdfunding contracts | Current addresses added. Dated sections kept as history |
| `contracts/audit-registry/README.md` | The original `AuditRegistry` package | Pointer to the active registry added |
| `firebase/MOCK_MATCHING.md` | The legacy off-chain mock matching flow | Status note: escrow has replaced it for new proposals |
| `docs/architecture/README.md` | PNG and SVG exports of the architecture diagrams | New. The Mermaid source lives in [Architecture](../overview/architecture.md) |

## Added with the selected-proposal export

| Document | What it covers |
| --- | --- |
| `docs/schemas/selected-proposal-export.schema.json` | JSON Schema for the administrator export, including the CSV column order. See [Export selected proposals](../operations/proposal-export.md) |

## Not reviewed in this handover

These were not changed. A scan for retired addresses and the old SIWE sign-in found nothing out of date, but they were not checked line by line.

| Document | What it covers |
| --- | --- |
| `docs/FIRESTORE_WORKFLOW_SCHEMA.md` | Field-level schema for accounts, discover aggregates, revisions, owner reviews and workflow status |
| `docs/eip7702-wallet-compatibility.md` | How Privy's EIP-7702 delegation affects the embedded wallet and server verification (QCDAO-146) |
| `contracts/stable-faucet/README.md` | The faucet release bundle. Its token addresses match the active mock tokens |
| `contracts/stable-faucet/site/README.md` | Running and deploying the Vercel faucet site |
| `contracts/qft-tokens/README.md` | Deploying the QFT token. No deployed address is recorded |
| `firebase/functions/scripts/fixtures/README.md` | Seed PDFs used by `mock_data.mjs` |

## Historical records

Dated reports and earlier procedures. Keep them as evidence, not as instructions for the current system.

| Document | What it records |
| --- | --- |
| `docs/registry-cutover.md` | The September 2026 scheme-2 registry cutover. Still the reference procedure for switching registries |
| `docs/security-remediation-131-139.md` | Remediation of QCDAO-131 to 139, dated 14 September 2026 |
| `docs/testing/workflow-repeat-validation-2026-10-02.md` | A 2 October 2026 browser validation run that used MetaMask and SIWE sign-in, which Privy has since replaced |

## Design tool notes

`.superdesign/` holds notes for the Superdesign UI tool: the design system, components, layouts, pages, routes and theme. They guide visual work and are not product documentation.
