import fs from "node:fs";
import { before, after, test } from "node:test";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, collection, query, where, limit, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const ADMIN = `0x${"6c".repeat(20)}`;
const MEMBER = `0x${"7d".repeat(20)}`;
const SESSION = "proposalExportSessions/security-session-fixture";
let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "qc-dao-rules-test",
    firestore: { rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const [uid, role] of [[ADMIN, 1], [MEMBER, 0]]) await setDoc(doc(ctx.firestore(), "users", uid), {
      address: uid, role, fullName: "Export Session Test", organisation: "University", walletVerified: true,
      termsAcceptedAt: new Date(), termsVersion: "2026-08-24", suspended: false,
    });
    await setDoc(doc(ctx.firestore(), SESSION), { actorUid: ADMIN, lastPage: 0,
      lastResponse: "private export content", expiresAt: new Date(Date.now() + 60_000) });
  });
});
after(async () => { await env?.cleanup(); });

for (const [label, uid] of [["administrator", ADMIN], ["member", MEMBER], ["anonymous caller", null]]) {
  test(`export sessions remain server-only for an ${label}`, async () => {
    const db = uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
    if (uid) await assertSucceeds(getDoc(doc(db, "users", uid)));
    await assertFails(getDoc(doc(db, SESSION)));
    await assertFails(getDocs(query(collection(db, "proposalExportSessions"), where("actorUid", "==", ADMIN), limit(5))));
    await assertFails(setDoc(doc(db, "proposalExportSessions/forged-session"), { actorUid: uid, lastPage: 200 }));
    await assertFails(updateDoc(doc(db, SESSION), { lastPage: 200 }));
    await assertFails(deleteDoc(doc(db, SESSION)));
  });
}
