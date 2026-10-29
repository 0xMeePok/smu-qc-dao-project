# AI-assisted drafting and similar proposals (QCDAO-157)

The author opens **Draft with AI** beside the form title. Desktop uses a side panel;
mobile uses a full-screen panel. Generation from a title and a short conversation
share the same field-suggestion flow. This is a form-drafting assistant, not an
agent that can publish, transfer funds, browse the web, or execute tools.

## Author control

The problem, open-funding, attached-proposal, and independent-proposal forms use
`firebase/functions/aiDraftSchema.js` as their browser-safe field contract.
Already completed fields are context. Suggestions may only fill an empty field
unless the author explicitly regenerates that AI suggestion. The client checks
again when applying a response, so text entered while a request is pending wins.
The panel supports accept, regenerate, and clear per field, plus accept all and
discard all. Editing a generated field removes its untouched-AI marking.

The author must supply funding amounts, currency, expiry, payment terms, and team
credentials. AI can suggest qualitative delivery phases but cannot invent committed
dates, quantities, benchmark results, proprietary datasets, partners, or experience.
Category values and suggested tags are restricted to the existing taxonomies.
Open-funding tags continue to be derived from accepted technology areas by the
existing form logic; AI does not create a parallel tag vocabulary.

Accepted assistance sets the optional boolean `aiAssisted: true` on a record when
that record is normally saved or published. Detail pages show **AI-assisted draft**.
The indicator is self-reported authoring metadata, not evidence that the AI output
was correct or that an evaluator endorsed it. It is intentionally excluded from
existing canonical audit payloads; no contract, historical hash, or payment changes.
Conversation and unaccepted suggestions are not written into posting/proposal
records. Existing records without the flag work unchanged.

## Similar proposals and retrieval-augmented drafting

`firebase/functions/aiRetrieval.js` retrieves existing proposals before generation,
and also supplies a separate key-free similar-proposal lookup while the author
works. Permission checks run before ranking, displaying, or sending reference
snippets to OpenAI. Drafts, hidden/removed proposals, and proposals with an
unavailable parent are excluded. Retrieval does not expose private record ids,
existence counts, or unapproved snippets.

The first implementation uses lexical BM25-style TF-IDF scoring, common domain
synonyms, and UK/US spelling/inflection normalization. It does not require a paid
embedding call or an external vector store. Candidate reads are bounded: up to
150 recent proposals, 60 in the selected category, and 60 for the same parent
posting; records are deduplicated before ranking. At most four matches return,
with a bounded title, 360-character summary excerpt, route, and an explanation
based on related terms. Parent access checks use batches of six and no
cross-request permission cache.

This is advisory retrieval, not an exhaustive duplicate detector or a plagiarism
verdict. The response marks the bounded search `truncated: true` independently of
private candidate counts, so the UI explains that results cover recent/related
candidates. A missing match is not proof that no similar proposal exists. Readable
references guide differentiation; generation is instructed not to copy them.

## Provider and response contract

Generation is a Firebase callable in `asia-southeast1`, using OpenAI's Responses
API with `store: false`, no tools, and strict JSON Schema output. The server
validates the parsed response again, including the requested field set, field
lengths, category enums, and tag labels. Refusals, incomplete output, malformed
JSON, unexpected fields, errors, and timeouts return a recoverable error; they do
not replace any form text.

The provider response has exactly these three top-level keys:

```json
{
  "message": "Review these suggestions and confirm any unknown facts.",
  "suggestions": {
    "summary": "Proposed research summary.",
    "category": "hybrid"
  },
  "suggestedTags": ["Hybrid quantum / classical"]
}
```

The `suggestions` object's keys must exactly equal the request's `requestedFields`.
Each requested value is text (maximum 4,000 characters), a configured category,
or at most six configured posting-category values. A provider may return `null`
when a fact cannot be inferred; the server leaves that field out of the usable
suggestions and the panel explains what the author needs to supply. The message
is nonempty and at most 2,000 characters. Suggested tags are unique taxonomy labels,
at most eight. Extra keys, incomplete shapes, and any monetary or expiry field fail
validation.

| Form kind | Generatable fields |
| --- | --- |
| `problem` | `businessContext`, `summary`, `currentApproach`, `currentLimitations`, `expectedOutcome`, `successCriteria`, `dataAvailability`, `categories` |
| `open-funding` | `fundingThesis`, `eligibilityNotes`, `categories` |
| `proposal` | `summary`, `methodology`, `suitability`, `expectedOutcomes`, `successCriteria`, `timeline`, `milestones`, `category`; open-funding proposals also use `proposedProblem`, `relevance`, `thesisFit` |
| `independent` | `summary`, `methodology`, `addressedProblems`, `category` |

The app callable adds permission-filtered `similarProposals` and a
`usage.remainingToday` counter to the validated provider response; those fields
are server-authored, not accepted from the model. No OpenAI response id, token,
key, headers, or raw upstream failure body is returned to the browser.

The prompt is `AI_DRAFT_INSTRUCTIONS` in `firebase/functions/aiDrafting.js`, version
`qcdao-draft-v1`. The default model is `gpt-5-mini`; the server allows the documented
`gpt-5-mini` model and its pinned `gpt-5-mini-2025-08-07` snapshot. Model choice is
server configuration, never a request parameter. Review prompt/schema and test
fixtures together when changing either. Prompt context treats all form, chat,
parent-posting, and retrieved text as untrusted source material.

`store: false` disables Responses application-state storage; it does not promise
zero retention of provider abuse-monitoring logs. Tell authors that their title,
selected form context, chat, authorized parent posting, and retrieved reference
snippets are sent to OpenAI when they request AI drafting. Do not log that text or
provider response bodies. The caller's account id is hashed for `safety_identifier`.

Official references:

- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [GPT-5 mini](https://developers.openai.com/api/docs/models/gpt-5-mini)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
- [API key management](https://developers.openai.com/api/docs/guides/production-best-practices)

## Abuse and cost limits

All app callables require a signed-in active member and App Check outside the
emulator. The server validates input before calling a provider. AI generation
reserves a Firestore quota transaction before starting external work:

| Limit | Enforcement |
| --- | --- |
| Member generation requests | 3 in a rolling minute; 20 per UTC day |
| Platform generation requests | 200 per UTC day |
| Concurrent generation | One in-flight lease per member; bounded recovery after a crashed request |
| Input | At most eight messages, 3,000 characters per message, and 24,000 total request characters |
| Provider output | At most 3,000 output tokens and a bounded HTTP response |
| Provider time | 25 seconds; no automatic retries |
| Similar-proposal lookups | Separate server quota: 10 per minute and 100 per member per UTC day; 2,000 per UTC day platform-wide; one in-flight search with a 60-second recovery lease (longer than the 40-second callable timeout) |

Regeneration and failed provider calls count towards generation usage. A repeated
request id is rejected rather than billed again. The Firestore `aiUsage` and
`aiRequests` collections hold only quota/idempotency metadata, not chat or generated
content, and are inaccessible to clients. Quota records have `expiresAt` fields;
the checked-in Firestore TTL overrides clean those two collection groups after
the seven-day metadata window. Deploy the updated indexes to activate cleanup. TTL is cleanup, not an authorization boundary. Setting
`AI_DRAFT_ENABLED=false` disables generation immediately after redeploy; form
editing and key-free similar-proposal retrieval remain available. Setting
`AI_SIMILARITY_ENABLED=false` disables both standalone similar-proposal lookups
and retrieval used to ground generation after redeploy. Drafting can continue
without reference snippets, with a retrieval-unavailable notice.

## Keys and deployment

Add a restricted OpenAI project key as the GitHub **repository Actions secret**
`OPENAI_API_KEY`. Do not use a `VITE_` prefix, commit a key, or paste it into chat.
The `deploy-backend` job in `.github/workflows/ci.yml` does not select a GitHub
Environment; Environment-only
secrets will not be visible unless the deployment job is explicitly configured
for that environment.

After the required CI checks pass on `main`, the backend deployment step copies
the secret into Google Secret Manager under
`OPENAI_API_KEY` through a restricted temporary file and removes that file and
Firebase CLI debug logs afterwards (including on failure), because HTTP debug logs
may include encoded request payloads.
A supplied GitHub key creates a new secret version on deployment; the workflow
deliberately never reads a secret value back for comparison, because the Firebase
CLI can log returned values. A pre-provisioned key is checked through metadata only. It does not write the key into `functions/.env` or
frontend build variables. The function binds that runtime secret with `defineSecret`.
The first deployment must have the GitHub secret or an existing provisioned Secret
Manager value; otherwise it stops with an actionable error. A missing key never
becomes a fake or empty production key.

The deploy service account needs Secret Manager access sufficient to create/update
this secret, inspect its metadata, and grant the callable's
runtime identity secret access. Follow the project's existing restricted deployment
IAM pattern; do not grant the browser or end users secret access. Firebase Functions
normally grants the bound runtime secret permission during deployment.

Repository variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_DRAFT_ENABLED` | `true` in deployment; opt-in locally | Generation kill switch |
| `AI_SIMILARITY_ENABLED` | `true` in deployment | Shared similarity/RAG retrieval kill switch |
| `AI_DRAFT_MODEL` | `gpt-5-mini` | Supported server-selected model |

Keep a separate restricted key/project for production if PR security review also
uses `OPENAI_API_KEY`; sharing a key makes costs and permissions harder to isolate.
Set project spend/rate limits and alerts as an additional provider-side control.
App quotas remain necessary because provider controls do not enforce per-member use.

## Local testing

Use the normal Firebase emulators and an ignored `firebase/functions/.secret.local`
file containing `OPENAI_API_KEY` for live generation. Set `AI_DRAFT_ENABLED=true` in
the local functions environment. Local secrets do not belong in GitHub or frontend
`.env` files. A GitHub Actions secret becomes available to CI, not automatically to
a running local process.

A key-free local preview may exercise the UI using clearly labelled sample AI
responses. Such a preview is not evidence of a live OpenAI call. Backend tests use
mocked provider responses to test failure, refusal, malformed output, quotas, and
concurrency without spending credits. Similar-proposal retrieval uses the local
Firestore collection and does not require an OpenAI key.
