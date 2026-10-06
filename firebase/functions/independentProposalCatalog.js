import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { INDEPENDENT_PROPOSAL_KIND } from "./independentProposal.js";

const PAGE = 25;
const BLOCKED = new Set(["hidden", "removed"]);
const iso = (value) => value?.toDate?.().toISOString?.() ?? null;

function organisationName(profile) {
  return String(profile?.organisation ?? "").trim().slice(0, 200);
}

function listingCard(doc, organisations) {
  const data = doc.data();
  const researcherId = data.researcherId ?? "";
  return {
    id: doc.id,
    title: data.title ?? "",
    summary: String(data.summary ?? "").slice(0, 400),
    category: data.category ?? "",
    maturity: data.maturity ?? "",
    amount: data.amount ?? 0,
    currency: data.currency ?? "",
    expiresAt: iso(data.expiresAt),
    researcherId,
    organisation: organisations.get(String(researcherId).trim().toLowerCase()) ?? "",
    status: data.status ?? "",
  };
}

/** One public-profile read per author. The proposal document does not store organisation. */
async function authorOrganisations(db, docs) {
  const ids = [...new Set(docs
    .map((doc) => String(doc.data().researcherId ?? "").trim().toLowerCase())
    .filter(Boolean))];
  const snaps = await Promise.all(ids.map((id) => db.collection("publicProfiles").doc(id).get()));
  return new Map(ids.map((id, index) => [
    id,
    snaps[index].exists ? organisationName(snaps[index].data()) : "",
  ]));
}

/**
 * Published, unexpired independent listings for onboarded members.
 * Client list of `proposals` stays author/sponsor-only so this catalog cannot be
 * replaced by a collection query.
 */
export async function listIndependentListings({ db, cursor = null, now = Timestamp.now() }) {
  let query = db.collection("proposals")
    .where("proposalKind", "==", INDEPENDENT_PROPOSAL_KIND)
    .where("status", "==", "submitted")
    .where("expiresAt", ">", now)
    .orderBy("expiresAt", "asc")
    .orderBy(FieldPath.documentId(), "asc")
    .limit(PAGE + 1);
  if (Number.isFinite(cursor?.expiresAt) && cursor?.id) {
    query = query.startAfter(Timestamp.fromMillis(cursor.expiresAt), cursor.id);
  }
  const rows = await query.get();
  const page = rows.docs.slice(0, PAGE);
  const last = page.at(-1);
  const visible = page.filter((doc) => !BLOCKED.has(doc.data().moderationStatus));
  const organisations = await authorOrganisations(db, visible);
  return {
    items: visible.map((doc) => listingCard(doc, organisations)),
    nextCursor: rows.size > PAGE && last
      ? { expiresAt: last.data().expiresAt?.toMillis?.() ?? 0, id: last.id }
      : null,
  };
}
