# Frontend

The frontend is a React 18 single-page app built with Vite. It has no UI framework and no router library. Everything is in `frontend/`.

## How the app starts

`src/main.jsx` applies the saved theme and wraps the app in its providers, from the outside in:

1. `PrivyProvider`, only when `VITE_PRIVY_APP_ID` is set. Without it the app still renders and the sign-in screen explains what is missing.
2. `QueryClientProvider` for TanStack React Query.
3. `WalletProvider` (`src/context/WalletContext.jsx`): Privy login, the embedded wallet and sponsored sending.
4. `SessionProvider` (`src/context/SessionContext.jsx`): the sign-in state machine.
5. `App` (`src/App.jsx`): top bar, hash router and pages.

Privy is configured in `src/lib/privy.js`: email is the only login method, the embedded Ethereum wallet is created on first login, external wallets and WalletConnect are switched off, and the only chain is Arbitrum Sepolia.

Firebase is configured in `src/lib/firebase.js`. It starts App Check with the reCAPTCHA Enterprise provider when a site key is set and the app is not using emulators, keeps the session in IndexedDB (falling back to localStorage), and connects to the local emulators when `VITE_FIREBASE_USE_EMULATORS=true`. `FUNCTIONS_REGION` must match the functions region, `asia-southeast1`.

## Session states

`SessionContext` moves through five states:

| State | Meaning |
| --- | --- |
| `signed-out` | No verified account |
| `verifying` | Privy's modal is open, or the access token is being exchanged for a Firebase session |
| `checking` | Verified, looking up `users/{address}` |
| `needs-onboarding` | Verified, no profile yet, so the onboarding form opens |
| `signed-in` | Verified with a profile |

Nothing touches Firestore until `verifying` finishes on the server. Sign-out, the one-hour idle timeout (`src/lib/idleTimeout.js`), suspension and a failed sign-in all end both the Privy and the Firebase session. A Privy session found without a Firebase session beside it is ended straight away.

`src/context/AuthContext.jsx` turns the profile into the capabilities used by route guards. `src/lib/roles.js` maps the access level: `0` gives owner, researcher and funder, `2` adds evaluator, `1` gives admin only. A suspended account is treated as a guest.

## Routes

Routes are hash routes, `#/<key>`, defined in `src/config/routes.js`. `RouteGuard` and `evaluateRouteAccess()` send signed-out visitors to `#/login?redirect=...` and show `#/access-denied` when a capability is missing.

| Route | Page or view | Who can open it |
| --- | --- | --- |
| `#/home` | `Home` in `App.jsx`, built on `HomePage` | Everyone |
| `#/discover` | `Discover` in `App.jsx`, the opportunity catalogue | Everyone |
| `#/posting/<id>` | `PostingDetailPage` | Everyone for published postings |
| `#/solutions` | `IndependentListingsPage` | Members |
| `#/create` | `CreatePostingPage` or `CreateFundingOpportunityPage` | Members |
| `#/create-funding` | `CreateFundingOpportunityPage` | Members |
| `#/edit-posting/<id>` | `OpportunityEditPage` | Members (the owner) |
| `#/submit-proposal/<postingId>` | `CreateProposalPage` | Members |
| `#/edit-proposal/<id>` | `CreateProposalPage` | Members (the author) |
| `#/proposal/<id>` | `ProposalDetailPage` | Members and administrators |
| `#/create-proposal` | `CreateIndependentProposalPage` | Members |
| `#/approach/<id>` | `FundingApproachDetailPage` | Members |
| `#/actions` | `ActionNeeded` in `components/RoleViews.jsx` | Members |
| `#/my-problems` | `MyProblems` in `RoleViews.jsx` | Members |
| `#/proposals` | `ResearcherProposals` in `RoleViews.jsx` | Members |
| `#/evaluations` | `EvaluatorQueue` in `RoleViews.jsx` | Evaluators (role 2) |
| `#/funding` | `FundingPortfolio` in `RoleViews.jsx` | Members |
| `#/profile` | `ProfilePage`, the signed-in user's own profile | Signed-in users |
| `#/profile/<address>` | `PublicProfilePage` | Everyone |
| `#/admin` | `AdminPage` | Administrators (role 1) |
| `#/architecture` | `ArchitectureHelpPage`, including the status legend | Everyone |
| `#/login`, `#/access-denied` | Sign-in and 403 screens | Everyone |

"Members" means any signed-in account with access level 0 or 2. Write records still pass Firestore rules and function checks, so a route guard is a convenience, not the security boundary. The full matrix is in `docs/ROLE_ROUTE_PERMISSIONS.md`.

## Folders in `src/`

| Folder | Contents |
| --- | --- |
| `pages/` | 14 route-level pages, loaded lazily through `components/LazyPage.jsx` |
| `components/` | 81 components. Groups: sign-in and onboarding (`SignInWithEmail`, `OnboardingModal`, `SignInProgress`), wallet (`AccountWallet`, `WalletTransactionRecovery`, `TokenSelect`), posting and proposal forms (`BriefWizard`, `AttachmentUploader`, `ProposalCategorySelect`), funding and escrow (`EscrowFundingPanel`, `EscrowLifecycle`, `OpenFundingPanel`, `IndependentFundingPanel`, `FundingApproachForm`), dashboards (`OwnerDashboardPanel`, `DeveloperDashboardPanel`, `FunderDashboard`), audit and trust (`AuditReceipt`, `ConsolidatedAuditTrail`, `VerifiedBadge`, `OnChainOffChainLegend`), moderation (`ModerationQueue`, `ReportContentButton`), admin (`UserManagementTable`, `PlatformStatusPanel`, `AdminEscrowCancellation`) and shared UI (`Modal`, `Field`, `StatusBadge`) |
| `lib/` | 67 modules of logic without UI: sign-in (`authFlow`, `privy`, `embeddedWallet`, `profile`, `idleTimeout`), chain access (`rpc`, `chain`, `chainClient`, `auditRegistry`, `escrow*`, `openFunding`, `independent*`, `walletTokens`), workflow data (`postings`, `proposals`, `publication`, `comments`, `moderation`, `fundingApproach`, `actionItems`), admin (`admin`, `adminActivity`, `platformStatus`), validation and formatting |
| `config/` | Routes, roles, admin sections, posting categories, workflow status re-export, and the contract manifests `auditRegistry.contract.json` and `independentFunding.contract.json` |
| `context/` | `WalletContext`, `SessionContext`, `AuthContext` |
| `hooks/` | `useLiveActivity`, which listens for lightweight activity signals and refetches through the normal readers |
| `styles.css` | The whole design system, with light and dark themes |

## Talking to the back ends

| Need | How the frontend does it |
| --- | --- |
| Read or write a record a member owns | Firestore SDK directly. Rules decide |
| Read data that spans owners or is private | A callable function through `httpsCallable` |
| Upload or download a PDF | Storage SDK. Downloads use `getBlob()` so every read is checked by rules |
| Read the chain | `src/lib/rpc.js`: one failover client over the configured and public RPCs, batched through Multicall3 |
| Send a transaction | `WalletContext.sendSponsoredTransaction`, which asks Privy to sponsor gas |
| Hash a record | Shared modules imported from `firebase/functions`, such as `auditCanonical.js` |

## Build

`npm run build` writes to `firebase/public`, which is the Hosting folder. `vite.config.js` also:

* runs `scripts/privy-build-config.mjs`, which fails the build if a Privy secret, private key or token is given a `VITE_` name,
* aliases `@stripe/crypto` to its lazy entry so Privy's unused on-ramp does not load Stripe on every page,
* keeps all dependencies in one `vendor` chunk and wallet actions in `wallet-actions`, so an open tab never needs a deleted helper chunk after a release.

`npm run dev` first runs `scripts/seed-dev.mjs`. It seeds sample postings into the emulators only, and skips quietly when they are not running.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Seed the emulators if they are up, then start Vite on `127.0.0.1:5173` |
| `npm run build` | Production build into `firebase/public` |
| `npm run preview` | Serve the last build locally |
| `npm test` | All Node test suites, then Vitest |
| `npm run test:unit`, `test:integration`, `test:a11y` | One group of tests |
| `npm run sync:audit-registry` | Copy the active contract manifest and ABIs into the frontend and functions configs |
