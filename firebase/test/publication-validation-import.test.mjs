import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";

it("loads the shared publication validator without Functions dependencies", async () => {
  // Match the standalone rules CI job even when functions/node_modules happens
  // to be installed in the developer's checkout. The .mjs suffix also avoids
  // inheriting this repository's package.json module settings.
  const directory = await mkdtemp(join(tmpdir(), "qcdao-publication-validator-"));
  try {
    const functionsDir = new URL("../functions/", import.meta.url);
    await copyFile(new URL("publicationValidation.js", functionsDir), join(directory, "publicationValidation.mjs"));
    await copyFile(new URL("independentProposal.js", functionsDir), join(directory, "independentProposal.js"));
    await copyFile(new URL("opportunityExpiry.js", functionsDir), join(directory, "opportunityExpiry.js"));
    const file = join(directory, "publicationValidation.mjs");
    const { PUBLISH_VALIDATION, isPublishableProblem } = await import(pathToFileURL(file).href);
    assert.equal(PUBLISH_VALIDATION, "problem-publish-v1");
    assert.equal(isPublishableProblem({}, {}), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
