import fs from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, deleteField, writeBatch, serverTimestamp } from "firebase/firestore";

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

function baseProblem(overrides = {}) {
  return {
    ownerId: ADDRESS,
    title: "Fault-tolerant scheduling",
    summary: "Research a verifiable scheduler for noisy devices.",
    amount: 1000,
    status: "draft",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function baseProposal(overrides = {}) {
  return {
    researcherId: ADDRESS,
    problemId: "p1",
    title: "Scheduler research proposal",
    summary: "A staged research and validation plan.",
    amount: 800,
    status: "draft",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function baseEvaluation(overrides = {}) {
  return {
    evaluatorId: ADDRESS,
    proposalId: "prop1",
    title: "Technical evaluation",
    score: 80,
    feedback: "The validation plan is technically sound.",
    status: "draft",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function baseFunding(overrides = {}) {
  return {
    funderId: ADDRESS,
    proposalId: "prop1",
    problemId: "p1",
    title: "Research grant",
    amount: 800,
    status: "pledged",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function baseAudit(overrides = {}) {
  return {
    schemaVersion: 1,
    chainId: 421614,
    entityId: `0x${"1".repeat(64)}`,
    contentHash: `0x${"2".repeat(64)}`,
    status: "queued",
    transactionHash: "",
    blockNumber: 0,
    attemptCount: 0,
    lastError: "",
    ...overrides,
  };
}

function firestoreEmulator() {
  const raw = process.env.FIRESTORE_EMULATOR_HOST;
  if (!raw) return { host: "127.0.0.1", port: 8080 };
  const [host, port] = raw.split(":");
  return { host, port: Number(port) };
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "qc-dao-rules-test",
    firestore: {
      rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
      ...firestoreEmulator(),
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

  it("blocks setting suspended at signup", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, { suspended: false })),
    );
    await assertFails(
      setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, { suspended: true })),
    );
  });

  it("blocks expertise entries that are not strings or outside the 2-80 character bound", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    for (const expertise of [[42], ["x"], ["x".repeat(81)]]) {
      await assertFails(
        setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, { expertise })),
      );
    }
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

  it("lets a wallet create its own public record when it matches the private one", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OTHER), baseProfile(null, OTHER, {
        fullName: "Ada Lovelace",
      }));
    });

    const db = env.authenticatedContext(OTHER).firestore();
    await assertSucceeds(setDoc(doc(db, "publicProfiles", OTHER), {
      address: OTHER,
      fullName: "Ada Lovelace",
      organisation: "Singapore Management University",
    }));
  });

  it("blocks a public record with no private profile behind it", async () => {
    // A verified wallet could otherwise publish a name and organisation without ever
    // holding an account - attribution pointing at nothing.
    const ORPHAN = `0x${"c".repeat(40)}`;
    const db = env.authenticatedContext(ORPHAN).firestore();
    await assertFails(setDoc(doc(db, "publicProfiles", ORPHAN), {
      address: ORPHAN,
      fullName: "Ghost Account",
      organisation: "Nowhere",
    }));
  });

  it("blocks a public name that differs from the private profile", async () => {
    // Without this, the name shown beside published work could drift away from the
    // name on the account, making attribution meaningless.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OTHER), baseProfile(null, OTHER, {
        fullName: "Ada Lovelace",
      }));
    });

    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(setDoc(doc(db, "publicProfiles", OTHER), {
      address: OTHER,
      fullName: "Someone Else Entirely",
      organisation: "Singapore Management University",
    }));
  });

  it("blocks a public organisation that differs from the private profile", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OTHER), baseProfile(null, OTHER, {
        fullName: "Ada Lovelace",
      }));
    });

    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(setDoc(doc(db, "publicProfiles", OTHER), {
      address: OTHER,
      fullName: "Ada Lovelace",
      organisation: "A Different Institution",
    }));
  });

  it("blocks invalid expertise entries on public profile create", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OTHER), baseProfile(null, OTHER));
    });

    const db = env.authenticatedContext(OTHER).firestore();
    for (const expertise of [[42], ["x"], ["x".repeat(81)]]) {
      await assertFails(setDoc(doc(db, "publicProfiles", OTHER), {
        address: OTHER,
        fullName: "Ashley Chung",
        organisation: "Singapore Management University",
        expertise,
      }));
    }
  });

  it("allows both documents to be created together in one batch", async () => {
    // getAfter() evaluates against the post-commit state, which is what lets
    // createProfile write the private and public records in a single batch.
    const FRESH = `0x${"d".repeat(40)}`;
    const db = env.authenticatedContext(FRESH).firestore();

    const batch = writeBatch(db);
    batch.set(doc(db, "users", FRESH), baseProfile(null, FRESH, { fullName: "Grace Hopper" }));
    batch.set(doc(db, "publicProfiles", FRESH), {
      address: FRESH,
      fullName: "Grace Hopper",
      organisation: "Singapore Management University",
    });

    await assertSucceeds(batch.commit());
  });

  it("blocks a batch whose public and private names disagree", async () => {
    const FRESH = `0x${"e".repeat(40)}`;
    const db = env.authenticatedContext(FRESH).firestore();

    const batch = writeBatch(db);
    batch.set(doc(db, "users", FRESH), baseProfile(null, FRESH, { fullName: "Grace Hopper" }));
    batch.set(doc(db, "publicProfiles", FRESH), {
      address: FRESH,
      fullName: "Not Grace",
      organisation: "Singapore Management University",
    });

    await assertFails(batch.commit());
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
      await setDoc(doc(ctx.firestore(), "publicProfiles", OTHER), {
        address: OTHER,
        fullName: "Ashley Chung",
        organisation: "Singapore Management University",
      });
    });
  });

  it("allows editing name and organisation", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    const batch = writeBatch(db);
    batch.update(doc(db, "users", OTHER), {
      organisation: "New Employer Pte Ltd", updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, "publicProfiles", OTHER), {
      organisation: "New Employer Pte Ltd",
    });
    await assertSucceeds(batch.commit());
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

  it("blocks changing createdAt after creation", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      updateDoc(doc(db, "users", OTHER), { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }),
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

  it("blocks updating profile when suspended is present on the document", async () => {
    const SUSPENDED_USER = `0x${"f".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), "users", SUSPENDED_USER),
        baseProfile(null, SUSPENDED_USER, { suspended: true }),
      );
    });

    const db = env.authenticatedContext(SUSPENDED_USER).firestore();
    await assertFails(
      updateDoc(doc(db, "users", SUSPENDED_USER), {
        organisation: "Updated Org",
        suspended: true,
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it("blocks self-unsuspending or adding suspended during profile update", async () => {
    const SUSPENDED_USER = `0x${"f".repeat(40)}`;
    const db = env.authenticatedContext(SUSPENDED_USER).firestore();
    // Attempting to clear suspended or change to false
    await assertFails(
      updateDoc(doc(db, "users", SUSPENDED_USER), {
        organisation: "Updated Org",
        suspended: false,
        updatedAt: serverTimestamp(),
      }),
    );

    // Attempting to add suspended: true to an existing un-suspended user
    const dbOther = env.authenticatedContext(OTHER).firestore();
    await assertFails(
      updateDoc(doc(dbOther, "users", OTHER), {
        suspended: true,
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it("blocks deletes outright", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(deleteDoc(doc(db, "users", OTHER)));
  });
});

describe("problems/{problemId}", () => {
  it("[BIT-AAR-76] [QCDAO43] allows access to the owner", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "p1"), baseProblem()));
    await assertSucceeds(getDoc(doc(db, "problems", "p1")));
  });

  it("[BIT-AAR-77] [QCDAO43] blocks access to non-owners", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "problems", "p2"), { ownerId: ADDRESS });
    });
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(getDoc(doc(db, "problems", "p2")));
    await assertFails(updateDoc(doc(db, "problems", "p2"), { title: "Hacked" }));
  });

  it("[BIT-AAR-78] [QCDAO43] blocks unauthenticated access", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "problems", "p1")));
  });

  it("[BIT-AAR-91] [QCDAO43] blocks mutating ownerId on update", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "problems", "p_imm"), { ownerId: ADDRESS, title: "Original" });
    });
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(updateDoc(doc(db, "problems", "p_imm"), { ownerId: OTHER }));
  });

  it("[BIT-AAR-92] [QCDAO43] blocks unschemad fields on create and update", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "p_bad"), { ownerId: ADDRESS, invalidExtraField: "bad" }));
    await assertSucceeds(setDoc(doc(db, "problems", "p_good"), baseProblem()));
    await assertFails(updateDoc(doc(db, "problems", "p_good"), { invalidExtraField: "bad" }));
  });

  it("[QCDAO-127] enforces required fields, values, timestamps and transitions", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "missing"), { ownerId: ADDRESS }));
    await assertFails(setDoc(doc(db, "problems", "negative"), baseProblem({ amount: -1 })));
    await assertFails(setDoc(doc(db, "problems", "bad-status"), baseProblem({ status: "hacked" })));
    await assertFails(setDoc(doc(db, "problems", "forged-time"), baseProblem({ createdAt: new Date(0) })));
    await assertFails(updateDoc(doc(db, "problems", "p1"), {
      status: "completed",
      updatedAt: serverTimestamp(),
    }));
    // A legacy draft cannot become marketplace-visible without the funded schema.
    await assertFails(updateDoc(doc(db, "problems", "p1"), {
      status: "open",
      updatedAt: serverTimestamp(),
    }));
  });

  it("[QCDAO47] blocks access and reads for suspended problem owners", async () => {
    const SUSPENDED_USER = `0x${"f".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", SUSPENDED_USER), baseProfile(null, SUSPENDED_USER, { suspended: true }));
      await setDoc(doc(ctx.firestore(), "problems", "p_susp"), { ownerId: SUSPENDED_USER });
    });
    const db = env.authenticatedContext(SUSPENDED_USER).firestore();
    await assertFails(getDoc(doc(db, "problems", "p_susp")));
  });

  it("[QCDAO-129] blocks ID tokens issued before the server revocation marker", async () => {
    const REVOKED = `0x${"9".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", REVOKED), baseProfile(null, REVOKED, {
        sessionsValidAfterEpoch: 101,
      }));
      await setDoc(doc(ctx.firestore(), "problems", "p_revoked"), {
        ownerId: REVOKED,
      });
    });
    const db = env.authenticatedContext(REVOKED, { auth_time: 100 }).firestore();
    await assertFails(getDoc(doc(db, "problems", "p_revoked")));
  });

  it("[QCDAO-129] blocks ID tokens issued in the same second as the cutoff", async () => {
    const REVOKED = `0x${"3".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", REVOKED), baseProfile(null, REVOKED, {
        sessionsValidAfterEpoch: 101,
      }));
      await setDoc(doc(ctx.firestore(), "problems", "p_same_second"), {
        ownerId: REVOKED,
      });
    });
    const db = env.authenticatedContext(REVOKED, { auth_time: 101 }).firestore();
    await assertFails(getDoc(doc(db, "problems", "p_same_second")));
  });
});

describe("QCDAO-75..79 audit receipt state", () => {
  it("accepts a queued receipt and its submitted, pending, and confirmed lifecycle", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "audit-flow"), baseProblem({
      audit: baseAudit(),
    })));

    const transactionHash = `0x${"3".repeat(64)}`;
    await assertSucceeds(updateDoc(doc(db, "problems", "audit-flow"), {
      audit: baseAudit({ status: "submitted", transactionHash, attemptCount: 1 }),
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(db, "problems", "audit-flow"), {
      audit: baseAudit({ status: "pending", transactionHash, attemptCount: 1 }),
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(db, "problems", "audit-flow"), {
      audit: baseAudit({
        status: "confirmed", transactionHash, blockNumber: 123456, attemptCount: 1,
      }),
      updatedAt: serverTimestamp(),
    }));
  });

  it("accepts the same receipt shape on proposal records", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "proposals", "audit-proposal"), baseProposal({
      audit: baseAudit({ entityId: `0x${"4".repeat(64)}` }),
    })));
  });

  it("rejects contract receipts on platform-only evaluation records", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "evaluations", "audit-evaluation"), baseEvaluation({
      audit: baseAudit(),
    })));
  });

  it("rejects forged, incomplete, and contradictory receipt metadata", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "audit-chain"), baseProblem({
      audit: baseAudit({ chainId: 1 }),
    })));
    await assertFails(setDoc(doc(db, "problems", "audit-hash"), baseProblem({
      audit: baseAudit({ contentHash: "not-a-hash" }),
    })));
    await assertFails(setDoc(doc(db, "problems", "audit-confirmed"), baseProblem({
      audit: baseAudit({ status: "confirmed", blockNumber: 0 }),
    })));
    await assertFails(setDoc(doc(db, "problems", "audit-extra"), baseProblem({
      audit: { ...baseAudit(), administratorApproved: true },
    })));
    await assertFails(setDoc(doc(db, "problems", "audit-address"), baseProblem({
      audit: {
        ...baseAudit(),
        contractAddress: `0x${"c".repeat(40)}`,
      },
    })));
  });

  it("caps failed retries and lets the workflow record survive a testnet failure", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "audit-failed"), baseProblem({
      audit: baseAudit({ status: "failed", attemptCount: 3, lastError: "RPC unavailable" }),
    })));
    await assertFails(setDoc(doc(db, "problems", "audit-too-many"), baseProblem({
      audit: baseAudit({ status: "failed", attemptCount: 4, lastError: "RPC unavailable" }),
    })));
  });
});

// QCDAO-58. The bytes live in Cloud Storage under firebase/storage.rules; this
// block covers only the reference list stored on the posting itself.
describe("problems/{problemId} attachments", () => {
  function attachment(overrides = {}) {
    const id = overrides.id ?? "abc123xy";
    const problemId = overrides.problemId ?? "att1";
    const ownerId = overrides.ownerId ?? ADDRESS;
    return {
      id,
      name: "spec.pdf",
      size: 2048,
      contentType: "application/pdf",
      path: `problems/${ownerId}/${problemId}/${id}.pdf`,
      ...overrides.fields,
    };
  }

  it("[BIT-OPD-142] accepts a posting carrying a well-formed attachment", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "att1"), baseProblem({
      attachments: [attachment()],
    })));
  });

  it("[BIT-OPD-143] accepts a posting with no attachments at all", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "att_none"), baseProblem()));
    await assertSucceeds(setDoc(doc(db, "problems", "att_empty"), baseProblem({ attachments: [] })));
  });

  it("[BIT-OPD-144] rejects a path pointing into another wallet's storage folder", async () => {
    // The core check. Without it a user could record, on their OWN posting, a
    // reference to a file belonging to someone else - and any later screen that
    // renders the list would be handing out a pointer to a document the viewer
    // was never allowed to know about.
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "att_foreign"), baseProblem({
      attachments: [attachment({ ownerId: OTHER, problemId: "att_foreign" })],
    })));
  });

  it("[BIT-OPD-145] rejects a path pointing at a different posting", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "att_wrong_posting"), baseProblem({
      attachments: [attachment({ problemId: "someOtherPosting" })],
    })));
  });

  it("[BIT-OPD-146] rejects an attachment that is not a .pdf path", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "att_html"), baseProblem({
      attachments: [attachment({
        problemId: "att_html",
        fields: { path: `problems/${ADDRESS}/att_html/abc123xy.html` },
      })],
    })));
  });

  it("[BIT-OPD-147] rejects a recorded size above the 10 MB cap", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "att_big"), baseProblem({
      attachments: [attachment({ problemId: "att_big", fields: { size: 10 * 1024 * 1024 + 1 } })],
    })));
  });

  it("[BIT-OPD-148] rejects a declared content type other than PDF", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "att_type"), baseProblem({
      attachments: [attachment({ problemId: "att_type", fields: { contentType: "text/html" } })],
    })));
  });

  it("[BIT-OPD-149] rejects unknown fields smuggled into an attachment record", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "att_extra"), baseProblem({
      attachments: [attachment({ problemId: "att_extra", fields: { isPublic: true } })],
    })));
  });

  it("[BIT-OPD-150] rejects a client-supplied uploadedAt timestamp", async () => {
    // Rules cannot pin a per-item timestamp to request.time inside a list, so the
    // field is not in the schema at all rather than being accepted unvalidated and
    // later displayed as though the server had vouched for it.
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "att_time"), baseProblem({
      attachments: [attachment({
        problemId: "att_time",
        fields: { uploadedAt: new Date("2001-01-01") },
      })],
    })));
  });

  it("[BIT-OPD-151] rejects more attachments than a posting may carry", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    const six = Array.from({ length: 6 }, (_, index) => attachment({
      id: `attach${index}0000`,
      problemId: "att_many",
    }));
    await assertFails(setDoc(doc(db, "problems", "att_many"), baseProblem({ attachments: six })));
  });

  it("[BIT-OPD-152] rejects an attachment list that is not a list", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "att_shape"), baseProblem({
      attachments: { id: "abc123xy" },
    })));
  });

  it("[BIT-OPD-153] lets the owner add and then remove an attachment on update", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "att_edit"), baseProblem()));
    await assertSucceeds(updateDoc(doc(db, "problems", "att_edit"), {
      attachments: [attachment({ problemId: "att_edit" })],
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(db, "problems", "att_edit"), {
      attachments: [],
      updatedAt: serverTimestamp(),
    }));
  });

  it("[BIT-OPD-154] blocks another wallet from attaching to someone else's posting", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "problems", "att_other"), baseProblem());
    });
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(updateDoc(doc(db, "problems", "att_other"), {
      attachments: [attachment({ ownerId: OTHER, problemId: "att_other" })],
      updatedAt: serverTimestamp(),
    }));
  });
});

describe("proposals/{proposalId}", () => {
  it("[BIT-AAR-79] [QCDAO43] allows access to the researcher", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "proposals", "prop1"), baseProposal()));
    await assertSucceeds(getDoc(doc(db, "proposals", "prop1")));
  });

  it("[BIT-AAR-80] [QCDAO43] blocks access to non-owners", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "proposals", "prop2"), { researcherId: ADDRESS });
    });
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(getDoc(doc(db, "proposals", "prop2")));
  });

  it("[BIT-AAR-81] [QCDAO43] blocks unauthenticated access", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "proposals", "prop1")));
  });

  it("[BIT-AAR-93] [QCDAO43] blocks mutating researcherId on update", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "proposals", "prop_imm"), { researcherId: ADDRESS, title: "Original" });
    });
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(updateDoc(doc(db, "proposals", "prop_imm"), { researcherId: OTHER }));
  });

  it("[BIT-AAR-94] [QCDAO43] blocks unschemad fields on create and update", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "proposals", "prop_bad"), { researcherId: ADDRESS, injectedKey: "hack" }));
  });

  it("[QCDAO-127] rejects malformed proposals and nonexistent relationships", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "proposals", "bad-amount"), baseProposal({ amount: "800" })));
    await assertFails(setDoc(doc(db, "proposals", "missing-problem"), baseProposal({ problemId: "absent" })));
    await assertFails(setDoc(doc(db, "proposals", "forged-time"), baseProposal({ updatedAt: new Date(0) })));
  });

  it("[QCDAO-127] enforces proposal status transitions", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "proposals", "prop_tr"), baseProposal()));
    await assertFails(updateDoc(doc(db, "proposals", "prop_tr"), {
      status: "accepted",
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(db, "proposals", "prop_tr"), {
      status: "submitted",
      updatedAt: serverTimestamp(),
    }));
  });

  it("[QCDAO47] blocks access and reads for suspended researchers", async () => {
    const SUSPENDED_USER = `0x${"f".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", SUSPENDED_USER), baseProfile(null, SUSPENDED_USER, { suspended: true }));
      await setDoc(doc(ctx.firestore(), "proposals", "prop_susp"), { researcherId: SUSPENDED_USER });
    });
    const db = env.authenticatedContext(SUSPENDED_USER).firestore();
    await assertFails(getDoc(doc(db, "proposals", "prop_susp")));
  });
});

describe("evaluations/{evaluationId}", () => {
  it("[BIT-AAR-82] [QCDAO43] allows access to the evaluator", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "evaluations", "e1"), baseEvaluation()));
    await assertSucceeds(getDoc(doc(db, "evaluations", "e1")));
  });

  it("[BIT-AAR-83] [QCDAO43] blocks access to non-evaluators", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "evaluations", "e2"), { evaluatorId: ADDRESS });
    });
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(getDoc(doc(db, "evaluations", "e2")));
  });

  it("[BIT-AAR-84] [QCDAO43] blocks unauthenticated access", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "evaluations", "e1")));
  });

  it("[BIT-AAR-95] [QCDAO43] blocks mutating evaluatorId on update", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "evaluations", "e_imm"), { evaluatorId: ADDRESS, score: 90 });
    });
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(updateDoc(doc(db, "evaluations", "e_imm"), { evaluatorId: OTHER }));
  });

  it("[BIT-AAR-96] [QCDAO43] blocks unschemad fields on create and update", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "evaluations", "e_bad"), { evaluatorId: ADDRESS, injectedKey: "hack" }));
  });

  it("[QCDAO-127] validates score, status, timestamps and proposal references", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "evaluations", "bad-score"), baseEvaluation({ score: 101 })));
    await assertFails(setDoc(doc(db, "evaluations", "bad-status"), baseEvaluation({ status: "approved" })));
    await assertFails(setDoc(doc(db, "evaluations", "missing-proposal"), baseEvaluation({ proposalId: "absent" })));
    await assertFails(setDoc(doc(db, "evaluations", "forged-time"), baseEvaluation({ createdAt: new Date(0) })));
  });

  it("[QCDAO-127] enforces evaluation status transitions", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "evaluations", "e_tr"), baseEvaluation()));
    await assertFails(updateDoc(doc(db, "evaluations", "e_tr"), {
      status: "accepted",
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(db, "evaluations", "e_tr"), {
      status: "submitted",
      updatedAt: serverTimestamp(),
    }));
  });

  it("[QCDAO47] blocks access and reads for suspended evaluators", async () => {
    const SUSPENDED_USER = `0x${"f".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", SUSPENDED_USER), baseProfile(null, SUSPENDED_USER, { suspended: true }));
      await setDoc(doc(ctx.firestore(), "evaluations", "e_susp"), { evaluatorId: SUSPENDED_USER });
    });
    const db = env.authenticatedContext(SUSPENDED_USER).firestore();
    await assertFails(getDoc(doc(db, "evaluations", "e_susp")));
  });
});

describe("funding/{fundId}", () => {
  it("[BIT-AAR-85] [QCDAO43] allows access to the funder", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "funding", "f1"), baseFunding()));
    await assertSucceeds(getDoc(doc(db, "funding", "f1")));
  });

  it("[BIT-AAR-86] [QCDAO43] blocks access to non-funders", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "funding", "f2"), { funderId: ADDRESS });
    });
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(getDoc(doc(db, "funding", "f2")));
  });

  it("[BIT-AAR-87] [QCDAO43] blocks unauthenticated access", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "funding", "f1")));
  });

  it("[BIT-AAR-97] [QCDAO43] blocks mutating funderId on update", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "funding", "f_imm"), { funderId: ADDRESS, amount: "50000" });
    });
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(updateDoc(doc(db, "funding", "f_imm"), { funderId: OTHER }));
  });

  it("[BIT-AAR-98] [QCDAO43] blocks unschemad fields on create and update", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "funding", "f_bad"), { funderId: ADDRESS, injectedKey: "hack" }));
  });

  it("[QCDAO-127] rejects malformed funding and inconsistent relationships", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "funding", "negative"), baseFunding({ amount: -1 })));
    await assertFails(setDoc(doc(db, "funding", "bad-tranche"), baseFunding({
      tranches: [{ amount: -10, status: "released" }],
    })));
    await assertFails(setDoc(doc(db, "funding", "bad-problem"), baseFunding({ problemId: "absent" })));
    await assertFails(setDoc(doc(db, "funding", "forged-time"), baseFunding({ updatedAt: new Date(0) })));
  });

  it("[QCDAO-127] enforces funding status transitions", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "funding", "f_tr"), baseFunding()));
    await assertFails(updateDoc(doc(db, "funding", "f_tr"), {
      status: "completed",
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(db, "funding", "f_tr"), {
      status: "approved",
      updatedAt: serverTimestamp(),
    }));
  });

  it("[QCDAO47] blocks access and reads for suspended funders", async () => {
    const SUSPENDED_USER = `0x${"f".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", SUSPENDED_USER), baseProfile(null, SUSPENDED_USER, { suspended: true }));
      await setDoc(doc(ctx.firestore(), "funding", "f_susp"), { funderId: SUSPENDED_USER });
    });
    const db = env.authenticatedContext(SUSPENDED_USER).firestore();
    await assertFails(getDoc(doc(db, "funding", "f_susp")));
  });
});

describe("audits/{auditId}", () => {
  const ADMIN = `0x${"c".repeat(40)}`;

  before(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", ADMIN), baseProfile(null, ADMIN, { role: 1 }));
      await setDoc(doc(ctx.firestore(), "users", OTHER), baseProfile(null, OTHER, { role: 0 }));
      await setDoc(doc(ctx.firestore(), "audits", "a1"), { action: "TEST_EVENT" });
    });
  });

  it("[BIT-AAR-88] [QCDAO43] allows read for administrators (role == 1)", async () => {
    const db = env.authenticatedContext(ADMIN).firestore();
    await assertSucceeds(getDoc(doc(db, "audits", "a1")));
  });

  it("[BIT-AAR-89] [QCDAO43] blocks read for normal users (role == 0)", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(getDoc(doc(db, "audits", "a1")));
  });

  it("[BIT-AAR-99] [QCDAO47] blocks read for suspended administrators", async () => {
    const SUSPENDED_ADMIN = `0x${"e".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", SUSPENDED_ADMIN), baseProfile(null, SUSPENDED_ADMIN, { role: 1, suspended: true }));
    });
    const db = env.authenticatedContext(SUSPENDED_ADMIN).firestore();
    await assertFails(getDoc(doc(db, "audits", "a1")));
  });

  it("[BIT-AAR-90] [QCDAO43] blocks writes for everyone (even admins)", async () => {
    const db = env.authenticatedContext(ADMIN).firestore();
    await assertFails(setDoc(doc(db, "audits", "a2"), { action: "HACK" }));
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

  it("hides session revocation cutoffs from every client", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(getDoc(doc(db, "sessionRevocations", ADDRESS)));
    await assertFails(setDoc(doc(db, "sessionRevocations", ADDRESS), {
      sessionsValidAfterEpoch: 1,
    }));
  });
});

describe("session revocation", () => {
  it("[QCDAO-129] blocks reading a private profile after session revocation", async () => {
    const REVOKED = `0x${"8".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", REVOKED), baseProfile(null, REVOKED));
      await setDoc(doc(ctx.firestore(), "sessionRevocations", REVOKED), {
        sessionsValidAfterEpoch: 101,
      });
    });
    const db = env.authenticatedContext(REVOKED, { auth_time: 100 }).firestore();
    await assertFails(getDoc(doc(db, "users", REVOKED)));
  });

  it("[QCDAO-129] blocks a token whose auth_time equals the revocation cutoff", async () => {
    const REVOKED = `0x${"2".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", REVOKED), baseProfile(null, REVOKED));
      await setDoc(doc(ctx.firestore(), "sessionRevocations", REVOKED), {
        sessionsValidAfterEpoch: 101,
      });
    });
    const db = env.authenticatedContext(REVOKED, { auth_time: 101 }).firestore();
    await assertFails(getDoc(doc(db, "users", REVOKED)));
  });

  it("[QCDAO-129] blocks creating a profile with a revoked pre-onboarding token", async () => {
    const FRESH = `0x${"7".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "sessionRevocations", FRESH), {
        sessionsValidAfterEpoch: 101,
      });
    });
    const db = env.authenticatedContext(FRESH, { auth_time: 100 }).firestore();
    await assertFails(setDoc(doc(db, "users", FRESH), baseProfile(null, FRESH)));
    await assertFails(setDoc(doc(db, "publicProfiles", FRESH), {
      address: FRESH,
      fullName: "Ashley Chung",
      organisation: "Singapore Management University",
    }));
  });

  it("[QCDAO-129] allows creating a profile after a new sign-in past the cutoff", async () => {
    const FRESH = `0x${"6".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "sessionRevocations", FRESH), {
        sessionsValidAfterEpoch: 101,
      });
    });
    const db = env.authenticatedContext(FRESH, { auth_time: 200 }).firestore();
    const batch = writeBatch(db);
    batch.set(doc(db, "users", FRESH), baseProfile(null, FRESH));
    batch.set(doc(db, "publicProfiles", FRESH), {
      address: FRESH,
      fullName: "Ashley Chung",
      organisation: "Singapore Management University",
    });
    await assertSucceeds(batch.commit());
  });
});

// QCDAO-48 - the structured funded business problem statement.
describe("problems/{problemId} funded posting", () => {
  const FUTURE = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  before(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", ADDRESS), baseProfile(null, ADDRESS));
    });
  });

  function submitted(overrides = {}) {
    return {
      ownerId: ADDRESS,
      organisation: "Singapore Management University",
      title: "Cold-chain route optimisation",
      businessContext: "Perishable deliveries across a dense urban network.",
      summary: "Vehicle routing degrades badly under demand spikes.",
      currentApproach: "A nightly heuristic solver over the previous day's demand.",
      currentLimitations: "Runtime grows past the delivery window above 400 stops.",
      expectedOutcome: "A schedule produced inside a thirty minute window.",
      successCriteria: "Ten percent lower distance at equal service level.",
      dataAvailability: "Two years of anonymised delivery telemetry, CSV, 4 GB.",
      categories: ["ai", "quantum"],
      amount: 80000,
      currency: "USDC",
      expiresAt: FUTURE,
      status: "submitted",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...overrides,
    };
  }

  it("[BIT-OPD-155] accepts a complete funded problem statement", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "q48_ok"), submitted()));
  });

  it("[BIT-OPD-156] rejects a category outside the agreed set", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "q48_badcat"), submitted({
      categories: ["blockchain"],
    })));
  });

  it("[BIT-OPD-157] requires at least one category", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "q48_nocat"), submitted({ categories: [] })));
  });

  it("[BIT-OPD-158] rejects a submitted posting missing any structured field", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    const required = [
      "organisation", "businessContext", "currentApproach", "currentLimitations",
      "expectedOutcome", "successCriteria", "dataAvailability",
      "categories", "currency", "expiresAt",
    ];
    for (const field of required) {
      const record = submitted();
      delete record[field];
      await assertFails(
        setDoc(doc(db, "problems", `q48_missing_${field}`), record),
        `omitting ${field} should be rejected`,
      );
    }
  });

  it("[BIT-OPD-159] rejects zero or negative funding", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "q48_zero"), submitted({ amount: 0 })));
    await assertFails(setDoc(doc(db, "problems", "q48_neg"), submitted({ amount: -5 })));
  });

  it("[BIT-OPD-160] rejects an unsupported currency", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "q48_cur"), submitted({ currency: "XYZ" })));
    await assertFails(setDoc(doc(db, "problems", "q48_fiat"), submitted({ currency: "SGD" })));
  });

  it("[BIT-OPD-161] rejects a posting that has already expired", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "q48_expired"), submitted({
      expiresAt: new Date(Date.now() - 1000),
    })));
  });

  it("[BIT-OPD-162] blocks posting under another wallet's identity", async () => {
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(setDoc(doc(db, "problems", "q48_forged"), submitted()));
  });

  it("[BIT-OPD-163] blocks an unauthenticated post", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, "problems", "q48_anon"), submitted()));
  });

  it("[BIT-OPD-164] refuses to create a posting already open or funded", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    for (const status of ["open", "in_review", "matched", "funded", "completed"]) {
      await assertFails(
        setDoc(doc(db, "problems", `q48_status_${status}`), submitted({ status })),
        `should not be able to create directly in ${status}`,
      );
    }
  });

  it("[BIT-OPD-165] refuses to strip structure out of a submitted posting later", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "q48_strip"), submitted()));
    await assertFails(updateDoc(doc(db, "problems", "q48_strip"), {
      categories: [],
      updatedAt: serverTimestamp(),
    }));
  });

  it("[BIT-OPD-166] allows submitted to advance to open", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "q48_open"), submitted()));
    await assertSucceeds(updateDoc(doc(db, "problems", "q48_open"), {
      status: "open",
      updatedAt: serverTimestamp(),
    }));
  });

  it("[BIT-OPD-167] refuses to strip structure while advancing a submitted posting to open", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "q48_strip_open"), submitted()));
    await assertFails(updateDoc(doc(db, "problems", "q48_strip_open"), {
      status: "open",
      categories: deleteField(),
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(db, "problems", "q48_strip_open"), {
      status: "open",
      businessContext: "",
      updatedAt: serverTimestamp(),
    }));
  });

  it("[BIT-OPD-168] rejects a submitted posting whose mandatory text is blank", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    const requiredText = [
      "businessContext", "currentApproach", "currentLimitations",
      "expectedOutcome", "successCriteria", "dataAvailability",
    ];
    for (const field of requiredText) {
      await assertFails(
        setDoc(doc(db, "problems", `q48_blank_${field}`), submitted({ [field]: "" })),
        `${field} as empty string should be rejected`,
      );
      await assertFails(
        setDoc(doc(db, "problems", `q48_short_${field}`), submitted({ [field]: "x" })),
        `${field} of one character should be rejected`,
      );
    }
  });

  it("[BIT-OPD-169] refuses a legacy draft advancing to open without the funded schema", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "q48_draft_open"), baseProblem()));
    await assertFails(updateDoc(doc(db, "problems", "q48_draft_open"), {
      status: "open",
      updatedAt: serverTimestamp(),
    }));
  });


  it("[BIT-OPD-170] still accepts a legacy draft with none of the new fields", async () => {
    // Pre-QCDAO-48 documents must remain writable, or existing data becomes
    // uneditable the moment these rules deploy.
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "q48_legacy"), baseProblem()));
    await assertSucceeds(updateDoc(doc(db, "problems", "q48_legacy"), {
      title: "Edited legacy problem",
      updatedAt: serverTimestamp(),
    }));
  });

  it("[BIT-OPD-171] rejects a sponsor organisation that is not the owner's profile", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "q48_spoof_org"), submitted({
      organisation: "A Trusted Institution We Do Not Belong To",
    })));
  });
});

// QCDAO-51 - funding seeks both a problem and a solution.
describe("problems/{problemId} open funding opportunity", () => {
  const FUTURE = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  before(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", ADDRESS), baseProfile(null, ADDRESS));
    });
  });

  function openFunding(overrides = {}) {
    return {
      opportunityType: "open-funding",
      ownerId: ADDRESS,
      organisation: "Singapore Management University",
      title: "Open call for resilient supply chains",
      fundingThesis: "Fund practical research into more resilient supply chains.",
      eligibilityNotes: "Universities and registered research organisations may apply.",
      categories: ["quantum", "optimisation"],
      tags: ["logistics", "resilience"],
      amount: 250000,
      currency: "USDC",
      expiresAt: FUTURE,
      status: "submitted",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...overrides,
    };
  }

  it("[QCDAO-51] accepts the distinct shape without a fixed problem", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "q51_ok"), openFunding()));
  });

  it("[QCDAO-51] requires every open-funding field", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    for (const field of [
      "organisation", "fundingThesis", "eligibilityNotes", "categories",
      "tags", "currency", "expiresAt",
    ]) {
      const record = openFunding();
      delete record[field];
      await assertFails(
        setDoc(doc(db, "problems", `q51_missing_${field}`), record),
        `omitting ${field} should be rejected`,
      );
    }
  });

  it("[QCDAO-51] rejects problem-specific fields and attachments", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "q51_problem"), openFunding({
      summary: "A fixed problem should not be part of this entity.",
    })));
    await assertFails(setDoc(doc(db, "problems", "q51_attachment"), openFunding({
      attachments: [],
    })));
  });

  it("[QCDAO-51] validates and de-duplicates discovery tags", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "q51_notags"), openFunding({ tags: [] })));
    await assertFails(setDoc(doc(db, "problems", "q51_dupetags"), openFunding({
      tags: ["logistics", "logistics"],
    })));
    await assertFails(setDoc(doc(db, "problems", "q51_longtag"), openFunding({
      tags: ["x".repeat(41)],
    })));
  });

  it("[QCDAO-51] rejects expired funding, fiat currency and a spoofed organisation", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertFails(setDoc(doc(db, "problems", "q51_expired"), openFunding({
      expiresAt: new Date(Date.now() - 1000),
    })));
    await assertFails(setDoc(doc(db, "problems", "q51_fiat"), openFunding({
      currency: "SGD",
    })));
    await assertFails(setDoc(doc(db, "problems", "q51_spoof"), openFunding({
      organisation: "Another Sponsor",
    })));
  });

  it("[QCDAO-51] freezes the on-chain opportunity kind after creation", async () => {
    const db = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(setDoc(doc(db, "problems", "q51_kind"), openFunding()));
    await assertFails(updateDoc(doc(db, "problems", "q51_kind"), {
      opportunityType: "business-problem",
      updatedAt: serverTimestamp(),
    }));
  });
});

// QCDAO-48 - who can see a published posting.
describe("problems/{problemId} marketplace visibility", () => {
  const PUBLISHED = "vis_published";
  const DRAFT = "vis_draft";

  before(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "users", ADDRESS), baseProfile(null, ADDRESS));
      await setDoc(doc(db, "users", OTHER), baseProfile(null, OTHER, {
        organisation: "Another Lab",
      }));
      await setDoc(doc(db, "problems", PUBLISHED), baseProblem({ status: "submitted" }));
      await setDoc(doc(db, "problems", DRAFT), baseProblem({ status: "draft" }));
    });
  });

  it("[BIT-OPD-172] lets any active member read a published posting", async () => {
    // Cross-organisation discovery is the point of the story: a solution developer
    // who did not write the posting has to be able to read it.
    const db = env.authenticatedContext(OTHER).firestore();
    await assertSucceeds(getDoc(doc(db, "problems", PUBLISHED)));
  });

  it("[BIT-OPD-173] refuses an unauthenticated read of a published posting", async () => {
    // Members only. A posting carries business context, limitations and budget,
    // which is competitive information rather than public marketing.
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "problems", PUBLISHED)));
  });

  it("[BIT-OPD-174] keeps a draft private to its owner", async () => {
    const other = env.authenticatedContext(OTHER).firestore();
    await assertFails(getDoc(doc(other, "problems", DRAFT)));

    const owner = env.authenticatedContext(ADDRESS).firestore();
    await assertSucceeds(getDoc(doc(owner, "problems", DRAFT)));
  });

  it("[BIT-OPD-175] refuses a suspended member browsing the marketplace", async () => {
    const SUSPENDED_MEMBER = `0x${"7".repeat(40)}`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", SUSPENDED_MEMBER),
        baseProfile(null, SUSPENDED_MEMBER, { suspended: true }));
    });
    const db = env.authenticatedContext(SUSPENDED_MEMBER).firestore();
    await assertFails(getDoc(doc(db, "problems", PUBLISHED)));
  });

  it("[BIT-OPD-176] still refuses a non-owner writing to a published posting", async () => {
    // Readable by every member does not mean editable by them.
    const db = env.authenticatedContext(OTHER).firestore();
    await assertFails(updateDoc(doc(db, "problems", PUBLISHED), {
      title: "Hijacked", updatedAt: serverTimestamp(),
    }));
    await assertFails(deleteDoc(doc(db, "problems", PUBLISHED)));
  });

  it("[BIT-OPD-177] refuses a signed-in wallet with no profile from reading the marketplace", async () => {
    const NO_PROFILE = `0x${"e".repeat(40)}`;
    const db = env.authenticatedContext(NO_PROFILE).firestore();
    await assertFails(getDoc(doc(db, "problems", PUBLISHED)));
  });
});
