# AI Security Review for Pull Requests

The `AI Security Review` GitHub Actions workflow reviews non-draft pull requests
when they are opened, reopened, marked ready for review, or updated with new commits.
It splits the GitHub diff into chunks, sends each chunk to Fireworks AI's
`glm-5p3-flash` model, and creates or updates one comment on the pull request with
actionable security findings.

Checked against `main` at `7d3907b` on 25 October 2026. The workflow is
`.github/workflows/ai-security-review.yml` and the reviewer is
`.github/scripts/security-review.mjs`.

## Who it runs for

To keep paid model usage limited, the job runs only for pull requests opened by
these GitHub logins: `0xMeePok`, `whale93`, `Darveloper1` and `0xjunwei`. Pull
requests from anyone else skip the review. A new team should edit the `if:` list in
the workflow to add their own logins.

## One-time repository setup

In GitHub, open **Settings → Secrets and variables → Actions → Secrets**, create a
repository secret named `FIREWORKS_API_KEY`, and paste a Fireworks API key with only
the inference access needed by this workflow.

No provider or model variable is needed initially. The defaults are:

- Provider: `fireworks`
- Model: `accounts/fireworks/models/glm-5p3-flash`, with low reasoning effort
- Diff sent per request: 75,000 bytes
- Requests per review: at most 20
- Provider request timeout: 600,000 ms (10 minutes). A timed-out request is not
  retried, because the provider may still bill it
- Job timeout: 30 minutes

The first run can be started by opening or updating a pull request after this
workflow is present on the default branch. Findings are advisory: the workflow
reports them in its PR comment but does not fail the job merely because findings
exist. API, configuration, parsing, and GitHub comment failures do fail the job.

## Security boundaries

The workflow uses `pull_request_target` so a repository secret can be used and the
bot can comment on pull requests from forks. This event is privileged, so the
workflow deliberately loads the reviewer only from the repository's trusted default
branch. It never checks out, imports, installs dependencies from, builds, tests, or
executes the pull request branch. The contributor's diff is fetched through the
GitHub API and handled only as untrusted text.

The model has no tools and never receives the GitHub or provider API keys. Model
output is parsed into a fixed finding shape, size-limited, and escaped before it is
included in the PR comment. Treat the result as an additional review signal, not a
replacement for human review or deterministic security tooling.

Because the diff is sent to the configured model provider, do not use this workflow
for repositories whose pull request content is prohibited from being processed by
that provider. A large diff is reviewed in several chunks. If it needs more chunks
than the limit allows, the job fails and says so rather than posting a partial
review. Split the pull request or raise the limit.

## Switching to OpenAI later

When the Fireworks credit is exhausted:

1. Add an Actions repository secret named `OPENAI_API_KEY`.
2. Add an Actions repository variable named `SECURITY_REVIEW_PROVIDER` with the
   value `openai`.
3. Add an Actions repository variable named `SECURITY_REVIEW_MODEL` with the exact
   OpenAI model ID selected at migration time.
4. Re-run the failed workflow or push a commit to the pull request.
5. After a successful OpenAI-backed review, delete `FIREWORKS_API_KEY` if it is no
   longer needed.

OpenAI reviews use the Responses API with storage disabled. The OpenAI model is
intentionally not hard-coded: choosing it at migration time avoids silently relying
on a stale model recommendation.

To switch back, set `SECURITY_REVIEW_PROVIDER` to `fireworks` and delete the
`SECURITY_REVIEW_MODEL` variable to restore the `glm-5p3-flash` default.

## Optional cost control

Set these Actions repository variables to change the defaults:

| Variable | Default | Allowed range |
| --- | --- | --- |
| `SECURITY_REVIEW_CHUNK_BYTES` | 75,000 | 10,000 to 100,000 bytes of diff per request |
| `SECURITY_REVIEW_MAX_CHUNKS` | 20 | 1 to 100 requests per review |
| `SECURITY_REVIEW_PROVIDER_TIMEOUT_MS` | 600,000 | 60,000 to 900,000 ms per request |

`SECURITY_REVIEW_MAX_DIFF_BYTES` is still read as a fallback for the chunk size, for
repositories that set it before chunking existed. Values outside a range are clamped
to the nearest limit.
