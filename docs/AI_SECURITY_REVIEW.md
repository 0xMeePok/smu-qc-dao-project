# AI Security Review for Pull Requests

The `AI Security Review` GitHub Actions workflow reviews every non-draft pull request
when it is opened, reopened, marked ready for review, or updated with new commits. It
sends a bounded copy of the GitHub diff to Fireworks AI's GLM-5.3 model and creates
or updates one comment on the pull request with actionable security findings.

## One-time repository setup

In GitHub, open **Settings → Secrets and variables → Actions → Secrets**, create a
repository secret named `FIREWORKS_API_KEY`, and paste a Fireworks API key with only
the inference access needed by this workflow.

No provider or model variable is needed initially. The defaults are:

- Provider: `fireworks`
- Model: `accounts/fireworks/models/glm-5p3`
- Maximum diff sent per review: 180,000 bytes

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
GitHub API and handled only as bounded, untrusted text.

The model has no tools and never receives the GitHub or provider API keys. Model
output is parsed into a fixed finding shape, size-limited, and escaped before it is
included in the PR comment. Treat the result as an additional review signal, not a
replacement for human review or deterministic security tooling.

Because the diff is sent to the configured model provider, do not use this workflow
for repositories whose pull request content is prohibited from being processed by
that provider. A contributor can also create an intentionally large diff; the byte
limit controls spend and the resulting comment records when truncation occurred.

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
`SECURITY_REVIEW_MODEL` variable to restore the GLM-5.3 default.

## Optional cost control

Set the Actions repository variable `SECURITY_REVIEW_MAX_DIFF_BYTES` to a value from
10,000 through 500,000 to change the amount of diff text sent to the provider. The
default 180,000-byte cap is enforced while the HTTP response is streamed, so an
oversized diff is never fully buffered by the reviewer.
