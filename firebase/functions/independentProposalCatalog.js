import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { INDEPENDENT_PROPOSAL_KIND } from "./independentProposal.js";

const PAGE = 25;
const BLOCKED = new Set(["hidden", "removed"]);
const iso = (value) => value?.toDate?.().toISOString?.() ?? null;

function listingCard(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    title: data.title ?? "",
    summary: String(data.summary ?? "").slice(0, 400),
    category: data.category ?? "",
    maturity: data.maturity ?? "",
    amount: data.amount ?? 0,
    currency: data.currency ?? "",
    expiresAt: iso(data.expiresAt),
    researcherId: data.researcherId ?? "",
    status: data.status ?? "",
  };
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
  return {
    items: page.filter((doc) => !BLOCKED.has(doc.data().moderationStatus)).map(listingCard),
    nextCursor: rows.size > PAGE && last
      ? { expiresAt: last.data().expiresAt?.toMillis?.() ?? 0, id: last.id }
      : null,
  };
}
