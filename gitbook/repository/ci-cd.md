# CI/CD and quality checks

Six GitHub Actions workflows live in `.github/workflows/`. Pull requests are tested and scanned. Pushes to `main` are tested again and deployed.

## Workflows

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `ci.yml` (CI Test Suite) | Pull requests and pushes to `main` | Detects which areas changed, then runs only those jobs: frontend tests and build, Firestore and Storage rules tests, Cloud Functions tests, audit registry contract tests, faucet and EIP-7702 tests. A final `CI` job passes when no selected job failed, so a skipped job never blocks a merge |
| `deploy.yml` (Deploy) | Pushes to `main`, except pushes that only change `gitbook/**`, and manual runs | Tests backend, rules and frontend, deploys rules, indexes, Storage rules and functions, then builds and deploys Hosting and checks the live CSP. See [Deployment](../operations/deployment.md) |
| `funding-escrow.yml` | Pull requests and pushes to `main` that touch the escrow contracts or their ABI bundle | Escrow contract tests with coverage, a production compile and the deployment verifier tests |
| `semgrep.yml` | Pull requests and pushes to `main` | Semgrep Community Edition with JavaScript, TypeScript, React, Node, smart contract and OWASP rules. Seven Solidity gas rules are advisory. Everything else blocks |
| `gitleaks.yml` | Every push | Scans new commits for secrets with Gitleaks 8.30.1, using `.gitleaks.toml` and `.gitleaksignore` |
| `ai-security-review.yml` | Pull requests opened or updated by the four project contributors | Sends the diff in 75,000-byte chunks (at most 20) to Fireworks AI and posts one advisory comment with security findings |

The deploy workflow cannot be blocked by `ci.yml`, because they are separate workflows. That is why `deploy.yml` runs the backend, rules and frontend suites again before it deploys anything.

## Required checks

On 26 October 2026, `main` required only the **Run Unit & Integration Tests** check, through a classic branch protection rule. That rule is to move into a ruleset with the GitBook app on its bypass list, as described in [Branch protection](../setup/github-actions.md#branch-protection). `docs/contributing.md` also asks maintainers to require **CI**, **Semgrep** and **Gitleaks**. Check the protection settings in GitHub when you take over the repository.

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
* Never commit directly to `main`, because every push to `main` deploys.

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
