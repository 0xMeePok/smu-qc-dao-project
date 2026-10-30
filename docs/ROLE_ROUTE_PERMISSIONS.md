# Role-to-Route Permission Matrix (UAT Reference)

This document specifies the access control rules for SMU QC DAO across all platform roles and multi-role user accounts, delivering O1-KR4 (unauthorised route access blocked for all five roles).

Checked against `main` at `7d3907b` on 25 October 2026. The sources of truth are `frontend/src/config/routes.js` (routes), `frontend/src/lib/roles.js` (capabilities) and `frontend/src/components/RouteGuard.jsx` (enforcement).

## 1. Platform Roles & Multi-Role Architecture

The platform supports capability-based access control where a single registered user account can hold multiple participant capabilities without needing to switch accounts.

| Role key | Role name | What it covers | Held by |
|---|---|---|---|
| `guest` | Signed-out visitor | Opens the public pages. Posting content asks them to sign in. | Signed-out visitors |
| `owner` | Problem owner | Posts business problems, reviews proposals and selects one once it is fully funded. | Access levels 0 and 2 |
| `researcher` | Researcher | Submits proposals to postings and publishes independent proposals. | Access levels 0 and 2 |
| `funder` | Funder | Funds proposals through escrow, posts open funding calls and approaches independent proposals. | Access levels 0 and 2 |
| `evaluator` | Evaluator | Files one advisory recommendation per proposal they did not write: Recommend, Recommend with revisions or Do not recommend. There is no rubric scoring. | Access level 2 only |
| `admin` | DAO administrator | Manages users and roles, reviews content reports, verifies audit records and cancels eligible unpaid escrows. | Access level 1 only |

The access level is the number in `users/{address}.role`. Only the server can change it.

| Access level | Label | Capabilities (`capabilitiesForAccessLevel`) |
|---|---|---|
| `0` | User | `owner`, `researcher`, `funder` |
| `2` | Evaluator | `owner`, `researcher`, `funder`, `evaluator` |
| `1` | Administrator | `admin` only |

---

## 2. Route Permission Matrix

Access evaluation uses set intersection: a signed-in account may open a route if it holds at least one of the route's allowed capabilities. A route with no capability list and `authRequired: true` is open to any signed-in account. `RouteGuard` is a browser UX check only. Firestore rules and Cloud Functions are the security boundary.

"Sign-in redirect" means the visitor is sent to `#/login?redirect=<route>` and returned there after signing in.

| Route | Page | Guest | User (0) | Evaluator (2) | Admin (1) |
|---|---|:---:|:---:|:---:|:---:|
| `#/home` | Landing page | Allow | Allow | Allow | Allow |
| `#/discover` | Browse postings. Guests see a sign-in notice instead of listings | Allow | Allow | Allow | Allow |
| `#/posting/:id` | Posting detail. Guests are asked to sign in | Allow | Allow | Allow | Allow |
| `#/profile/:address` | Public profile | Allow | Allow | Allow | Allow |
| `#/architecture` | On-chain vs off-chain and status reference | Allow | Allow | Allow | Allow |
| `#/profile` | Own profile | Sign-in redirect | Allow | Allow | Allow |
| `#/proposal/:id` | Proposal detail | Sign-in redirect | Allow | Allow | Allow |
| `#/solutions` | Independent proposals | Sign-in redirect | Allow | Allow | 403 |
| `#/create` | New business problem. `#/create/:draftId` resumes a draft | Sign-in redirect | Allow | Allow | 403 |
| `#/create/open-funding` | New open funding call | Sign-in redirect | Allow | Allow | 403 |
| `#/create-funding/:draftId` | Resume an open funding draft | Sign-in redirect | Allow | Allow | 403 |
| `#/edit-posting/:id` | Edit a posting | Sign-in redirect | Allow | Allow | 403 |
| `#/actions` | Action Needed | Sign-in redirect | Allow | Allow | 403 |
| `#/my-problems` | Problem owner dashboard | Sign-in redirect | Allow | Allow | 403 |
| `#/proposals` | Researcher's proposals | Sign-in redirect | Allow | Allow | 403 |
| `#/submit-proposal/:postingId` | Submit a proposal to a posting | Sign-in redirect | Allow | Allow | 403 |
| `#/edit-proposal/:id` | Edit a proposal | Sign-in redirect | Allow | Allow | 403 |
| `#/create-proposal` | Publish an independent proposal. `#/create-proposal/:id` edits one | Sign-in redirect | Allow | Allow | 403 |
| `#/approach/:id` | Funding approach to an independent proposal | Sign-in redirect | Allow | Allow | 403 |
| `#/funding` | Funding portfolio | Sign-in redirect | Allow | Allow | 403 |
| `#/evaluations` | Evaluation queue | Sign-in redirect | 403 | Allow | 403 |
| `#/admin` | Admin Audit. `?tab=<section>` opens a section | Sign-in redirect | 403 | 403 | Allow |
| `#/login` | Sign in | Allow | Redirect | Redirect | Redirect |
| `#/access-denied` | 403 screen | Allow | Allow | Allow | Allow |
| Anything else | Not found | 404 | 404 | 404 | 404 |

A signed-in account that opens `#/login` goes to its `redirect` target when that route exists, otherwise to `#/admin` for administrators and `#/home` for everyone else.

---

## 3. Navigation Menu Mapping

Each user sees navigation links corresponding to their granted capabilities. Profile sits in the account menu and Create is the **New brief** button, so neither appears as a nav link.

- **Guest**:
  - Nav: `Home`, `Discover`
  - Header: theme toggle and **Sign in with email**
- **User (access level 0)**:
  - Nav: `Home`, `Discover`, `Solutions`, `Workspaces`
  - Workspaces tabs: `Action Needed`, `My Problems`, `My Proposals`, `Funding Portfolio`
  - Header: **New brief**, theme toggle, notifications, account menu (`Profile`, `Workspaces`, `Sign out`)
- **Evaluator (access level 2)**:
  - As a user, plus `Evaluation Queue` in the Workspaces tabs
- **DAO Admin (access level 1)**:
  - Nav: `Home`, `Discover`, `Admin Audit`
  - Header: theme toggle, notifications, account menu (`Profile`, `Sign out`)
  - Lands on `#/admin` after sign-in. Admin Audit opens on **Content reports** while reports are pending

Admin Audit sections, from `frontend/src/config/adminSections.js`: Overview, Service health, Escrows & refunds, Content reports, Users & access, Proposal verification, Problem statements, Funding calls and Governance history.

---

## 4. Opportunity Creation Access Rules

When creating a brief from **New brief** (`#/create`), users and evaluators choose between:

- **Business problem (`business-problem`)** at `#/create`, acting as problem owner.
- **Open funding (`open-funding`)** at `#/create/open-funding`, acting as funder.
- **Independent proposal** at `#/create-proposal`, acting as researcher. The listing appears under **Solutions**.

The older `funding-request` type is still defined in `frontend/src/data.js` but is not offered and is hidden from Discover.

Administrators get 403 on every creation route.

---

## 5. Production 403 Security Standards

- **Privacy & Security Boundaries**: The 403 page does not leak internal authorization rule lists, required permission names, or debugging switchers.
- **User Guidance**: Clearly indicates that access is restricted and provides a direct path back to the user's role dashboard or public exploration.

---

## 6. Authentication & Role Capability Resolution

### 6.1 Authentication Architecture
Authentication is Privy email sign-in. The server verifies Privy's access token, reads the embedded wallet Privy created for that email, and mints a Firebase custom token whose uid is that address:
1. **Account**: The Firebase uid and `users/{address}` id are the wallet address. `email` and `privyUserId` are written by the server. One email maps to one wallet.
2. **Session & Profile Resolution**: On successful authentication, the user's registered Firestore profile (`/users/{address}`) is loaded into `SessionContext` and mapped into `AuthContext`.
3. **Capability Set Assignment** (`capabilitiesForAccessLevel` in `frontend/src/lib/roles.js`):
   - **User**: `role == 0` receives `[owner, researcher, funder]`.
   - **Evaluator**: `role == 2` receives `[owner, researcher, funder, evaluator]`.
   - **DAO Administrator**: `role == 1` receives only `[admin]`. Granted through **Admin Audit → Users & access** or, for the first administrator, the `ADMIN_BOOTSTRAP_EMAILS` setting on Cloud Functions.
   - **Signed-out visitor**: Resolves to `[guest]`.
---

## 7. Evaluator Assignment Model (QCDAO-63)

`role = 2` (assigned evaluator) is granted by a DAO administrator from **Admin Audit → Users & access**. No
client path can set it: `firestore.rules` fixes `role` at 0 on create and immutable on every client update.

Once assigned, an evaluator **self-selects from an eligible pool** rather than being allocated individual proposals.
Every solution on a live posting (`submitted` or `open`) that the evaluator did not author appears in their queue at
`#/evaluations`, ordered by closing soonest. There is no per-proposal assignment record, and no automated matching by
expertise (explicitly out of scope).

A **qualifying evaluator recommendation comment** is the unit of progress for both QCDAO-62 and QCDAO-63: an active,
non-deleted, unmoderated, top-level comment whose author holds the evaluator access level (server-derived badge),
carrying exactly one of `recommend`, `recommend_with_revisions` or `do_not_recommend`. Replies never qualify. The
server maintains `proposals/{id}.matching.evaluationComplete` from that same rule, so no separate evaluation record
is stored.

Since QCDAO-91 **any number of evaluators** may recommend the same proposal, **one recommendation each**, and never
their own proposal. `proposals/{id}.matching.recommendations` maps each evaluator to `{ commentId, recommendation, at }`;
every recommendation rewrites that map, so two filings at once serialise on the proposal document and a second from
the same evaluator is refused ("Edit or delete that comment to change it"). `Awaiting recommendation` lists proposals
the signed-in evaluator has not recommended yet, whatever other evaluators have filed.

An evaluator recommendation comment, a funder comment, and any other stakeholder comment stay advisory. None of them creates an owner review outcome.

## 8. Owner interim review

Only the designated problem owner (`problems.ownerId`) can record an interim review on a proposal that is still under consideration. The owner chooses one outcome — record feedback, request revisions, or record that the proposal is not progressing — and must write a rationale. The developer sees the latest outcome on `#/proposals` and the full record on the proposal page.

A revision request uses the existing author correction path when that path is already open. It does not select a winner, reject a winner, or set a proposal to selected or awaiting creator acceptance. That terminal decision remains QCDAO-81, made only by the designated problem owner after the funding target is met. Evaluator recommendations are optional and advisory.

## 9. Action Needed workspace (QCDAO-91)

`#/actions` is the first workspace tab for every member, with a live count. The `listActionItems` callable reads
existing records only and returns what waits on the signed-in member:

| Group | Who | Condition | Acted on in place with |
|---|---|---|---|
| Ready to select | Problem owner | Fully funded, selectable proposal on a live problem they own | The comparison's selection dialog (rationale required) |
| Awaiting my review | Problem owner | Proposal still under consideration with no owner review yet | The owner review form |
| Selection to accept | Proposal creator | Their proposal is selected and the acceptance window is still open | The matching panel's accept / reject dialog |
| Awaiting my recommendation | Assigned evaluator | Proposal they have not recommended (first queue page) | Links to the proposal's recommendation form |

Administrators have no Action Needed tab. The admin page opens on Content reports while reports are pending.
