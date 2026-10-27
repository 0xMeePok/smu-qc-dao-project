# QC DAO handover guide

QC DAO is a working testnet platform. A new team can take it over by getting access to the accounts in the [handover checklist](handover/handover-checklist.md), following [Set up the platforms](setup/before-you-start.md), and then starting on the [open work](handover/open-work.md) left after Sprint 6.

This book explains how the repository is organised, which technologies it uses and why, how to set up Firebase, Google Cloud and Privy, and how to test, deploy and operate the platform.

## The platform in one paragraph

QC DAO is a blockchain-enabled open innovation platform. Problem owners post funded problem statements, funders post open funding calls, researchers submit quantum or quantum-adjacent proposals, evaluators add optional recommendations, and administrators moderate content. Members sign in with an email address through Privy, which creates an embedded wallet and pays their gas. Application data lives off-chain in Firebase. Record hashes, audit events and test-token escrows live on Arbitrum Sepolia, so each organisation can check key decisions without trusting the others.

## Snapshot

| Item | Value |
| --- | --- |
| Code described | `main` at commit `7d3907b`, 25 October 2026 |
| Repository | [github.com/0xMeePok/smu-qc-dao-project](https://github.com/0xMeePok/smu-qc-dao-project) |
| Live site | [qcdao-a0c7a.web.app](https://qcdao-a0c7a.web.app) |
| Firebase project | `qcdao-a0c7a`, region `asia-southeast1` |
| Blockchain | Arbitrum Sepolia testnet, chain ID `421614` |
| Backlog | Jira project `QCDAO` at [qc-dao-fyp.atlassian.net](https://qc-dao-fyp.atlassian.net/browse/QCDAO) |
| Wiki | Confluence space `QC` (QC DAO FYP) on the same Atlassian site |
| Course | IS483, Singapore Management University, sponsored by Professor Paul Griffin |

## How to use this book

| If you want to | Read |
| --- | --- |
| Understand what the platform does | [What QC DAO does](overview/what-qc-dao-does.md) |
| See how the parts fit together | [Architecture](overview/architecture.md) |
| Find your way around the code | [Repository map](repository/repository-map.md) |
| Run the app on your laptop | [Local development](setup/local-development.md) |
| Stand up your own copy of the backend | [Firebase](setup/firebase.md), [Google Cloud](setup/google-cloud.md), [Privy](setup/privy.md) |
| Ship a change | [Testing](operations/testing.md) and [Deployment](operations/deployment.md) |
| Fix something that broke | [Troubleshooting](operations/troubleshooting.md) |
| Pick up the remaining work | [Open work and known gaps](handover/open-work.md) |

## Team

| Name | Role |
| --- | --- |
| Ashley Chung Beng Hunn | Product Owner |
| Anthony Chew Jian Yee | Scrum Master |
| Daryl Yeo | Full Stack Developer |
| Lim Jun Wei | Full Stack Developer |

## Keeping this book current

This book lives in the `gitbook/` folder of the repository and syncs to GitBook through Git Sync. Edit it in GitBook or in a pull request, never both at once on the same page. Pushes that only touch `gitbook/` do not deploy. When the code changes, update the page that describes it in the same pull request.
