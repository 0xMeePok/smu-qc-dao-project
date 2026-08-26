import fs from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp } from "firebase/firestore";

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
    // 0 = normal user, 1 = administrator. Every signup writes 0; see
    // frontend/src/lib/roles.js and the create rule below.
    role: 0,
    chainId: 421614,
    stats: { ...ZERO_STATS },
    walletVerified: true,
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

  it("blocks self-granting admin (role 1) at signup", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, { role: 1 })),
    );
  });

  it("blocks a role outside 0 or 1", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, { role: 2 })),
    );
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

  it("blocks a chain id other than Arbitrum Sepolia", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, { chainId: 1 })),
    );
  });

  it("blocks claiming walletVerified false at signup", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, { walletVerified: false })),
    );
  });

  it("blocks a profile with an extra, unschemad field", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, { isAdmin: true })),
    );
  });
});

describe("users/{address} read", () => {
  it("lets a wallet read its own profile", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(getDoc(doc(db, "users", ADDRESS)));
  });

  it("blocks an unauthenticated read of a profile", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "users", ADDRESS)));
  });

  it("blocks one signed-in wallet from reading another wallet's profile", async () => {
    // /users carries the real name, organisation, role and signup timestamps.
    // Signing in proves you own YOUR wallet; it does not entitle you to anyone
    // else's record.
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(getDoc(doc(db, "users", ADDRESS)));
  });

  it("blocks enumerating the whole user base", async () => {
    // The original rule was `allow get, list: if true`. `list` is a separate
    // capability from `get`, and it let anyone page through every profile in the
    // project and export the lot - names, organisations, wallets, signup times.
    // Nothing in this app has ever needed to enumerate users.
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(db, "users")));
  });

  it("blocks a signed-in wallet from enumerating the user base either", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(getDocs(collection(db, "users")));
  });

  it("never exposes which wallets are administrators", async () => {
    // The reason role must not be publicly readable: it hands an attacker a
    // precise target list of the only accounts whose compromise matters.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OTHER), baseProfile(null, OTHER, { role: 1 }));
      await setDoc(doc(ctx.firestore(), "publicProfiles", OTHER), {
        address: OTHER,
        fullName: "An Administrator",
        organisation: "Singapore Management University",
      });
    });

    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "users", OTHER)));

    // Nor may a different signed-in wallet read it - being logged in is not a
    // licence to inspect other people's records.
    const asSomeoneElse = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(getDoc(doc(asSomeoneElse, "users", OTHER)));

    // The public record for that same admin must carry no hint of the role.
    const publicSnapshot = await assertSucceeds(getDoc(doc(db, "publicProfiles", OTHER)));
    assert.equal(publicSnapshot.data().role, undefined, "role must not leak via publicProfiles");
    assert.deepEqual(
      Object.keys(publicSnapshot.data()).sort(),
      ["address", "fullName", "organisation"],
      "the public record must expose exactly these three fields and nothing more",
    );
  });

  it("still lets an administrator read their OWN role", async () => {
    // The other half of the requirement: hiding `role` from everyone else must not
    // hide it from its owner, or the app could never tell an admin they are one.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OTHER), baseProfile(null, OTHER, { role: 1 }));
    });

    const db = env.authenticatedContext(OTHER).firestore();
    const snapshot = await assertSucceeds(getDoc(doc(db, "users", OTHER)));
    assert.equal(snapshot.data().role, 1, "an admin must still see their own role");
  });
});

describe("publicProfiles/{address}", () => {
  it("lets anyone look up a known address, so published work can be attributed", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "publicProfiles", ADDRESS), {
        address: ADDRESS,
        fullName: "Ashley Chung",
        organisation: "Singapore Management University",
      });
    });

    const db = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(db, "publicProfiles", ADDRESS)));
  });

  it("blocks enumerating public profiles", async () => {
    // Lookup is allowed, listing is not. Permitting `list` here would rebuild the
    // exact directory-export breach this collection was created to prevent, just
    // one collection over.
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(db, "publicProfiles")));
  });

  it("lets a wallet create its own public record", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertSucceeds(setDoc(doc(db, "publicProfiles", OTHER), {
      address: OTHER,
      fullName: "Ada Lovelace",
      organisation: "Singapore Management University",
    }));
  });

  it("blocks writing a public record for someone else's address", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(setDoc(doc(db, "publicProfiles", ADDRESS), {
      address: ADDRESS,
      fullName: "Impersonator",
      organisation: "Elsewhere",
    }));
  });

  it("lets another signed-in wallet look up a public record", async () => {
    // Attribution has to work for OTHER people, not just anonymous visitors -
    // otherwise signing in would paradoxically remove your ability to see who
    // published something.
    const db = env.authenticatedContext(OTHER).firestore();
    await assertSucceeds(getDoc(doc(db, "publicProfiles", ADDRESS)));
  });

  // Every private field, checked one at a time on BOTH write paths. The previous
  // version of this test only tried `role`, and only on create - so a rule that
  // leaked `stats`, or that locked create but left update open, would have passed
  // it. hasOnly() is the thing under test here, and it has to hold everywhere.
  const FORBIDDEN_PUBLIC_FIELDS = {
    role: 1,
    stats: { comments: 0, businessProblems: 0, openFunding: 0, fundingRequests: 0, karma: 0, reputation: 0 },
    walletVerified: true,
    chainId: 421614,
    termsVersion: "2026-08-24",
    createdAt: serverTimestamp(),
    isAdmin: true,
  };

  for (const [field, value] of Object.entries(FORBIDDEN_PUBLIC_FIELDS)) {
    it(`blocks smuggling '${field}' into a public record on create`, async () => {
      const db = env.authenticatedContext(OTHER).firestore();
      await assertFails(setDoc(doc(db, "publicProfiles", OTHER), {
        address: OTHER,
        fullName: "Ada Lovelace",
        organisation: "Singapore Management University",
        [field]: value,
      }));
    });

    it(`blocks adding '${field}' to an existing public record via update`, async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "publicProfiles", OTHER), {
          address: OTHER,
          fullName: "Ada Lovelace",
          organisation: "Singapore Management University",
        });
      });

      const db = env.authenticatedContext(OTHER).firestore();
      await assertFails(updateDoc(doc(db, "publicProfiles", OTHER), { [field]: value }));
    });
  }

  it("blocks deleting a public record", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(deleteDoc(doc(db, "publicProfiles", ADDRESS)));
  });
});

describe("users/{address} update", () => {
  before(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OTHER), baseProfile(null, OTHER));
    });
  });

  it("allows editing name and organisation", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertSucceeds(
      updateDoc(doc(db, "users", OTHER), {
        organisation: "New Employer Pte Ltd", updatedAt: serverTimestamp(),
      }),
    );
  });

  it("blocks a signed-in user promoting their own role to admin", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      updateDoc(doc(db, "users", OTHER), { role: 1, updatedAt: serverTimestamp() }),
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

  it("blocks changing the chain id after creation", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      updateDoc(doc(db, "users", OTHER), { chainId: 1, updatedAt: serverTimestamp() }),
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
        fullName: "Attacker Controlled", role: 1, updatedAt: serverTimestamp(),
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
