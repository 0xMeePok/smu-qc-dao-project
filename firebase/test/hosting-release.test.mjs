import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import superstatic from "superstatic";

test("Hosting revalidates app pages and never rewrites removed JavaScript to HTML", async () => {
  const config = JSON.parse(await readFile(new URL("../firebase.json", import.meta.url), "utf8"));
  const root = await mkdtemp(join(tmpdir(), "qc-hosting-release-"));
  let server;
  try {
    await mkdir(join(root, "public/assets"), { recursive: true });
    const html = '<main>Current release</main><script src="/assets/current.js"></script>';
    await writeFile(join(root, "public/index.html"), html);
    await writeFile(join(root, "public/assets/current.js"), "window.currentRelease = true;");
    const middleware = superstatic.default({ cwd: root, config: config.hosting, fallthrough: false });
    server = createServer((request, response) => middleware(request, response, (error) => {
      response.statusCode = error ? 500 : 404;
      response.end(error?.message ?? "Not found");
    }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const path of ["/", "/index.html", "/posting/example", "/?new-release=1"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("cache-control"), "no-cache", path);
      assert.equal(await response.text(), html, path);
    }
    const asset = await fetch(origin + "/assets/current.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control"), /immutable/);
    assert.match(asset.headers.get("content-type"), /javascript/);
    const missing = await fetch(origin + "/assets/ccip-previous-release.js");
    assert.equal(missing.status, 404);
    assert.ok(!(await missing.text()).includes("Current release"));
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});
