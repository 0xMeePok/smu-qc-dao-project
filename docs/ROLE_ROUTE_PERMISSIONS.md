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

## 6. Authentication & Role Capability Resolution

### 6.1 Authentication Architecture
Authentication is strictly enforced via Web3 Sign-In with Ethereum (SIWE) through Firebase Cloud Functions and custom auth tokens:
1. **Wallet Verification**: Users sign a server-issued cryptographic nonce to verify wallet ownership.
2. **Session & Profile Resolution**: On successful authentication, the user's registered Firestore profile (`/users/{address}`) is loaded into `SessionContext` and mapped into `AuthContext`.
3. **Capability Set Assignment**:
   - **Platform Participant**: User profiles (`role == 0` in Firestore) receive the full participant capability set: `[owner, researcher, evaluator, funder]`.
   - **DAO Administrator**: Dedicated admin profiles (`role == 1` in Firestore, assigned out-of-band/admin SDK) receive the isolated `[admin]` capability set.
   - **Unauthenticated Visitor**: Resolves to `[guest]`.