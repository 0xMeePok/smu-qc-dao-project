import { doc, getDoc, setDoc, deleteField, Timestamp } from "firebase/firestore";
import { PUBLISH_VALIDATION, isPublishableProblem } from "../functions/publicationValidation.js";

// attestPublication stores expiresAt as a Timestamp; the validator only needs
// toMillis(), which the client Timestamp provides too.
function asTimestamp(value) {
  return value instanceof Date ? Timestamp.fromDate(value) : value;
}

// Existing schema/role tests exercise the Firestore half of a chain-first write.
// Seed the trusted function's output explicitly; separate security tests send
// raw writes without this fixture to prove that bypasses are denied.
export async function seedPublicationFixture(env, reference, patch, update = false) {
  const [scope, id, extra] = reference.path.split("/");
  if (extra || !["problems", "proposals"].includes(scope)) return;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const existing = update ? await getDoc(doc(db, scope, id)) : null;
    const next = existing?.exists() ? existing.data() : {};
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split(".");
      let target = next;
      for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      if (value?.isEqual?.(deleteField())) delete target[parts.at(-1)];
      else target[parts.at(-1)] = value;
    }
    const uid = next[scope === "problems" ? "ownerId" : "researcherId"];
    if (!uid) return;
    await setDoc(doc(db, "recordReservations", `${scope}_${id}`), { uid });
    const { createdAt, updatedAt, audit, ...record } = next;
    // Same marker attestPublication sets, computed by the same validator, so a
    // test that sends an invalid posting still sees it refused.
    const profile = scope === "problems" ? await getDoc(doc(db, "users", uid)) : null;
    const publishable = scope === "problems" && isPublishableProblem(
      { ...record, expiresAt: asTimestamp(record.expiresAt) },
      { uid, profileOrganisation: profile?.data()?.organisation },
    );
    await setDoc(doc(db, "publicationProofs", `${scope}_${id}`), {
      uid, record, transactionHash: audit?.transactionHash ?? "",
      ...(publishable ? { validation: PUBLISH_VALIDATION } : {}),
    });
  });
}
