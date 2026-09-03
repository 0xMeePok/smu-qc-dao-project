import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GROKBOT_COMMENT_MARKER,
  fetchPushDiff,
  loadPushContext,
  resolveScanProviderConfig,
  runGrokbotScan,
  upsertCommitComment,
} from "./grokbot-scan.mjs";

async function writeEvent(event) {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "grokbot-")), "event.json");
  await fs.writeFile(file, JSON.stringify(event), "utf8");
  return file;
}

const SAMPLE_DIFF = [
  "diff --git a/src/auth.js b/src/auth.js",
  "--- a/src/auth.js",
  "+++ b/src/auth.js",
  "@@ -1,2 +1,3 @@",
  " export function handler(req) {",
  "+  return db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);",
  " }",
  "",
].join("\n");

const SAMPLE_REVIEW = {
  summary: "One injection risk in the pushed change.",
  findings: [
    {
      title: "SQL injection via unsanitised id",
      severity: "high",
      confidence: "high",
      file: "src/auth.js",
      line: 2,
      description: "User-controlled req.params.id is interpolated into a SQL string.",
      impact: "An attacker can read or modify arbitrary rows.",
      recommendation: "Use a parameterised query instead of string interpolation.",
      evidence: "SELECT * FROM users WHERE id = ${req.params.id}",
    },
  ],
};

function grokEventStream(review) {
  const events = [
    { choices: [{ delta: { content: JSON.stringify(review) } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { completion_tokens: 64 } },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

// A single local server that stands in for both the GitHub REST API and the xAI
// chat-completions endpoint, so the scan can run end to end without the network.
function startMockServer({ diff = SAMPLE_DIFF, review = SAMPLE_REVIEW, existingComments = [] } = {}) {
  const calls = { compare: 0, commitDiff: 0, listComments: 0, created: [], patched: [] };
  const comments = [...existingComments];

  const server = http.createServer((req, res) => {
    const readBody = () => new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => resolve(body));
    });

    const url = new URL(req.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/v1/chat/completions" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(grokEventStream(review));
      return;
    }

    if (/\/compare\//.test(pathname) && req.method === "GET") {
      calls.compare += 1;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(diff);
      return;
    }

    if (/\/commits\/[^/]+$/.test(pathname) && req.method === "GET") {
      calls.commitDiff += 1;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(diff);
      return;
    }

    if (/\/commits\/[^/]+\/comments$/.test(pathname) && req.method === "GET") {
      calls.listComments += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(comments));
      return;
    }

    if (/\/commits\/[^/]+\/comments$/.test(pathname) && req.method === "POST") {
      readBody().then((body) => {
        const created = { id: 4321, ...JSON.parse(body) };
        calls.created.push(created);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(created));
      });
      return;
    }

    if (/\/comments\/[^/]+$/.test(pathname) && req.method === "PATCH") {
      readBody().then((body) => {
        calls.patched.push({ pathname, ...JSON.parse(body) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: 1 }));
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: `unexpected ${req.method} ${pathname}` }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, calls, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function baseEnv(port, eventPath) {
  return {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_TOKEN: "gh-token",
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    XAI_API_KEY: "xai-token",
    GROK_API_URL: `http://127.0.0.1:${port}/v1/chat/completions`,
  };
}

test("resolveScanProviderConfig defaults GrokBot to xAI", () => {
  const config = resolveScanProviderConfig({ XAI_API_KEY: "test-key" });
  assert.equal(config.provider, "grok");

  const overridden = resolveScanProviderConfig({
    GROKBOT_PROVIDER: "fireworks",
    FIREWORKS_API_KEY: "fw",
  });
  assert.equal(overridden.provider, "fireworks");
});

test("loadPushContext reads the push event and flags deletions", async () => {
  const eventPath = await writeEvent({
    ref: "refs/heads/feature",
    before: "1111111111111111111111111111111111111111",
    after: "2222222222222222222222222222222222222222",
    deleted: false,
    repository: { default_branch: "main" },
  });
  const context = await loadPushContext({
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_TOKEN: "gh-token",
  });
  assert.equal(context.afterSha, "2222222222222222222222222222222222222222");
  assert.equal(context.deleted, false);
  assert.equal(context.defaultBranch, "main");

  const deletedContext = await loadPushContext({
    GITHUB_EVENT_PATH: await writeEvent({
      ref: "refs/heads/feature",
      after: "0000000000000000000000000000000000000000",
      deleted: true,
    }),
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_TOKEN: "gh-token",
  });
  assert.equal(deletedContext.deleted, true);
});

test("fetchPushDiff compares before...after for an existing branch", async () => {
  const mock = await startMockServer();
  try {
    const context = {
      apiUrl: `http://127.0.0.1:${mock.port}`,
      repository: "owner/repo",
      beforeSha: "1111111111111111111111111111111111111111",
      afterSha: "2222222222222222222222222222222222222222",
      defaultBranch: "main",
      githubToken: "gh-token",
    };
    const diff = await fetchPushDiff(context);
    assert.match(diff.text, /SELECT \* FROM users/);
    assert.equal(mock.calls.compare, 1);
    assert.equal(mock.calls.commitDiff, 0);
  } finally {
    await mock.close();
  }
});

test("fetchPushDiff falls back to the head commit for a new branch tip", async () => {
  const mock = await startMockServer();
  try {
    // A brand-new branch whose head equals the default branch tip cannot be
    // compared against itself, so the scan uses the commit's own diff.
    const context = {
      apiUrl: `http://127.0.0.1:${mock.port}`,
      repository: "owner/repo",
      beforeSha: "0000000000000000000000000000000000000000",
      afterSha: "main",
      defaultBranch: "main",
      githubToken: "gh-token",
    };
    const diff = await fetchPushDiff(context);
    assert.match(diff.text, /SELECT \* FROM users/);
    assert.equal(mock.calls.compare, 0);
    assert.equal(mock.calls.commitDiff, 1);
  } finally {
    await mock.close();
  }
});

test("upsertCommitComment creates a new comment when none exists", async () => {
  const mock = await startMockServer();
  try {
    const context = {
      apiUrl: `http://127.0.0.1:${mock.port}`,
      repository: "owner/repo",
      afterSha: "2222222222222222222222222222222222222222",
      githubToken: "gh-token",
    };
    await upsertCommitComment(context, `${GROKBOT_COMMENT_MARKER}\nhello`);
    assert.equal(mock.calls.created.length, 1);
    assert.equal(mock.calls.patched.length, 0);
    assert.match(mock.calls.created[0].body, /hello/);
  } finally {
    await mock.close();
  }
});

test("upsertCommitComment updates the existing GrokBot comment on a re-run", async () => {
  const mock = await startMockServer({
    existingComments: [
      { id: 77, user: { type: "Bot" }, body: `${GROKBOT_COMMENT_MARKER}\nold` },
    ],
  });
  try {
    const context = {
      apiUrl: `http://127.0.0.1:${mock.port}`,
      repository: "owner/repo",
      afterSha: "2222222222222222222222222222222222222222",
      githubToken: "gh-token",
    };
    await upsertCommitComment(context, `${GROKBOT_COMMENT_MARKER}\nnew`);
    assert.equal(mock.calls.created.length, 0);
    assert.equal(mock.calls.patched.length, 1);
    assert.match(mock.calls.patched[0].pathname, /\/comments\/77$/);
    assert.match(mock.calls.patched[0].body, /new/);
  } finally {
    await mock.close();
  }
});

test("runGrokbotScan posts Grok findings as a commit comment end to end", async () => {
  const mock = await startMockServer();
  try {
    const eventPath = await writeEvent({
      ref: "refs/heads/feature",
      before: "1111111111111111111111111111111111111111",
      after: "2222222222222222222222222222222222222222",
      deleted: false,
      repository: { default_branch: "main" },
    });
    await runGrokbotScan(baseEnv(mock.port, eventPath));

    assert.equal(mock.calls.created.length, 1);
    const body = mock.calls.created[0].body;
    assert.ok(body.startsWith(GROKBOT_COMMENT_MARKER));
    assert.match(body, /## GrokBot security scan/);
    assert.match(body, /SQL injection via unsanitised id/);
    assert.match(body, /xAI Grok/);
    assert.match(body, /Reviewed commit `222222222222`/);
  } finally {
    await mock.close();
  }
});

test("runGrokbotScan skips deleted-branch pushes", async () => {
  const mock = await startMockServer();
  try {
    const eventPath = await writeEvent({
      ref: "refs/heads/feature",
      before: "1111111111111111111111111111111111111111",
      after: "0000000000000000000000000000000000000000",
      deleted: true,
      repository: { default_branch: "main" },
    });
    await runGrokbotScan(baseEnv(mock.port, eventPath));
    assert.equal(mock.calls.created.length, 0);
    assert.equal(mock.calls.compare, 0);
  } finally {
    await mock.close();
  }
});

test("runGrokbotScan posts a safe failure comment when the provider errors", async () => {
  // No XAI_API_KEY makes provider resolution fail; the scan must still leave a
  // maintainer-facing comment rather than failing silently.
  const mock = await startMockServer();
  try {
    const eventPath = await writeEvent({
      ref: "refs/heads/feature",
      before: "1111111111111111111111111111111111111111",
      after: "2222222222222222222222222222222222222222",
      deleted: false,
      repository: { default_branch: "main" },
    });
    const env = baseEnv(mock.port, eventPath);
    delete env.XAI_API_KEY;

    await assert.rejects(runGrokbotScan(env), /XAI_API_KEY is not configured/);
    assert.equal(mock.calls.created.length, 1);
    assert.match(mock.calls.created[0].body, /could not complete/);
    assert.doesNotMatch(mock.calls.created[0].body, /XAI_API_KEY/);
  } finally {
    await mock.close();
  }
});
