# Runbook

Routine tasks for whoever operates the platform. Most are done in the app as an administrator. The admin workspace is `#/admin`, labelled **Admin Audit** in the navigation.

## Admin workspace sections

| Group | Section | Use it to |
| --- | --- | --- |
| Workspace | Overview | See live platform activity and items needing attention |
| Workspace | Service health | Check the RPC, the registry, the audit queue and Firestore |
| Manage | Escrows & refunds | Inspect proposal funding and cancel eligible unpaid escrows with a reason |
| Manage | Content reports | Review reported content and hide, remove or restore it |
| Manage | Users & access | Search accounts, change roles, suspend or reinstate |
| Manage | Proposal export | Download an accepted posting and its comments as JSON and CSV. Grading stays outside the platform |
| Audit records | Proposal verification | Inspect proposal receipts and retry failed confirmations |
| Audit records | Problem statements | Review postings and their verification records |
| Audit records | Funding calls | Review open funding calls and their verification records |
| Audit records | Governance history | Trace administrator decisions, expiry actions and other events |

## People and access

| Task | How |
| --- | --- |
| Make someone an evaluator | **Users & access**, **Change role**, choose evaluator (2), give a reason. They see the evaluation queue after signing in again |
| Make someone an administrator | Same, choose administrator (1). Administrators cannot change their own role |
| Remove a role | Same, choose user (0). If their email is in `ADMIN_BOOTSTRAP_EMAILS`, remove it first or the next sign-in makes them an administrator again |
| Suspend an account | **Users & access**, suspend with a reason. Their sessions end straight away on every device |
| First administrator of a new project | `ADMIN_BOOTSTRAP_EMAILS`, see [Firebase](../setup/firebase.md), step 14 |

Every role change and suspension is written to the `audits` collection with the reason.

## Content and workflow

| Task | How |
| --- | --- |
| Handle a report | **Content reports**: open the item, read the context, then hide, remove or restore with a reason. The decision is anchored on-chain and appears in the audit trail |
| Expire a posting early | Use the expiry utility on the admin page, which calls `adminForceExpireOpportunity`. Expiry records the status and opens refunds. It never moves funds itself |
| Cancel an unpaid escrow | **Escrows & refunds**: choose the escrow and give a reason. Refused once any payment has been made. Funders then claim their own refunds |
| Export proposals for external grading | **Proposal export**: one accepted posting, or a UTC date range. The download is JSON and CSV, and the action is written to `audits`. See [Export selected proposals](proposal-export.md) |
| Retry a stuck proposal receipt | **Proposal verification**: retry confirmation after the automatic attempts are used up. Jobs with no transaction wait for the researcher's wallet |

## Platform upkeep

| Task | How |
| --- | --- |
| Rotate the Privy secret | Regenerate it in Privy, run `npx firebase functions:secrets:set PRIVY_SECRET`, then redeploy functions. Sign-in fails between the two steps |
| Rotate the platform signer | Not possible by secret alone. The factory records the signer address, so a new signer means new contracts |
| Add a preview origin | Privy allowed origins and the reCAPTCHA key domains. Remove them when the channel expires |
| Top up the faucet | Send Arbitrum Sepolia ETH to the faucet wallet when claims fail with "The test-token faucet is temporarily unavailable" and the Vercel logs show the faucet is paused |
| Turn on the attachment sweeper | Read a dry-run log, then set `ATTACHMENT_SWEEP_ENABLED=true` in the functions environment and redeploy |
| Rebuild projections | `node firebase/functions/scripts/backfill-metrics.mjs --project=<id> --apply` or `backfill-escrow-progress.mjs` with the same flags. The metrics backfill handles 10 pages of 100 records per run, so re-run it until it reports done, ideally in a quiet period |
| Reset all development data | `firebase/functions/scripts/reset-dev-data.mjs`. See below |

### Resetting development data

`reset-dev-data.mjs` deletes every Firestore collection, every Storage object and every Auth user. It runs as a dry run unless `--confirm` repeats the project id, and it refuses a production reset of any project other than `qcdao-a0c7a`.

```bash
cd firebase/functions
# Emulator (start it first)
node scripts/reset-dev-data.mjs --project qcdao-a0c7a
node scripts/reset-dev-data.mjs --project qcdao-a0c7a --confirm qcdao-a0c7a

# Live project, with Application Default Credentials and no emulator variables set
node scripts/reset-dev-data.mjs --target production --project qcdao-a0c7a
node scripts/reset-dev-data.mjs --target production --project qcdao-a0c7a --confirm qcdao-a0c7a
```

On-chain records cannot be reset. After a reset, old anchors simply have no matching Firestore record.

If the reset stops with a message ending in `adc-troubleshooting/user-creds`, the credentials have no quota project. Run `gcloud auth application-default set-quota-project qcdao-a0c7a` and try again. The dry run lists everything before deleting, so a failed run has deleted nothing.

### Clearing content but keeping accounts

To start the platform empty but keep everyone's account, delete every collection except these three, and every Storage object. No script in the repository does this; run the reset's dry run first to list the collections, then delete the others from the Firebase console or with the Admin SDK's `recursiveDelete`.

| Keep | Why |
| --- | --- |
| `users` | Accounts, roles, emails and Privy ids |
| `publicProfiles` | Public names and organisations. Nothing recreates these for members who have already onboarded |
| `sessionRevocations` | Sign-out cutoffs. Without them a token issued before a sign-out works again until it expires |

Leave Firebase Auth alone so members can still sign in. `privyIdentities` and `privySessionRateLimits` are rebuilt at the next sign-in. Check afterwards that `users.stats` counters do not refer to deleted content. Escrow contracts for deleted proposals stay on Arbitrum Sepolia with any deposited test tokens, but the app no longer tracks them.

## Backups

The repository does not configure scheduled Firestore backups. Before risky work, such as a registry cutover or a data reset, take a managed export:

```bash
gcloud firestore export gs://<backup-bucket>/firestore-$(date +%Y%m%d) --project qcdao-a0c7a
```

Check the Firebase console for any backup schedule set up outside the repository before relying on one.

## Costs

The project runs on the Blaze plan with a budget alert. The largest steady costs are the one-minute scheduled jobs and RPC reads, which stay small at demo scale. Testnet gas sponsorship from Privy is free. A move to mainnet would add gas sponsorship credits and real token custody, and needs a fresh risk review.
