# GitHub Actions

Pushes to `main` deploy to Firebase through `.github/workflows/ci.yml`. That file also holds the checks that used to live in `deploy.yml`, `funding-escrow.yml`, `gitleaks.yml` and `semgrep.yml`. Shared Node setup is `.github/actions/setup-workspace`. The AI review stays in `.github/workflows/ai-security-review.yml`. The workflow needs the secrets and variables below, set under **Settings**, **Secrets and variables**, **Actions** in the repository.

## Joining the existing project

Ask for maintain or admin access to the repository, then check that the list under **Actions secrets** matches the table below. Existing Firebase credentials can be reused; add `OPENAI_API_KEY` before the first AI drafting deployment. GitHub never shows a secret's value again, so a missing or wrong value has to be replaced, not read.

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
| `OPENAI_API_KEY` | Restricted OpenAI project key | App drafting: backend deploy copies it to Google Secret Manager. Also used by AI security review if that provider is selected |

The `VITE_FIREBASE_*` values are public identifiers. They are kept as secrets so each fork supplies its own.

The `deploy-backend` job in `ci.yml` provisions `OPENAI_API_KEY` in Google Secret Manager after the required **CI** checks pass on `main`. The job uses repository secrets; it does not select a GitHub Environment. A supplied key creates a new secret version, and the temporary key file and Firebase debug logs are removed afterwards. If the repository secret is absent, an existing provisioned Secret Manager key is required. The key never enters the frontend build or the functions `.env` file. See [AI assistance deployment](https://github.com/0xMeePok/smu-qc-dao-project/blob/main/docs/ai-assistance.md#keys-and-deployment) for permissions and limits.

## Variables

| Name | Value | Notes |
| --- | --- | --- |
| `VITE_PRIVY_APP_ID` | Privy App ID | Required. Used for the build and written to the functions environment as `PRIVY_APP_ID`. A secret of the same name also works, and the variable wins |
| `ARBITRUM_SEPOLIA_RPC_URL` | Primary RPC URL | Optional. Defaults to `https://sepolia-rollup.arbitrum.io/rpc`. `VITE_ARBITRUM_SEPOLIA_RPC_URL` is also accepted |
| `ARBITRUM_SEPOLIA_RPC_BACKUP_URLS` | Comma-separated RPC URLs | Optional. Secret or variable. Cloud Functions read it with or without the `VITE_` prefix. The browser build and its CSP read only `VITE_ARBITRUM_SEPOLIA_RPC_BACKUP_URLS`, so use that name if browsers should fail over too |
| `AI_DRAFT_ENABLED` | `true` (default) or `false` | Backend drafting kill switch; manual form entry and similar-proposal retrieval still work |
| `AI_SIMILARITY_ENABLED` | `true` (default) or `false` | Shared backend kill switch for standalone similar-proposal search and generation reference retrieval |
| `AI_DRAFT_MODEL` | `gpt-5-mini` (default) | Backend-only model setting; never a browser parameter |
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

1. Rename the service account secret, or keep the name and only change its value. If you rename it, update both places in `ci.yml` that read it.
2. Change `FIREBASE_PROJECT_ID` at the top of `ci.yml`.
3. Make the other project-specific changes listed in [Firebase](firebase.md), step 7.

## Branch protection

On 26 October 2026, `main` was protected by a classic branch protection rule requiring the **Run Unit & Integration Tests** check. GitBook commits book edits straight to `main`, and those commits can never carry that check, so the rule refuses them. A classic rule cannot exempt an app from required checks. A ruleset can, so move the protection into a ruleset with the GitBook app on its bypass list. The required check is now **CI**. Remove **Run Unit & Integration Tests**, **Semgrep** and **Gitleaks** from the ruleset: they are jobs inside `.github/workflows/ci.yml`, and **CI** fails when one of them fails.

1. Install the GitBook GitHub app on the repository first, as part of the [GitBook](gitbook.md) setup. The app only appears in the bypass list once it is installed.
2. Open **Settings**, **Branches** and note every setting of the classic rule for `main`.
3. Open **Settings**, **Rulesets**, then **New ruleset**, **New branch ruleset**.
4. Name the ruleset `main` and set **Enforcement status** to **Active**.
5. Under **Bypass list**, select **Add bypass**, choose **GitBook** and select **Add Selected**. Leave its mode on **Always allow**.
6. Under **Target branches**, select **Add a target** and include the default branch.
7. Under the rules, keep **Restrict deletions** and **Block force pushes**. Turn on **Require status checks to pass before merging** and add **CI**. Do not also require **Run Unit & Integration Tests**, **Semgrep** or **Gitleaks**. Recreate any other setting the classic rule had.
8. Select **Create**.
9. Go back to **Settings**, **Branches** and delete the classic rule for `main`. Classic rules and rulesets both apply, so the classic rule would keep refusing GitBook's commits.

To check it, edit a page in GitBook and merge the change request. The commit should appear on `main` from the GitBook app. Pushes that only change `gitbook/` do not deploy.

## Check that it works

Open **Actions**, run **CI** by hand with **Run workflow** on `main`, and confirm the selected jobs pass. The last step, **Verify effective production CSP**, reads the live header.
