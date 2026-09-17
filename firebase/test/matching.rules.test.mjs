import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteField, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { seedPublicationFixture } from "./publication-fixture.mjs";

const AUTHOR = `0x${"82".repeat(20)}`;
const OWNER = `0x${"92".repeat(20)}`;
const FUNDER = `0x${"72".repeat(20)}`;
let env;
let serial = 0;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "qc-dao-rules-test", firestore: { rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const address of [AUTHOR, OWNER, FUNDER]) {
      await setDoc(doc(ctx.firestore(), "users", address), { address, role: 0, suspended: false, organisation: "University" });
    }
  });
});
after(async () => env?.cleanup());

async function fixture({ problemMatching, proposalMatching } = {}) {
  const id = `matching-rules-${++serial}`;
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "problems", id), {
      ownerId: OWNER, organisation: "University", title: "Routing optimisation", summary: "A measurable routing problem",
      businessContext: "Delivery routes", currentApproach: "Classical solver", currentLimitations: "Long running times",
      expectedOutcome: "Faster routes", successCriteria: "Lower distance", dataAvailability: "Anonymised routes",
      categories: ["quantum"], amount: 1500, currency: "USDC", expiresAt: new Date("2099-01-01"), status: "submitted",
      attachments: [], createdAt: new Date(), updatedAt: new Date(), ...(problemMatching ? { matching: problemMatching } : {}),
    });
    await setDoc(doc(ctx.firestore(), "proposals", id), {
      ...proposal(id), createdAt: new Date(), updatedAt: new Date(), ...(proposalMatching ? { matching: proposalMatching } : {}),
    });
  });
  return id;
}

function proposal(problemId) {
  return {
    researcherId: AUTHOR, postingOwnerId: OWNER, problemId, opportunityType: "business-problem", title: "Annealing routing",
    summary: "A measurable routing study", category: "quantum-annealing", methodology: "Compare with a classical baseline",
    suitability: "Combinatorial routing", expectedOutcomes: "Improved routing", successCriteria: "Lower travel distances",
    timeline: "12 weeks", milestones: "Baseline and validation", team: "Research team", amount: 1500, currency: "USDC",
    status: "submitted", attachments: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  };
}

async function edit(db, scope, id, patch) {
  const ref = doc(db, scope, id);
  const data = { ...patch, updatedAt: serverTimestamp() };
  // Give this attempted write the ordinary publication proof, ensuring the
  // matching guard itself protects even otherwise-authorised client edits.
  await seedPublicationFixture(env, ref, data, true);
  return updateDoc(ref, data);
}

describe("QCDAO-81..89 server-owned mock matching", () => {
  it("prevents clients from creating, replacing or deleting matching authority", async () => {
    const id = await fixture();
    for (const [scope, wallet] of [["problems", OWNER], ["proposals", AUTHOR]]) {
      const db = env.authenticatedContext(wallet).firestore();
      await assertFails(edit(db, scope, id, { matching: { mode: "mock", status: "confirmed" } }));
      await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), scope, id), { matching: { mode: "mock", status: "open" } }));
      await assertFails(edit(db, scope, id, { matching: deleteField() }));
      await assertFails(edit(db, scope, id, { "matching.status": "confirmed" }));
    }
  });

  it("blocks funded proposal changes and withdrawal while permitting receipt progress", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    for (const matching of [
      { mode: "mock", status: "funding", fundedMinor: 100 },
      ...["awaiting_confirmation", "confirmed", "voided", "cancelled", "declined"].map((status) => ({ mode: "mock", status, fundedMinor: 0 })),
      { mode: "mock", status: "funding", evaluationComplete: true, fundedMinor: 0 },
    ]) {
      const id = await fixture({ proposalMatching: matching });
      await assertFails(edit(db, "proposals", id, { amount: 2000 }));
      await assertFails(edit(db, "proposals", id, { methodology: "Different work" }));
      await assertFails(edit(db, "proposals", id, { status: "withdrawn", withdrawalReason: "Team unavailable" }));
      await assertSucceeds(edit(db, "proposals", id, { audit: {
        schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`,
        status: "queued", transactionHash: "", blockNumber: 0, attemptCount: 0, lastError: "",
      } }));
    }
  });

  it("preserves unfunded corrections and prevents problem cancellation once funding starts", async () => {
    const id = await fixture({ proposalMatching: { mode: "mock", status: "funding", fundedMinor: 0 } });
    await assertSucceeds(edit(env.authenticatedContext(AUTHOR).firestore(), "proposals", id, { methodology: "Improved baseline comparison" }));
    for (const matching of [
      { mode: "mock", status: "open", totalFundedMinor: 100 },
      ...["awaiting_confirmation", "confirmed"].map((status) => ({ mode: "mock", status, totalFundedMinor: 0 })),
    ]) {
      const funded = await fixture({ problemMatching: matching });
      const owner = env.authenticatedContext(OWNER).firestore();
      await assertFails(edit(owner, "problems", funded, { status: "cancelled", withdrawalReason: "Changed plans" }));
      await assertFails(edit(owner, "problems", funded, { title: "Different funded terms" }));
      await assertFails(edit(owner, "problems", funded, { attachments: [{ id: "newfile1", name: "terms.pdf", contentType: "application/pdf", size: 100 }] }));
      await assertSucceeds(edit(owner, "problems", funded, {}));
    }
  });

  it("refuses new submissions during selection, even after the deadline until the server settles it", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    for (const status of ["awaiting_confirmation", "confirmed", "open"]) {
      const id = await fixture({ problemMatching: { mode: "mock", status, deadlineAt: new Date(0) } });
      const data = proposal(id);
      const ref = doc(db, "proposals", `${id}-new`);
      await seedPublicationFixture(env, ref, data);
      const batch = writeBatch(db);
      batch.set(ref, data);
      batch.set(doc(db, "problems", id, "proposalAuthors", AUTHOR), { proposalId: `${id}-new` });
      if (status === "open") await assertSucceeds(batch.commit());
      else await assertFails(batch.commit());
    }
  });

  it("freezes unfunded sibling proposals during selection and after confirmation", async () => {
    const db = env.authenticatedContext(AUTHOR).firestore();
    for (const status of ["awaiting_confirmation", "confirmed"]) {
      const id = await fixture({ problemMatching: { mode: "mock", status, proposalId: "another-proposal" } });
      await assertFails(edit(db, "proposals", id, { methodology: "Different sibling terms" }));
      await assertFails(edit(db, "proposals", id, { status: "withdrawn", withdrawalReason: "Changed plans" }));
      await assertSucceeds(edit(db, "proposals", id, {}));
    }
  });

  it("cannot self-confirm a match using the legacy problem status", async () => {
    const id = await fixture();
    const owner = env.authenticatedContext(OWNER).firestore();
    await assertSucceeds(edit(owner, "problems", id, { status: "open" }));
    await assertFails(edit(owner, "problems", id, { status: "matched" }));
    for (const [before, after] of [["matched", "funded"], ["funded", "completed"]]) {
      await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "problems", id), { status: before }));
      await assertFails(edit(owner, "problems", id, { status: after }));
    }
  });

  it("accepts a fresh publication proof that omits preserved server metadata after refunds or restoration", async () => {
    const id = await fixture({ problemMatching: { mode: "mock", status: "open", totalFundedMinor: 0 }, proposalMatching: { mode: "mock", status: "funding", fundedMinor: 0 } });
    for (const [scope, uid] of [["problems", OWNER], ["proposals", AUTHOR]]) {
      await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), scope, id), {
        moderationStatus: "visible", moderation: { lastAction: "restore", previousStatus: "submitted", reason: "no_violation" },
      }));
      const ref = doc(env.authenticatedContext(uid).firestore(), scope, id);
      const data = { title: "Corrected after restoration", updatedAt: serverTimestamp() };
      await seedPublicationFixture(env, ref, data, true);
      await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "publicationProofs", `${scope}_${id}`), {
        "record.matching": deleteField(), "record.moderationStatus": deleteField(), "record.moderation": deleteField(),
      }));
      await assertSucceeds(updateDoc(ref, data));
      await assertFails(updateDoc(ref, { ...data, matching: { status: "confirmed" } }));
    }
  });

  it("keeps mock balances server-only and private proposal ACLs intact", async () => {
    const id = await fixture();
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "mockFunding", id), { funderId: FUNDER, proposalId: id, status: "pledged", amountMinor: 100 }));
    const db = env.authenticatedContext(FUNDER).firestore();
    await assertFails(getDoc(doc(db, "mockFunding", id)));
    await assertFails(getDocs(collection(db, "mockFunding")));
    await assertFails(updateDoc(doc(db, "mockFunding", id), { status: "locked" }));
    await assertFails(setDoc(doc(db, "mockFunding", `${id}-forged`), { funderId: FUNDER, amountMinor: 999999 }));
    await assertSucceeds(getDoc(doc(db, "proposals", id)));
    await assertSucceeds(getDoc(doc(env.authenticatedContext(OWNER).firestore(), "proposals", id)));
  });
});
