import fs from "node:fs";
import { after, before, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";

const AUTHOR = `0x${"ab".repeat(20)}`, OWNER = `0x${"bc".repeat(20)}`, MEMBER = `0x${"cd".repeat(20)}`;
const ADMIN = `0x${"de".repeat(20)}`, SUSPENDED = `0x${"ef".repeat(20)}`, UNREGISTERED = `0x${"fa".repeat(20)}`;
let env;
const dbFor = uid => uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
const signal = (uid, type, id, key = "latest") => doc(dbFor(uid), type, id, "activity", key);
before(async () => {
  env = await initializeTestEnvironment({ projectId: "qc-dao-rules-test", firestore: {
    rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
  } });
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    for (const uid of [AUTHOR, OWNER, MEMBER, ADMIN, SUSPENDED]) await setDoc(doc(db, "users", uid), {
      address: uid, role: uid === ADMIN ? 1 : 0, suspended: uid === SUSPENDED,
    });
    for (const status of ["submitted", "draft", "cancelled", "expired"]) {
      await setDoc(doc(db, "problems", `activity-${status}`), { ownerId: OWNER, status });
      await setDoc(doc(db, "problems", `activity-${status}`, "activity", "latest"), { comments: 2, funding: 3 });
      await setDoc(doc(db, "proposals", `activity-${status}`), {
        researcherId: AUTHOR, postingOwnerId: OWNER, problemId: `activity-${status}`, status: status === "draft" ? "draft" : "submitted",
      });
      await setDoc(doc(db, "proposals", `activity-${status}`, "activity", "latest"), { comments: 2, funding: 3 });
    }
    await setDoc(doc(db, "proposals", "activity-independent"), { researcherId: AUTHOR, proposalKind: "independent", status: "submitted" });
    await setDoc(doc(db, "proposals", "activity-hidden"), { researcherId: AUTHOR, proposalKind: "independent", status: "submitted", moderationStatus: "hidden" });
    for (const id of ["activity-independent", "activity-hidden", "activity-orphan"]) {
      await setDoc(doc(db, "proposals", id, "activity", "latest"), { funding: 1 });
    }
  });
});
after(async () => env?.cleanup());

test("activity get follows registered active parent viewers including closed and independent records", async () => {
  for (const uid of [AUTHOR, OWNER, MEMBER, ADMIN]) {
    for (const type of ["proposals", "problems"]) {
      for (const status of ["submitted", "cancelled", "expired"]) await assertSucceeds(getDoc(signal(uid, type, `activity-${status}`)));
    }
    await assertSucceeds(getDoc(signal(uid, "proposals", "activity-independent")));
  }
  for (const uid of [null, SUSPENDED, UNREGISTERED]) {
    for (const type of ["proposals", "problems"]) await assertFails(getDoc(signal(uid, type, "activity-submitted")));
  }
});

test("activity remains private on drafts, hidden proposals, missing parents and arbitrary signal names", async () => {
  for (const type of ["problems", "proposals"]) {
    await assertFails(getDoc(signal(MEMBER, type, "activity-draft")));
    await assertSucceeds(getDoc(signal(OWNER, type, "activity-draft")));
    await assertFails(getDoc(signal(MEMBER, type, "activity-submitted", "secret")));
  }
  await assertSucceeds(getDoc(signal(AUTHOR, "proposals", "activity-draft")));
  await assertFails(getDoc(signal(MEMBER, "proposals", "activity-hidden")));
  await assertSucceeds(getDoc(signal(AUTHOR, "proposals", "activity-hidden")));
  for (const uid of [MEMBER, ADMIN]) await assertFails(getDoc(signal(uid, "proposals", "activity-orphan")));
});

test("no activity listing or client writes are allowed, even for administrators", async () => {
  for (const uid of [OWNER, AUTHOR, MEMBER, ADMIN]) for (const type of ["proposals", "problems"]) {
    const ref = signal(uid, type, "activity-submitted");
    await assertFails(getDocs(collection(dbFor(uid), type, "activity-submitted", "activity")));
    await assertFails(setDoc(ref, { comments: 99 }));
    await assertFails(updateDoc(ref, { funding: 99 }));
    await assertFails(deleteDoc(ref));
  }
});
