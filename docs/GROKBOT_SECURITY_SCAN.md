# GrokBot Security Scan for Commits

The `GrokBot Security Scan` GitHub Actions workflow scans **every push to any
branch** and posts an advisory security review as a **commit comment** on the
pushed head commit. It is meant to give contributors early, per-commit feedback
so issues can be remediated *before* opening a pull request.

It complements — and does not replace — the pull-request
[`AI Security Review`](AI_SECURITY_REVIEW.md). The two workflows share the same
review engine (`.github/scripts/security-review.mjs`) but comment in different
places using different markers, so their comments never collide:

| Workflow | Trigger | Comments on | Default provider |
|---|---|---|---|
| AI Security Review | non-draft pull requests | the pull request | Fireworks AI (GLM-5.3) |
| GrokBot Security Scan | push to any branch | the head commit | xAI Grok |

## What it does

1. On a push, it resolves the diff introduced by the pushed commits:
   - a normal push compares the previous branch tip (`before`) to the new tip;
   - a brand-new branch is compared against the repository's default branch;
   - any remaining edge case falls back to the head commit's own diff.
2. The bounded diff is sent to xAI Grok, chunk by chunk, and parsed into a fixed,
   size-limited finding shape.
3. A single commit comment is created (or updated on a re-run of the same commit)
   with the findings. Findings are advisory: the workflow reports them but does
   not fail the job merely because findings exist. API, configuration, parsing,
   and GitHub comment failures do fail the job and leave a safe failure comment.

Because it runs on every branch push, the scan is gated to the current project
contributors (by `github.actor`) to keep paid model usage bounded, exactly like
the pull-request reviewer.

## One-time repository setup

In GitHub, open **Settings → Secrets and variables → Actions → Secrets**, create a
repository secret named `XAI_API_KEY`, and paste an xAI API key with only the
inference access this workflow needs.

Defaults, with no variables set:

- Provider: `grok` (xAI)
- Model: `grok-4-fast-reasoning`
- Endpoint: `https://api.x.ai/v1/chat/completions`
- Diff sent per model request: 75,000 UTF-8 bytes (max 100,000)

The workflow needs `contents: write` permission so it can post commit comments;
that is declared in the workflow and requires no extra configuration. The first
scan runs the next time a listed contributor pushes to any branch after this
workflow reaches the default branch.

## Security boundaries

The scan runs on the `push` event, which already runs in the repository's trusted
context, so — unlike the pull-request reviewer — no `pull_request_target` handling
is required. The checked-out scanner code is trusted; the pushed diff is fetched
through the GitHub API and handled only as bounded, untrusted text. The model has
no tools and never receives the GitHub or provider API keys. Model output is
parsed into a fixed shape, size-limited, and escaped (mentions and markdown are
neutralised) before it is included in the commit comment. Provider error details
are never published in the failure comment.

Because the diff is sent to the configured model provider, do not enable this
workflow for repositories whose commit content is prohibited from being processed
by that provider.

## Optional configuration

All variables are set under **Settings → Secrets and variables → Actions →
Variables** unless noted otherwise.

| Variable | Purpose |
|---|---|
| `GROKBOT_MODEL` | Override the Grok model (for example a newer `grok-4.x`). |
| `GROKBOT_REASONING_EFFORT` | Forwarded as `reasoning_effort` only when set (Grok 4 reasoning models reject it; `grok-3-mini` accepts `low`/`high`). |
| `GROKBOT_PROVIDER` | Point the commit scan at a different provider (`fireworks` or `openai`) reusing the shared engine. Set the matching secret (`FIREWORKS_API_KEY` / `OPENAI_API_KEY`) and, for those providers, `GROKBOT_MODEL`. |
| `SECURITY_REVIEW_CHUNK_BYTES` | Diff bytes per model request (10,000–100,000; default 75,000). |
| `SECURITY_REVIEW_MAX_CHUNKS` | Maximum model requests before the scan fails rather than returning a partial result (default 20). |
| `SECURITY_REVIEW_PROVIDER_TIMEOUT_MS` | Per-request timeout in ms (60,000–900,000; default 600,000). |

## Local testing

Both scripts are covered by Node's built-in test runner and run without network
access (the end-to-end test mocks the GitHub REST API and the xAI endpoint):

```bash
node --test .github/scripts/security-review.test.mjs
node --test .github/scripts/grokbot-scan.test.mjs
```
