import fs from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";

const ADDRESS = `0x${"a".repeat(40)}`;
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "qc-dao-rules-debug",
    firestore: {
      rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
      host: "127.0.0.1",
      port: 8085,
    },
  });
});

after(async () => {
  await env.cleanup();
});

it("debugs create", async () => {
  const db = env.authenticatedContext(ADDRESS).firestore();
  await assertSucceeds(setDoc(doc(db, "users", ADDRESS), {
    address: ADDRESS,
    fullName: "Ashley Chung",
    organisation: "SMU",
    role: 0,
    chainId: 421614,
    stats: {
      comments: 0, businessProblems: 0, openFunding: 0,
      fundingRequests: 0, karma: 0, reputation: 0,
    },
    walletVerified: true,
    termsAcceptedAt: serverTimestamp(),
    termsVersion: "2026-08-24",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
});
