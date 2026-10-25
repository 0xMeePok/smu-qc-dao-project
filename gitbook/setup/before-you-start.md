# Before you start

There are two ways to take over the platform. Pick one before following the other setup pages.

| Path | When to choose it | What you set up |
| --- | --- | --- |
| **A. Join the existing project** | The sponsor keeps `qcdao-a0c7a`, the current Privy app and the current GitHub repository | Access to each account, your laptop, nothing else |
| **B. Stand up a fresh copy** | You need your own Firebase project, for example a new organisation or a clean environment | A new Firebase and Google Cloud project, a new Privy app, GitHub secrets, and optionally new contracts |

For local development alone, neither is needed: the emulators run without any cloud project. See [Local development](local-development.md).

## Accounts and access

Ask the current owners for these before the handover meeting. The [handover checklist](../handover/handover-checklist.md) tracks who holds each one.

| Account | What to request | Needed for |
| --- | --- | --- |
| GitHub `0xMeePok/smu-qc-dao-project` | Admin or maintain access | Code, Actions secrets, branch protection |
| Firebase project `qcdao-a0c7a` | Owner, or Editor plus Firebase Admin | Console, deploys, data |
| Google Cloud, same project | Comes with the Firebase role. Billing account access to manage the budget | IAM, Secret Manager, logs, billing |
| Privy app | Member of the Privy dashboard team | Login methods, allowed origins, gas sponsorship, app secret |
| Vercel project for the faucet | Member of the Vercel team that owns `smu-qc-dao-project.vercel.app` | Faucet key and redeploys |
| Jira and Confluence at `qc-dao-fyp.atlassian.net` | Project access | Backlog and history |
| GitBook | Member of the GitBook organisation | This book |
| Platform wallet `0x1c608C148F64Fb9657bA4e5fB8992345277371C0` | Secure transfer of the private key, or a new key and redeploy | Contract ownership, fees, settlement |
| Fireworks AI | API key, or switch the reviewer to OpenAI | AI security review on pull requests |

## Tools for your laptop

| Tool | Version | Why |
| --- | --- | --- |
| Git | Any recent | Clone and branch |
| Node.js and npm | 22.13 or newer | Functions run on Node 22, `contracts/funding-escrow` needs 22.13 or newer and the frontend needs 20.19 or newer, so 22.13 or newer covers all of them |
| Java | 17 or newer | Firestore emulator and the rules tests |
| Firebase CLI | Use the copy in `firebase/node_modules` through `npx firebase` | Emulators and deploys. Pinned to 14.27.0 |
| Google Cloud CLI (`gcloud`) | Any recent | Storage CORS and lifecycle, preview channels, IAM |
| A Chromium browser | Any recent | Privy's modal and DevTools for CSP checks |

## Order of work

For path B, follow the pages in this order. Each one ends with a check.

1. [Firebase](firebase.md), steps 1 to 9: project, Blaze plan, Authentication, Firestore, Storage, web app, App Check, project ids in the repository, CLI and functions environment.
2. [Google Cloud](google-cloud.md): budget, APIs, bucket settings and IAM.
3. [Privy](privy.md): app, email login, embedded wallets, allowed origins, gas sponsorship.
4. [Firebase](firebase.md), steps 10 to 15: secrets, backend deploy, web app deploy, first administrator.
5. [GitHub Actions](github-actions.md): service account, secrets and variables, so pushes to `main` deploy.
6. [Test-token faucet](test-token-faucet.md), if you need your own faucet.
7. [GitBook](gitbook.md), to keep this book in sync.

For path A, read each page's **Joining the existing project** section and skip the rest.
