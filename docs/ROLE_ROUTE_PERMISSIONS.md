# Role-to-Route Permission Matrix (UAT Reference)

This document specifies the access control rules for SMU QC DAO across all platform roles, delivering O1-KR4 (unauthorised route access blocked for all five roles).

## 1. Platform Roles

| Role Key | Role Name | Description |
|---|---|---|
| `guest` | Unauthenticated Visitor | Public user browsing open challenges and marketing pages. |
| `owner` | Problem Owner | Enterprise / institution posing challenges and reviewing researcher proposals. |
| `researcher` | Researcher | Academic / researcher publishing funding requests and submitting technical proposals. |
| `evaluator` | Evaluator | Domain expert conducting blind reviews and scoring proposals against rubrics. |
| `funder` | Funder | Grant agency / investor funding open challenges and managing milestone disbursements. |
| `admin` | DAO / Platform Admin | Platform administrator overseeing dispute arbitration, registries, and smart contract audit logs. |

---

## 2. Route Permission Matrix

| Route Path | Description | Public / Guest | Problem Owner (`owner`) | Researcher (`researcher`) | Evaluator (`evaluator`) | Funder (`funder`) | Admin (`admin`) | Unauthorized Action |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|---|
| `#/home` | Platform Landing & Hero | Allow | Allow | Allow | Allow | Allow | Allow | None (Public) |
| `#/discover` | Explore Opportunities | Allow | Allow | Allow | Allow | Allow | Allow | None (Public) |
| `#/opportunity/:id` | Opportunity Detail | Allow | Allow | Allow | Allow | Allow | Allow | None (Public) |
| `#/login` | Role Authentication | Allow | Redirect to Home | Redirect to Home | Redirect to Home | Redirect to Home | Redirect to Home | Preserves ?redirect= param |
| `#/create` | Publish Problem Statement / Brief | 401 Redirect | Allow (Business Problem, Open Funding) | Allow (Funding Request only) | 403 Forbidden | Allow (Open Funding, Business Problem) | 403 Forbidden | 401 Redirect / 403 Access Denied |
| `#/my-problems` | Manage Owned Problems & Submissions | 401 Redirect | Allow | 403 Forbidden | 403 Forbidden | 403 Forbidden | 403 Forbidden | 401 Redirect / 403 Access Denied |
| `#/proposals` | Researcher Proposal Dashboard | 401 Redirect | 403 Forbidden | Allow | 403 Forbidden | 403 Forbidden | 403 Forbidden | 401 Redirect / 403 Access Denied |
| `#/evaluations` | Expert Evaluation & Scoring Queue | 401 Redirect | 403 Forbidden | 403 Forbidden | Allow | 403 Forbidden | 403 Forbidden | 401 Redirect / 403 Access Denied |
| `#/funding` | Funding Commitments & Escrow | 401 Redirect | 403 Forbidden | 403 Forbidden | 403 Forbidden | Allow | 403 Forbidden | 401 Redirect / 403 Access Denied |
| `#/admin` | Platform Audit Trail & Registries | 401 Redirect | 403 Forbidden | 403 Forbidden | 403 Forbidden | 403 Forbidden | Allow | 401 Redirect / 403 Access Denied |
| `#/access-denied` | 403 Access Restricted Screen | Allow | Allow | Allow | Allow | Allow | Allow | Generic, secure 403 error boundary |
| `*` | Unknown Route | 404 | 404 | 404 | 404 | 404 | 404 | Displays 404 Not Found screen |

---

## 3. Navigation Menu Mapping per Role

Each role sees only relevant, permitted menu items in the top navigation bar:

- **Guest / Unauthenticated**:
  - `Home` (`#/home`)
  - `Discover` (`#/discover`)
  - `Sign In` (`#/login`)
- **Problem Owner (`owner`)**:
  - `Home` (`#/home`)
  - `Discover` (`#/discover`)
  - `Create Brief` (`#/create` - Business Problem, Open Funding)
  - `My Problems` (`#/my-problems`)
- **Researcher (`researcher`)**:
  - `Home` (`#/home`)
  - `Discover` (`#/discover`)
  - `Create Brief` (`#/create` - Funding Request only)
  - `My Proposals` (`#/proposals`)
- **Evaluator (`evaluator`)**:
  - `Home` (`#/home`)
  - `Discover` (`#/discover`)
  - `Evaluation Queue` (`#/evaluations`)
- **Funder (`funder`)**:
  - `Home` (`#/home`)
  - `Discover` (`#/discover`)
  - `Create Brief` (`#/create` - Open Funding, Business Problem)
  - `Funding Management` (`#/funding`)
- **Admin (`admin`)**:
  - `Home` (`#/home`)
  - `Discover` (`#/discover`)
  - `Admin Audit` (`#/admin`)

---

## 4. Opportunity Creation Access Rules

- **Funding Request (`funding-request`)**: Exclusively reserved for Researchers. Problem Owners, Funders, and Evaluators cannot submit funding requests.
- **Business Problem (`business-problem`)**: Reserved for Problem Owners and Funders.
- **Open Funding (`open-funding`)**: Reserved for Funders and Problem Owners.
- **Evaluators & Admin**: Do not create briefs or funding calls; route `#/create` is restricted (403).

---
## 5. Temporary Demo Mode & Role Switcher
### 5.1 Purpose
During early proof-of-concept testing and grading evaluation, a temporary Demo Mode is supported to allow evaluators to rapidly switch between the five platform roles without needing multiple browser sessions or registered database accounts.
### 5.2 Implementation Details
- Feature Flag: Controlled in frontend/src/config/features.js (FEATURES.DEMO_ROLE_SWITCHER).
- Activation:
  - URL Query Parameter: Append ?demo=true to the URL (e.g. http://localhost:5173/?demo=true).
  - Environment Variable: Set VITE_ENABLE_DEMO_MODE=true in the frontend environment.
- Default State: Disabled by default in production (http://localhost:5173/), which presents the standard institutional sign-in form and hides the demo toolbar.
- Components Involved:
  - DemoToolbar in frontend/src/App.jsx
  - Persona selection cards and instant enter buttons in frontend/src/components/Login.jsx
  - Hardcoded persona profiles in DEMO_USERS inside frontend/src/config/roles.js
### 5.3 Mandatory Decommissioning Requirement
Once account details and role resolution are permanently integrated with Firebase Auth and Firestore:
1. Remove Demo Components: The DemoToolbar component, mock persona cards in Login.jsx, and mock DEMO_USERS dictionary in roles.js must be deleted from the repository.
2. Remove Feature Flag: Delete frontend/src/config/features.js and remove conditional demo checks from App.jsx.
3. Enforce Backend Authority: Role assignment must strictly originate from authenticated Firebase ID Token custom claims or Firestore user profile documents (/users/{uid}). Client-side role spoofing or switching must not exist in production builds.
---