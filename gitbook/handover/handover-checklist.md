# Handover checklist

Use this list in the handover meeting. Fill in the owner columns together, then tick each item once the new owner has confirmed access. Several accounts currently sit with individual team members, so nothing here should be left to a personal account after Week 13.

## Accounts and ownership

| Item | Current owner | New owner | Action | Done |
| --- | --- | --- | --- | --- |
| GitHub repository `0xMeePok/smu-qc-dao-project` (owned by a personal account) | | | Transfer the repository to the sponsor's or SMU's GitHub organisation, or add the new owner as admin. After a transfer, check the Actions secrets, branch protection and the GitBook app's access | [ ] |
| Firebase and Google Cloud project `qcdao-a0c7a` | | | Add the new owner as Owner. Move the billing account or set up the sponsor's | [ ] |
| Budget alert recipients | | | Point alerts at the new owner | [ ] |
| Privy app (team and billing) | | | Invite the new owner, hand over or regenerate the app secret | [ ] |
| Vercel project for the faucet | | | Transfer the project or add the new owner. Hand over the faucet key | [ ] |
| Platform wallet `0x1c608C148F64Fb9657bA4e5fB8992345277371C0` | | | Hand over the key securely, or plan new contracts with a new owner and signer | [ ] |
| Contract deployer keys | | | Same as above | [ ] |
| Faucet wallet and token owner key | | | Hand over with the Vercel project | [ ] |
| Fireworks AI key for PR reviews | | | Replace with the sponsor's key, switch to OpenAI, or disable the workflow | [ ] |
| Jira and Confluence site `qc-dao-fyp.atlassian.net` | | | Add the new owner as site admin, or export what they need | [ ] |
| GitBook organisation and space | | | Add the new owner as admin | [ ] |

## Knowledge transfer

| Item | Done |
| --- | --- |
| Walk through [Architecture](../overview/architecture.md) and the sign-in sequence | [ ] |
| New owner runs the app locally with emulators, following [Local development](../setup/local-development.md) | [ ] |
| New owner deploys a preview channel | [ ] |
| New owner signs in on the live site and is made an administrator | [ ] |
| Review [Open work and known gaps](open-work.md) and agree what happens to each item | [ ] |
| Run the [manual release checks](../operations/testing.md#manual-checks-before-a-release) together and store the evidence | [ ] |

## Close-out by the departing team

| Item | Done |
| --- | --- |
| All work merged to `main`, no long-lived branches left that matter | [ ] |
| Jira statuses match the code, including QCDAO-147, 151 and 155 | [ ] |
| This book and the repository docs updated for the final release | [ ] |
| Final release tagged in Git | [ ] |
| UAT evidence and the final demo recording stored where the sponsor can reach them | [ ] |
| Departing members removed from Firebase, Privy, Vercel, GitHub and Atlassian after the new owner confirms access | [ ] |
| Personal `ADMIN_BOOTSTRAP_EMAILS` entries replaced with the new owner's email | [ ] |

## AI drafting handover (QCDAO-157)

- Transfer the OpenAI project and replace `OPENAI_API_KEY` in repository Actions secrets. The deployment copies it into Google Secret Manager; never put it into a `VITE_` variable.
- Demonstrate the form side panel, per-field review, similar-proposal links, and the AI-assisted detail indicator. The author still enters payment terms and publishes.
- Review generation limits (3/minute and 20/day per member; 200/day platform-wide), the separate retrieval quota, App Check, and the `AI_DRAFT_ENABLED` / `AI_SIMILARITY_ENABLED` kill switches.
- Confirm Firestore TTL for `aiUsage.expiresAt` and `aiRequests.expiresAt`, provider spend alerts, Secret Manager permissions, and the sample-preview versus live-provider distinction.
- Read the versioned prompt, supported model, response schema, and retrieval limitations in [the repository AI assistance guide](https://github.com/0xMeePok/smu-qc-dao-project/blob/main/docs/ai-assistance.md).
