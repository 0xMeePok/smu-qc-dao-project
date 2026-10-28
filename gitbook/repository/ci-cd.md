# CI/CD and quality checks

Checks and deployment live in `.github/workflows/ci.yml`. Pull requests run the areas they touch. A push to `main` runs those same checks and then deploys. The AI security review stays in `.github/workflows/ai-security-review.yml` because it has to comment on a pull request without executing that pull request's code.

## Files

```
.github/
├── workflows/
│   ├── ci.yml                     Checks and the Firebase deploy
│   └── ai-security-review.yml     Advisory review, kept separate
├── actions/setup-workspace/
│   └── action.yml                 Node 22, and Java 17 when a job starts emulators
└── scripts/
    ├── security-review.mjs
    └── security-review.test.mjs
```

`deploy.yml`, `funding-escrow.yml`, `gitleaks.yml` and `semgrep.yml` are gone. Their work is a job in `ci.yml`:

| Removed file | Job in `ci.yml` |
| --- | --- |
| `deploy.yml` | **Deploy rules and functions** and **Deploy hosting** |
| `funding-escrow.yml` | **Funding escrow** |
| `gitleaks.yml` | **Gitleaks** |
| `semgrep.yml` | **Semgrep** |

The old `ci.yml` was the workflow **CI Test Suite**. Its gate job was **Run Unit & Integration Tests**. That job is now named **CI**.

Jobs that use the shared action check out the repository first. GitHub loads `action.yml` from the runner's copy of the repository, so the action itself does not check the repository out.

## How to read a run

Open the failed **CI** run. The red job's name is the area: **Frontend**, **Firestore rules**, **Cloud Functions**, **Audit registry**, **Funding escrow**, **Faucet**, **Semgrep** or **Gitleaks**. **CI** itself only fails when a selected area failed, or when the change detection failed. **Deploy rules and functions** and **Deploy hosting** run after **CI** on `main`, and only when the push changes something outside `gitbook/`.

A pull request lists each job twice. The same commit starts `ci.yml` for the branch push and again for the pull request, and GitHub shows both.

* The push run scans for secrets. On a feature branch it skips the test jobs and both deploy jobs.
* The pull request run executes the selected tests and Semgrep. It skips **Gitleaks**, which runs only on a push, and both deploy jobs, which run only on `main`.

A skipped job was not selected for that event. It is not a failure. The two **GitBook** lines are statuses from the GitBook app, not jobs in this repository.

## What runs

| Job | Runs when | What it checks |
| --- | --- | --- |
| Detect changed areas | Every pull request, push and manual run | Path filters. A manual run selects every area |
| Frontend | `frontend/**` or a shared functions module the app imports | Unit, integration and accessibility tests, then a production build |
| Firestore rules | `firebase/**` outside `firebase/functions/**` | Firestore and Storage rules |
| Cloud Functions | `firebase/functions/**` or `firebase/firebase.json` | Functions suite |
| Audit registry | `contracts/audit-registry/**` | Registry contract tests |
| Funding escrow | Escrow contracts, registry contracts or `escrowRegistry.abis.json` | Coverage, a production compile and the deployment verifier |
| Faucet | `contracts/stable-faucet/**` | Faucet contracts and the sponsored-wallet site tests |
| Semgrep | Frontend, Firebase, contracts or `.github/**`, on a pull request or on `main` | Community Edition rules for JavaScript, TypeScript, React, Node, smart contracts and OWASP. Seven Solidity gas rules are advisory. Everything else blocks |
| Gitleaks | Every push, whatever the paths | New commits, with Gitleaks 8.30.1, `.gitleaks.toml` and `.gitleaksignore` |
| CI | Always | Passes when no selected job failed. This is the required status check |
| Deploy rules and functions | Push to `main` that is not only `gitbook/**`, after **CI** | Firestore rules, indexes, Storage rules, then functions. Functions retry up to three times |
| Deploy hosting | After the backend deploy | Builds the web app and checks the live Content-Security-Policy |

Changing `.github/workflows/ci.yml` or `.github/actions/**` selects every test area, so a bad filter is caught by the next run. Node and Java setup is shared through `.github/actions/setup-workspace`, and npm installs use the lockfile cache.

A push that only changes `gitbook/**` still scans for secrets, and it does not deploy. Run **CI** by hand from **Actions**, **Run workflow**, on `main`, to redeploy the current `main`.

## Required check

Require **CI** on `main`, and remove **Run Unit & Integration Tests**, **Semgrep** and **Gitleaks** if they are still required. Those checks are jobs inside this workflow now. **CI** fails when Semgrep or Gitleaks fails. A skipped job does not fail **CI**, so a documentation change can merge.

GitBook commits straight to `main` and cannot carry a required check. Keep the GitBook app on the ruleset bypass list, as described in [Branch protection](../setup/github-actions.md#branch-protection).

## AI security review

The reviewer script is `.github/scripts/security-review.mjs`, with its own tests. It only runs for pull requests from `0xMeePok`, `whale93`, `Darveloper1` and `0xjunwei`, to keep paid model use to the team. Add the new team's GitHub logins to the `if:` condition in `ai-security-review.yml`, or the review will skip their pull requests.

| Setting | Kind | Default |
| --- | --- | --- |
| `FIREWORKS_API_KEY` | Secret | Required while the provider is Fireworks |
| `OPENAI_API_KEY` | Secret | Only after switching provider |
| `SECURITY_REVIEW_PROVIDER` | Variable | `fireworks` |
| `SECURITY_REVIEW_MODEL` | Variable | `accounts/fireworks/models/glm-5p3-flash` for Fireworks |
| `SECURITY_REVIEW_CHUNK_BYTES` | Variable | 75,000 (maximum 100,000) |
| `SECURITY_REVIEW_MAX_CHUNKS` | Variable | 20 |
| `SECURITY_REVIEW_PROVIDER_TIMEOUT_MS` | Variable | 600,000 |

Findings are advisory. The job fails only on API, configuration or comment errors. `docs/AI_SECURITY_REVIEW.md` explains the security boundaries and how to switch to OpenAI.

## Branches and pull requests

The team rules are in `docs/contributing.md`:

* Branch from `main` and name the branch `qcdao-<story number>-<story title in kebab case>`.
* Use Conventional Commits style subjects, imperative and at most 50 characters.
* Open one pull request per story, get at least one approval and use **Squash and merge**.
* Never commit directly to `main`, because every push to `main` that changes the product deploys.

## Adding a test

Test commands glob their folders, so a new file is picked up without changing CI:

| Suite | Put new tests in |
| --- | --- |
| Frontend Node tests (`.test.js`) | `frontend/test/`, `test/unit/`, `test/integration/` or `test/a11y/` |
| Frontend component tests (Vitest, `.test.jsx`) | `frontend/test/components/` or `test/a11y/` |
| Rules | `firebase/test/*.test.mjs` |
| Functions | `firebase/functions/test/*.test.mjs` |
| Contracts | `contracts/<package>/test/` |

If you add a new top-level folder that should trigger CI, add it to the path filters in the `changes` job of `ci.yml`.
