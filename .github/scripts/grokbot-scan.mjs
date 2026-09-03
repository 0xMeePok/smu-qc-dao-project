import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  GROK_MODEL,
  assertReviewChunkLimit,
  buildReviewPrompt,
  checkedFetch,
  chunkPullRequestDiff,
  githubHeaders,
  mergeChunkReviews,
  normalizeReview,
  parseReview,
  renderFailureComment,
  renderReviewComment,
  requestReview,
  resolveProviderConfig,
  DEFAULT_DIFF_CHUNK_BYTES,
  MAX_DIFF_CHUNK_BYTES,
  DEFAULT_MAX_REVIEW_CHUNKS,
  MAX_REVIEW_CHUNKS,
} from "./security-review.mjs";

// A distinct marker so the commit-scan comment is never confused with the
// pull-request review comment, letting each be upserted independently.
export const GROKBOT_COMMENT_MARKER = "<!-- qcdao-grokbot-security-scan -->";
export const GROKBOT_COMMENT_HEADING = "GrokBot security scan";
const COMMENT_OPTIONS = {
  marker: GROKBOT_COMMENT_MARKER,
  heading: GROKBOT_COMMENT_HEADING,
};

const NULL_SHA = /^0+$/;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// GrokBot defaults to xAI but still honours the shared provider variables so a
// maintainer can point the commit scan at Fireworks or OpenAI without new code.
export function resolveScanProviderConfig(env = process.env) {
  return resolveProviderConfig({
    ...env,
    SECURITY_REVIEW_PROVIDER: env.GROKBOT_PROVIDER || env.SECURITY_REVIEW_PROVIDER || "grok",
    SECURITY_REVIEW_MODEL: env.GROKBOT_MODEL || env.SECURITY_REVIEW_MODEL,
  });
}

export async function loadPushContext(env = process.env) {
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN) {
    throw new Error("GITHUB_EVENT_PATH, GITHUB_REPOSITORY, and GITHUB_TOKEN are required");
  }

  const event = JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const afterSha = event.after;
  if (typeof afterSha !== "string" || !afterSha) {
    throw new Error("This scanner must run for a push event");
  }

  return {
    apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, ""),
    repository: env.GITHUB_REPOSITORY,
    ref: event.ref || "",
    beforeSha: typeof event.before === "string" ? event.before : "",
    afterSha,
    deleted: event.deleted === true || NULL_SHA.test(afterSha),
    defaultBranch: event.repository?.default_branch || "",
    githubToken: env.GITHUB_TOKEN,
    diffChunkBytes: boundedInteger(
      env.SECURITY_REVIEW_CHUNK_BYTES || env.SECURITY_REVIEW_MAX_DIFF_BYTES,
      DEFAULT_DIFF_CHUNK_BYTES,
      10_000,
      MAX_DIFF_CHUNK_BYTES,
    ),
    maxReviewChunks: boundedInteger(
      env.SECURITY_REVIEW_MAX_CHUNKS,
      DEFAULT_MAX_REVIEW_CHUNKS,
      1,
      MAX_REVIEW_CHUNKS,
    ),
  };
}

async function fetchDiffText(context, path, label) {
  const response = await checkedFetch(
    `${context.apiUrl}${path}`,
    { headers: githubHeaders(context.githubToken, "application/vnd.github.diff") },
    label,
  );
  const text = await response.text();
  return { text, bytes: Buffer.byteLength(text, "utf8") };
}

// Resolve the diff introduced by the pushed commits. A normal push compares the
// previous branch tip (`before`) to the new tip; a brand-new branch has a null
// `before`, so it is compared against the default branch, and any remaining edge
// case falls back to the head commit's own diff.
export async function fetchPushDiff(context) {
  const base = !context.beforeSha || NULL_SHA.test(context.beforeSha)
    ? context.defaultBranch
    : context.beforeSha;

  if (base && base !== context.afterSha) {
    try {
      const diff = await fetchDiffText(
        context,
        `/repos/${context.repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(context.afterSha)}`,
        "Comparing the pushed commits",
      );
      if (diff.text.trim()) return diff;
    } catch (error) {
      console.warn(`Falling back to the head commit diff: ${error.message}`);
    }
  }

  return fetchDiffText(
    context,
    `/repos/${context.repository}/commits/${encodeURIComponent(context.afterSha)}`,
    "Fetching the head commit diff",
  );
}

async function githubJson(context, path, options = {}) {
  const response = await checkedFetch(
    `${context.apiUrl}${path}`,
    {
      ...options,
      headers: {
        ...githubHeaders(context.githubToken),
        ...(options.headers || {}),
      },
    },
    `GitHub API ${options.method || "GET"} ${path}`,
  );
  if (response.status === 204) return null;
  return response.json();
}

// One comment per scanned commit: update the existing GrokBot comment on a
// re-run of the same commit instead of stacking duplicates.
export async function upsertCommitComment(context, body) {
  let existing;
  for (let page = 1; page <= 10 && !existing; page += 1) {
    const comments = await githubJson(
      context,
      `/repos/${context.repository}/commits/${encodeURIComponent(context.afterSha)}/comments?per_page=100&page=${page}`,
    );
    existing = comments.find(
      (comment) => comment?.user?.type === "Bot" && comment?.body?.includes(GROKBOT_COMMENT_MARKER),
    );
    if (comments.length < 100) break;
  }

  if (existing) {
    await githubJson(context, `/repos/${context.repository}/comments/${existing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    return;
  }

  await githubJson(context, `/repos/${context.repository}/commits/${encodeURIComponent(context.afterSha)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

export async function runGrokbotScan(env = process.env) {
  const context = await loadPushContext(env);

  if (context.deleted) {
    console.log("Push deleted the ref or has no head commit; nothing to scan.");
    return;
  }

  let config;
  try {
    config = resolveScanProviderConfig(env);
    const diffResult = await fetchPushDiff(context);
    if (!diffResult.text.trim()) {
      console.log("The pushed commits contain no reviewable diff; skipping the scan.");
      return;
    }

    const chunks = chunkPullRequestDiff(diffResult.text, context.diffChunkBytes);
    assertReviewChunkLimit(chunks.length, context.maxReviewChunks);
    const chunkReviews = [];
    for (const [index, chunk] of chunks.entries()) {
      console.log(
        `Scanning diff chunk ${index + 1}/${chunks.length} (${Buffer.byteLength(chunk, "utf8").toLocaleString("en-US")} bytes).`,
      );
      const prompt = buildReviewPrompt(chunk, {
        chunkNumber: index + 1,
        chunkCount: chunks.length,
      });
      const content = await requestReview(config, prompt);
      chunkReviews.push(normalizeReview(parseReview(content)));
    }

    const review = mergeChunkReviews(chunkReviews, { diffLabel: "pushed changes" });
    const metadata = {
      ...context,
      ...config,
      headSha: context.afterSha,
      diffBytes: diffResult.bytes,
      chunkCount: chunks.length,
    };

    await upsertCommitComment(context, renderReviewComment(review, metadata, COMMENT_OPTIONS));
    console.log(`GrokBot security scan completed with ${review.findings.length} finding(s).`);
  } catch (error) {
    const metadata = {
      headSha: context.afterSha,
      provider: config?.provider || "grok",
      model: config?.model || GROK_MODEL,
    };
    try {
      await upsertCommitComment(context, renderFailureComment(error, metadata, COMMENT_OPTIONS));
    } catch (commentError) {
      console.error(`Unable to update the commit comment: ${commentError.message}`);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGrokbotScan().catch((error) => {
    console.error(`GrokBot security scan failed: ${error.message}`);
    process.exitCode = 1;
  });
}
