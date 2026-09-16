import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const AUTHOR = `0x${"a4".repeat(20)}`, ADMIN = `0x${"b4".repeat(20)}`, SUSPENDED = `0x${"c4".repeat(20)}`;
const protectedCollections = ["moderationQueue", "contentReports", "moderationEvents", "moderationNotifications",
  "moderationReportLimits", "moderationStats", "matchingNotificationJobs"];
let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "qcdao-moderation-boundary-rules", firestore: { rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") } });
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const uid of [AUTHOR, ADMIN, SUSPENDED]) await setDoc(doc(db, "users", uid), {
      address: uid, organisation: "University", role: uid === AUTHOR ? 0 : 1, suspended: uid === SUSPENDED,
    });
    for (const name of protectedCollections) await setDoc(doc(db, name, "private"), {
      recipientId: AUTHOR, reporterId: AUTHOR, count: 20, day: "2026-09-15", status: "pending",
    });
    await setDoc(doc(db, "comments", "private"), { authorId: AUTHOR, problemId: "p", proposalId: "private-proposal", text: "Private proposal discussion" });
  });
});
after(async () => env?.cleanup());

describe("moderation server-only trust boundaries", () => {
  for (const [label, uid] of [["author", AUTHOR], ["administrator", ADMIN], ["suspended administrator", SUSPENDED], ["missing profile", "0x" + "d4".repeat(20)], ["anonymous", null]]) {
    it(`${label} cannot read, forge, rewrite or delete private moderation state or reset the daily report quota`, async () => {
      const db = uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
      for (const name of protectedCollections) {
        const ref = doc(db, name, "private");
        await assertFails(getDoc(ref));
        await assertFails(getDocs(collection(db, name)));
        await assertFails(setDoc(doc(db, name, "forged"), { recipientId: uid, count: 0 }));
        await assertFails(updateDoc(ref, { count: 0, day: "2026-09-16", status: "complete" }));
        await assertFails(deleteDoc(ref));
      }
    });
  }
  it("private proposal comments stay callable-only even for their author and administrator", async () => {
    for (const uid of [AUTHOR, ADMIN]) {
      const db = env.authenticatedContext(uid).firestore();
      await assertFails(getDoc(doc(db, "comments", "private")));
      await assertFails(getDocs(collection(db, "comments")));
      await assertFails(updateDoc(doc(db, "comments", "private"), { moderationStatus: "visible" }));
    }
  });
});
