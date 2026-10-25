# GitHub Actions

Pushes to `main` deploy to Firebase through `.github/workflows/deploy.yml`. The workflow needs the secrets and variables below, set under **Settings**, **Secrets and variables**, **Actions** in the repository.

## Joining the existing project

The secrets are already set. Ask for maintain or admin access to the repository, then check that the list under **Actions secrets** matches the table below. GitHub never shows a secret's value again, so a missing or wrong value has to be replaced, not read.

## Secrets

| Name | Value | Used by |
| --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_QCDAO_A0C7A` | The whole JSON key of the deploy service account, see [Google Cloud](google-cloud.md#deploy-account-for-github-actions) | Backend and Hosting deploys |
| `VITE_FIREBASE_API_KEY` | Web app `apiKey` | Frontend build |
| `VITE_FIREBASE_PROJECT_ID` | Project id | Frontend build and the bundle check |
| `VITE_FIREBASE_APP_ID` | Web app `appId` | Frontend build |
| `VITE_FIREBASE_APP_CHECK_SITE_KEY` | reCAPTCHA Enterprise site key | Frontend build. The deploy stops if it is missing |
| `VITE_FIREBASE_STORAGE_BUCKET` | Bucket name | Frontend build. Without it, attachments report that Storage is not configured |
| `FIREWORKS_API_KEY` | Fireworks AI API key | AI security review |
| `OPENAI_API_KEY` | OpenAI API key | AI security review, only after switching provider |

The `VITE_FIREBASE_*` values are public identifiers. They are kept as secrets so each fork supplies its own.

## Variables

| Name | Value | Notes |
| --- | --- | --- |
| `VITE_PRIVY_APP_ID` | Privy App ID | Required. Used for the build and written to the functions environment as `PRIVY_APP_ID`. A secret of the same name also works, and the variable wins |
| `ARBITRUM_SEPOLIA_RPC_URL` | Primary RPC URL | Optional. Defaults to `https://sepolia-rollup.arbitrum.io/rpc`. `VITE_ARBITRUM_SEPOLIA_RPC_URL` is also accepted |
| `ARBITRUM_SEPOLIA_RPC_BACKUP_URLS` | Comma-separated RPC URLs | Optional. Secret or variable. Cloud Functions read it with or without the `VITE_` prefix. The browser build and its CSP read only `VITE_ARBITRUM_SEPOLIA_RPC_BACKUP_URLS`, so use that name if browsers should fail over too |
| `SECURITY_REVIEW_*` | See [CI/CD and quality checks](../repository/ci-cd.md#ai-security-review) | Optional |

Never add a Privy secret, a private key or any server credential to the frontend build environment. Vite publishes every `VITE_` value in the bundle, and the build refuses Privy names that look like secrets.

## Setting them with the GitHub CLI

```bash
gh secret set FIREBASE_SERVICE_ACCOUNT_QCDAO_A0C7A < service-account.json
gh secret set VITE_FIREBASE_API_KEY
gh variable set VITE_PRIVY_APP_ID --body "<privy app id>"
```

`gh secret set` without `--body` prompts for the value, which keeps it out of your shell history.

## For a fresh project

1. Rename the service account secret, or keep the name and only change its value. If you rename it, update both places in `deploy.yml` that read it.
2. Change `FIREBASE_PROJECT_ID` at the top of `deploy.yml`.
3. Make the other project-specific changes listed in [Firebase](firebase.md), step 7.

## Branch protection

Protect `main` so that every change arrives through a reviewed pull request:

* Require a pull request with at least one approval.
* Require the **CI**, **Semgrep** and **Gitleaks** status checks.
* Do not allow force pushes.

GitBook commits book edits straight to the synced branch. If you protect `main` against direct pushes, either allow the GitBook app to bypass the rule or sync GitBook to a separate branch and merge it by pull request. See [GitBook](gitbook.md).

## Check that it works

Open **Actions**, run **Deploy** by hand with **Run workflow** on `main`, and confirm all five jobs pass. The last step, **Verify effective production CSP**, reads the live header.
