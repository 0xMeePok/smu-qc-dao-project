# Role-to-Route Permission Matrix (UAT Reference)

This document specifies the access control rules for SMU QC DAO across all platform roles and multi-role user accounts, delivering O1-KR4 (unauthorised route access blocked for all five roles).

## 1. Platform Roles & Multi-Role Architecture

The platform supports capability-based access control where a single registered user account can hold multiple participant capabilities without needing to switch accounts.

| Role Key | Role Name | Description | Multi-Role Member Inclusion |
|---|---|---|:---:|
| `guest` | Unauthenticated Visitor | Public user browsing open challenges and marketing pages. | No |
| `owner` | Problem Owner | Enterprise / institution posing challenges and reviewing researcher proposals. | Yes |
| `researcher` | Researcher | Academic / researcher publishing funding requests and submitting technical proposals. | Yes |
| `evaluator` | Evaluator | Domain expert conducting blind reviews and scoring proposals against rubrics. | Yes |
| `funder` | Funder | Grant agency / investor funding open challenges and managing milestone disbursements. | Yes |
| `admin` | DAO / Platform Admin | Platform administrator overseeing dispute arbitration, registries, and smart contract audit logs. | Standalone Admin |

---

## 2. Route Permission Matrix

Access evaluation uses set intersection: an authenticated user is granted access if their account possesses at least one of the route's allowed roles (`user.roles.some(r => allowedRoles.includes(r))`).

| Route Path | Description | Public / Guest | Multi-Role Member (`owner+res+eval+fund`) | Standalone Admin (`admin`) | Unauthorized Action |
|---|---|:---:|:---:|:---:|---|
| `#/home` | Platform Landing & Hero | Allow | Allow | Allow | None (Public) |
| `#/discover` | Explore Opportunities | Allow | Allow | Allow | None (Public) |
| `#/opportunity/:id` | Opportunity Detail | Allow | Allow | Allow | None (Public) |
| `#/login` | Role Authentication | Allow | Redirect to Home | Redirect to Home | Preserves ?redirect= param |
| `#/create` | Publish Problem Statement / Brief | 401 Redirect | Allow (All 3 Brief Types) | 403 Forbidden | 401 Redirect / 403 Access Denied |
| `#/my-problems` | Manage Owned Problems & Submissions | 401 Redirect | Allow | 403 Forbidden | 401 Redirect / 403 Access Denied |
| `#/proposals` | Researcher Proposal Dashboard | 401 Redirect | Allow | 403 Forbidden | 401 Redirect / 403 Access Denied |
| `#/evaluations` | Expert Evaluation & Scoring Queue | 401 Redirect | Allow | 403 Forbidden | 401 Redirect / 403 Access Denied |
| `#/funding` | Funding Commitments & Escrow | 401 Redirect | Allow | 403 Forbidden | 401 Redirect / 403 Access Denied |
| `#/admin` | Platform Audit Trail & Registries | 401 Redirect | 403 Forbidden | Allow | 401 Redirect / 403 Access Denied |
| `#/access-denied` | 403 Access Restricted Screen | Allow | Allow | Allow | Generic, secure 403 error boundary |
| `*` | Unknown Route | 404 | 404 | 404 | Displays 404 Not Found screen |

---

## 3. Navigation Menu Mapping

Each user sees navigation links corresponding to their granted capabilities:

- **Guest / Unauthenticated**:
  - `Home` (`#/home`)
  - `Discover` (`#/discover`)
  - `Sign In` (`#/login`)
- **Multi-Role Platform Member (`owner + researcher + evaluator + funder`)**:
  - `Home` (`#/home`)
  - `Discover` (`#/discover`)
  - `Create Brief` (`#/create`)
  - `My Problems` (`#/my-problems`)
  - `My Proposals` (`#/proposals`)
  - `Evaluation Queue` (`#/evaluations`)
  - `Funding Portfolio` (`#/funding`)
- **DAO Admin (`admin`)**:
  - `Home` (`#/home`)
  - `Discover` (`#/discover`)
  - `Admin Audit` (`#/admin`)

---

## 4. Opportunity Creation Access Rules

When creating a brief on `#/create`:

- **Multi-Role Platform Member**: Can select between:
  - **Business Problem (`business-problem`)**: Acting as Problem Owner.
  - **Open Funding (`open-funding`)**: Acting as Funder.
  - **Funding Request (`funding-request`)**: Acting as Researcher.
- **Admin**: Route `#/create` is restricted (403 Forbidden).

---

## 5. Production 403 Security Standards

- **Privacy & Security Boundaries**: The 403 page does not leak internal authorization rule lists, required permission names, or debugging switchers.
- **User Guidance**: Clearly indicates that access is restricted and provides a direct path back to the user's role dashboard or public exploration.

---

## 6. Temporary Demo Mode & Multi-Role Switcher

### 6.1 Purpose
During early proof-of-concept testing and grading evaluation, a temporary Demo Mode is supported to allow evaluators to test multi-role member access and admin isolation without managing individual database accounts.

### 6.2 Implementation Details
- Feature Flag: Controlled in `frontend/src/config/features.js` (`FEATURES.DEMO_ROLE_SWITCHER`).
- Activation:
  - URL Query Parameter: Append `?demo=true` to the URL (e.g. `http://localhost:5173/?demo=true`).
  - Environment Variable: Set `VITE_ENABLE_DEMO_MODE=true` in the frontend environment.
- Default State: Disabled by default in production (`http://localhost:5173/`), presenting the standard institutional sign-in form and hiding the demo toolbar.
- Components Involved:
  - `DemoToolbar` in `frontend/src/App.jsx`
  - Profile selection cards in `frontend/src/components/Login.jsx`
  - Demo profiles in `DEMO_USERS` inside `frontend/src/config/roles.js`

### 6.3 Mandatory Decommissioning Requirement
Once account details and role resolution are permanently integrated with Firebase Auth and Firestore:
1. **Remove Demo Components**: The `DemoToolbar` component, mock profile cards in `Login.jsx`, and mock `DEMO_USERS` dictionary in `roles.js` must be deleted from the repository.
2. **Remove Feature Flag**: Delete `frontend/src/config/features.js` and remove conditional demo checks from `App.jsx`.
3. **Enforce Backend Authority**: Role capabilities array (`roles: string[]`) must strictly originate from authenticated Firebase ID Token custom claims or Firestore user profile documents (`/users/{uid}`). Client-side role spoofing or switching must not exist in production builds.