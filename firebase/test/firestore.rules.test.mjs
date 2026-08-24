import fs from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } from "firebase/firestore";

const ADDRESS = `0x${"a".repeat(40)}`;
const OTHER = `0x${"b".repeat(40)}`;
let env;

const ZERO_STATS = {
  comments: 0, businessProblems: 0, openFunding: 0,
  fundingRequests: 0, karma: 0, reputation: 0,
};

function baseProfile(_uid, address = ADDRESS, overrides = {}) {
  return {
    address,
    fullName: "Ashley Chung",
    organisation: "Singapore Management University",
    role: "researcher",
    chainId: "0x66eee",
    stats: { ...ZERO_STATS },
    walletVerified: true,
    onboardingComplete: false,
    termsAcceptedAt: serverTimestamp(),
    termsVersion: "2026-08-24",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "qc-dao-rules-test",
    firestore: {
      rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

after(async () => { await env?.cleanup(); });

describe("users/{address} create", () => {
  it("lets a signed-in wallet create its own profile", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "users", ADDRESS), baseProfile(null)));
  });

  it("blocks an unauthenticated create", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER)));
  });

  it("blocks a role outside the five stakeholders", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, { role: "admin" })),
    );
  });

  it("blocks self-awarded karma at signup", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, {
        stats: { ...ZERO_STATS, karma: 9999 },
      })),
    );
  });

  it("blocks a profile whose stats map omits counters", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, { stats: { karma: 0 } })),
    );
  });

  it("blocks a document id that is not a lowercase address", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      setDoc(doc(db, "users", "not-an-address"), baseProfile(null, "not-an-address")),
    );
  });

  it("blocks an address field that disagrees with the document id", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(setDoc(doc(db, "users", OTHER), baseProfile(null, ADDRESS)));
  });

  it("blocks a signed-in wallet from creating a profile at another address", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER)));
  });

  it("blocks an empty full name", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, { fullName: "" })),
    );
  });
});

describe("users/{address} read", () => {
  it("allows public profile reads", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(db, "users", ADDRESS)));
  });
});

describe("users/{address} update", () => {
  before(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OTHER), baseProfile(null, OTHER));
    });
  });

  it("allows a role change", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertSucceeds(
      updateDoc(doc(db, "users", OTHER), {
        role: "evaluator", onboardingComplete: true, updatedAt: serverTimestamp(),
      }),
    );
  });

  it("blocks a karma increase from the client", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      updateDoc(doc(db, "users", OTHER), {
        "stats.karma": 500, updatedAt: serverTimestamp(),
      }),
    );
  });

  it("blocks rewriting the wallet address", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      updateDoc(doc(db, "users", OTHER), { address: ADDRESS, updatedAt: new Date() }),
    );
  });

  it("blocks self-promoting walletVerified", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      updateDoc(doc(db, "users", OTHER), { walletVerified: true, updatedAt: new Date() }),
    );
  });

  it("blocks another signed-in session from hijacking the profile", async () => {
    const attacker = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(
      updateDoc(doc(attacker, "users", OTHER), {
        fullName: "Attacker Controlled", role: "funder", updatedAt: serverTimestamp(),
      }),
    );
  });

  it("blocks deletes outright", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(deleteDoc(doc(db, "users", OTHER)));
  });
});

describe("collections outside the schema", () => {
  it("denies reads and writes anywhere else", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(setDoc(doc(db, "secrets", "x"), { a: 1 }));
    await assertFails(getDoc(doc(db, "secrets", "x")));
  });

  it("hides sign-in nonces from every client", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(getDoc(doc(db, "siweNonces", ADDRESS)));
    await assertFails(setDoc(doc(db, "siweNonces", ADDRESS), { consumed: false }));
  });
});
