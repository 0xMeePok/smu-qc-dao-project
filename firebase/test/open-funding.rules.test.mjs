import fs from "node:fs";
import { after, before, test } from "node:test";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const owner = `0x${"b".repeat(40)}`, researcher = `0x${"a".repeat(40)}`, admin = `0x${"9".repeat(40)}`;
let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "qc-dao-open-funding-rules-test", firestore: {
    rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
  } });
  await env.withSecurityRulesDisabled(async context => {
    for (const uid of [owner, researcher, admin]) await setDoc(doc(context.firestore(), "users", uid), {
      address: uid, fullName: "Grant test", organisation: "Research", role: uid === admin ? 1 : 0, suspended: false,
    });
    await setDoc(doc(context.firestore(), "openFundingSummaries", "verified-grant"), { owner, totalDeposited: "100000000000", available: "0" });
  });
});
after(async () => env?.cleanup());

test("grant financial projections cannot be read, listed, created, edited or deleted through browser SDKs", async () => {
  for (const uid of [owner, researcher, admin, null]) {
    const db = uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
    const ref = doc(db, "openFundingSummaries", "verified-grant");
    await assertFails(getDoc(ref)); await assertFails(getDocs(collection(db, "openFundingSummaries")));
    await assertFails(setDoc(doc(db, "openFundingSummaries", "fake"), { owner, totalDeposited: "1" }));
    await assertFails(updateDoc(ref, { available: "100000000000" })); await assertFails(deleteDoc(ref));
  }
});
