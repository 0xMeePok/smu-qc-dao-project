import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, limit, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";

const OWNER = `0x${"93".repeat(20)}`;
const AUTHOR = `0x${"83".repeat(20)}`;
const MEMBER = `0x${"73".repeat(20)}`;
const ADMIN = `0x${"63".repeat(20)}`;
const SUSPENDED = `0x${"53".repeat(20)}`;
let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "qc-dao-rules-test", firestore: { rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const address of [OWNER, AUTHOR, MEMBER, ADMIN, SUSPENDED]) await setDoc(doc(db, "users", address), {
      address, organisation: "University", role: [ADMIN, SUSPENDED].includes(address) ? 1 : 0, suspended: address === SUSPENDED,
    });
    for (const visibility of ["hidden", "removed", "visible"]) {
      const id = `moderation-${visibility}`;
      await setDoc(doc(db, "problems", id), {
        ownerId: OWNER, status: visibility === "visible" ? "submitted" : `moderated_${visibility}`, moderationStatus: visibility,
        title: "Moderation test problem", createdAt: new Date(), updatedAt: new Date(),
      });
      await setDoc(doc(db, "problems", id, "revisions", "before-moderation"), { ownerId: OWNER, status: "submitted", title: "Hidden historical problem text" });
      await setDoc(doc(db, "proposals", id), {
        researcherId: AUTHOR, postingOwnerId: visibility === "visible" ? OWNER : "", problemId: id,
        status: visibility === "visible" ? "submitted" : `moderated_${visibility}`, moderationStatus: visibility,
        title: "Moderation test proposal", createdAt: new Date(), updatedAt: new Date(),
      });
      await setDoc(doc(db, "proposals", id, "revisions", "before-moderation"), {
        researcherId: AUTHOR, postingOwnerId: OWNER, status: "submitted", title: "Hidden historical proposal text",
      });
    }
    await setDoc(doc(db, "contentReports", "report-private"), { reporterId: MEMBER, reason: "misleading" });
    await setDoc(doc(db, "moderationNotifications", "notice-private"), { recipientId: AUTHOR, reason: "misleading" });
  });
});
after(async () => env?.cleanup());
const client = (uid) => env.authenticatedContext(uid).firestore();

describe("QCDAO-87..89 moderation visibility and authority", () => {
  it("hides and removes problems from members while preserving author and admin access", async () => {
    for (const status of ["hidden", "removed"]) {
      const id = `moderation-${status}`;
      await assertFails(getDoc(doc(client(MEMBER), "problems", id)));
      await assertFails(getDoc(doc(client(SUSPENDED), "problems", id)));
      await assertSucceeds(getDoc(doc(client(OWNER), "problems", id)));
      await assertSucceeds(getDoc(doc(client(ADMIN), "problems", id)));
      await assertFails(getDoc(doc(client(MEMBER), "problems", id, "revisions", "before-moderation")));
      await assertSucceeds(getDoc(doc(client(OWNER), "problems", id, "revisions", "before-moderation")));
      await assertSucceeds(getDoc(doc(client(ADMIN), "problems", id, "revisions", "before-moderation")));
    }
    await assertSucceeds(getDocs(query(collection(client(MEMBER), "problems"), where("status", "in", ["submitted", "open", "cancelled"]), limit(50))));
    await assertSucceeds(getDoc(doc(client(MEMBER), "problems", "moderation-visible")));
  });

  it("removes hidden proposal sponsor access including old revisions, while restored proposals remain readable", async () => {
    for (const status of ["hidden", "removed"]) {
      const id = `moderation-${status}`;
      await assertFails(getDoc(doc(client(OWNER), "proposals", id)));
      await assertFails(getDoc(doc(client(MEMBER), "proposals", id)));
      await assertSucceeds(getDoc(doc(client(AUTHOR), "proposals", id)));
      await assertSucceeds(getDoc(doc(client(ADMIN), "proposals", id)));
      await assertFails(getDocs(query(collection(client(OWNER), "proposals", id, "revisions"), where("postingOwnerId", "==", OWNER))));
      await assertSucceeds(getDoc(doc(client(AUTHOR), "proposals", id, "revisions", "before-moderation")));
      await assertSucceeds(getDoc(doc(client(ADMIN), "proposals", id, "revisions", "before-moderation")));
    }
    const inbox = await assertSucceeds(getDocs(query(collection(client(OWNER), "proposals"), where("postingOwnerId", "==", OWNER))));
    if (inbox.docs.some((row) => row.data().moderationStatus === "hidden" || row.data().moderationStatus === "removed")) throw new Error("Hidden proposal leaked through sponsor query");
    await assertSucceeds(getDoc(doc(client(OWNER), "proposals", "moderation-visible")));
  });

  it("refuses client restoration, reason tampering, reports, notification reads and admin direct writes", async () => {
    for (const uid of [AUTHOR, ADMIN]) {
      await assertFails(updateDoc(doc(client(uid), "proposals", "moderation-hidden"), { status: "submitted", postingOwnerId: OWNER, moderationStatus: "visible", updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(doc(client(uid), "proposals", "moderation-hidden"), { "moderation.reason": "no_violation" }));
      for (const collectionName of ["moderationQueue", "contentReports", "moderationEvents", "moderationStats", "moderationNotifications"]) {
        await assertFails(setDoc(doc(client(uid), collectionName, "forged"), { status: "restored", reporterId: uid }));
        await assertFails(getDocs(collection(client(uid), collectionName)));
      }
      await assertFails(getDoc(doc(client(uid), "contentReports", "report-private")));
      await assertFails(getDoc(doc(client(uid), "moderationNotifications", "notice-private")));
    }
  });

  it("refuses grading hidden or removed proposals", async () => {
    for (const status of ["hidden", "removed"]) await assertFails(setDoc(doc(client(MEMBER), "evaluations", `moderation-eval-${status}`), {
      evaluatorId: MEMBER, proposalId: `moderation-${status}`, title: "Evaluation", score: 80, feedback: "A useful approach",
      status: "draft", createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
  });
});
