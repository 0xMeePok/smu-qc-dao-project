import { HttpsError } from "firebase-functions/v2/https";
import { isIndependentProposal } from "./independentProposal.js";
import { canReadContent } from "./moderation.js";

const RECENT_CAP = 150;
const RELATED_CAP = 60;
const RESULT_CAP = 4;
const PUBLISHED = new Set(["submitted", "under_review", "accepted", "rejected", "withdrawn"]);
const PARENT_VISIBLE = new Set(["submitted", "open", "cancelled", "expired"]);
const BLOCKED = new Set(["hidden", "removed"]);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CATEGORIES = new Set(["gate-model", "quantum-inspired", "quantum-annealing", "hybrid", "quantum-adjacent"]);
const STOP = new Set("a an and are as at be been by can could for from has have how in into is it its of on or our that the their this to using via we which will with would your you proposal solution quantum approach research project develop development model models based study system systems".split(" "));
const SYNONYMS = Object.freeze({
  optimisation: "optimise", optimization: "optimise", optimizing: "optimise", optimising: "optimise", optimized: "optimise", optimised: "optimise", optimise: "optimise", optimize: "optimise",
  routing: "route", routes: "route", route: "route", delivery: "deliver", deliveries: "deliver", delivering: "deliver",
  scheduling: "schedule", schedules: "schedule", scheduled: "schedule", schedule: "schedule",
  cryptography: "crypto", cryptographic: "crypto", encryption: "crypto", encrypted: "crypto",
  cybersecurity: "security", cyber: "security", sensing: "sensor", sensors: "sensor",
  prediction: "predict", predictions: "predict", predictive: "predict", forecasting: "predict", forecasts: "predict",
  emissions: "emission", energies: "energy", simulations: "simulation", simulating: "simulation",
  logistics: "logistic", warehouses: "warehouse", warehousing: "warehouse", portfolio: "portfolio", portfolios: "portfolio",
});
const fail = (code, message) => { throw new HttpsError(code, message); };
/** Dynamic operational guard shared by standalone search and generation RAG. */
export function assertSimilarityEnabled() {
  if (process.env.AI_SIMILARITY_ENABLED === "false") fail("unavailable", "Similar-proposal search is temporarily unavailable.");
}
export async function retrieveAvailableSimilarProposals(options) {
  assertSimilarityEnabled();
  return retrieveSimilarProposals(options);
}

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Lexical retrieval only: synonyms unify spelling/inflection, never infer claims.
 * No external embedding service, vector index, untrusted HTML or provider call. */
export function proposalSearchTerms(text) {
  const words = String(text ?? "").normalize("NFKC").toLowerCase().replace(/[-_/]/g, " ").match(/[\p{L}\p{N}]{2,40}/gu) ?? [];
  return words.filter(word => !STOP.has(word)).map(word => SYNONYMS[word] || word).slice(0, 1000);
}

function counts(tokens) {
  const result = new Map();
  for (const term of tokens) result.set(term, (result.get(term) ?? 0) + 1);
  return result;
}

/** Score only authorised records, so private text cannot affect ranking or IDF. */
function rankProposals(records, queryTerms, category) {
  const query = new Set(queryTerms);
  const documents = records.map(row => ({ ...row, titleTerms: proposalSearchTerms(row.data.title),
    tokens: proposalSearchTerms(`${clean(row.data.title, 160)} ${clean(row.data.title, 160)} ${clean(row.data.summary, 4000)} ${clean(row.data.methodology, 1200)} ${clean(row.data.addressedProblems, 1000)}`) }));
  const frequency = new Map();
  for (const row of documents) for (const term of new Set(row.tokens)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const average = documents.reduce((sum, row) => sum + row.tokens.length, 0) / Math.max(1, documents.length);
  return documents.map(row => {
    const terms = counts(row.tokens);
    const matches = [...query].filter(term => terms.has(term));
    if (!matches.length) return null;
    const titleMatches = matches.filter(term => row.titleTerms.includes(term));
    // Generic shared categories alone do not constitute a similar proposal.
    if (matches.length < 2 && query.size > 2 && !titleMatches.length) return null;
    let score = 0;
    for (const term of matches) {
      const tf = terms.get(term), df = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * row.tokens.length / Math.max(1, average)));
    }
    score *= 0.5 + matches.length / Math.max(1, query.size);
    if (category && row.data.category === category) score *= 1.1;
    score += titleMatches.length * 0.2;
    const shown = matches.slice(0, 4);
    return { id: row.id, title: clean(row.data.title, 160) || "Untitled proposal", summary: clean(row.data.summary, 360),
      route: `proposal/${row.id}`, reason: `Related terms: ${shown.join(", ")}.`, score: Math.round(score * 1000) / 1000 };
  }).filter(Boolean).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, RESULT_CAP);
}

function validateInput({ title, summary, category, excludeId, problemId }) {
  if (typeof title !== "string" || title.length > 160 || typeof summary !== "string" || summary.length > 4000
    || typeof category !== "string" || (category && !CATEGORIES.has(category))
    || typeof excludeId !== "string" || (excludeId && !ID.test(excludeId))
    || typeof problemId !== "string" || (problemId && !ID.test(problemId))) {
    fail("invalid-argument", "Enter a valid title and proposal details to find related work.");
  }
}

/**
 * Bounded retrieval for both the AI context and the author's related-work panel.
 * The recent window is augmented by category and parent matches so an older
 * relevant proposal can still appear. All queries use single-field indexes.
 *
 * `truncated: true` always means this is a bounded candidate search, not an
 * exhaustive duplicate detector. It is constant for searches and never encodes
 * the number/existence of private or filtered records.
 *
 * Read permissions are rechecked per request. Nothing is cached across members;
 * no draft, moderated proposal or unavailable parent enters scoring or snippets.
 */
export async function retrieveSimilarProposals({ db, uid, title, summary = "", category = "", excludeId = "", problemId = "" }) {
  if (typeof uid !== "string" || !uid) fail("unauthenticated", "Sign in to find related proposals.");
  validateInput({ title, summary, category, excludeId, problemId });
  const profile = await db.collection("users").doc(uid).get();
  if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
  const queryTerms = proposalSearchTerms(`${title} ${summary}`);
  if (queryTerms.length === 0) return { items: [], truncated: false };
  const base = db.collection("proposals");
  const queries = [base.orderBy("createdAt", "desc").limit(RECENT_CAP).get()];
  if (category) queries.push(base.where("category", "==", category).limit(RELATED_CAP).get());
  if (problemId) queries.push(base.where("problemId", "==", problemId).limit(RELATED_CAP).get());
  const pages = await Promise.all(queries);
  const candidates = new Map();
  for (const page of pages) for (const doc of page.docs) {
    const data = doc.data();
    if (doc.id !== excludeId && ID.test(doc.id) && PUBLISHED.has(data.status) && !BLOCKED.has(data.moderationStatus)) {
      candidates.set(doc.id, { id: doc.id, data });
    }
  }
  const parentIds = [...new Set([...candidates.values()].filter(row => !isIndependentProposal(row.data))
    .map(row => row.data.problemId).filter(id => typeof id === "string" && ID.test(id)))];
  const parents = new Map();
  // Batch six reads at a time. Do not fan out one network request per proposal.
  for (let offset = 0; offset < parentIds.length; offset += 6) {
    const ids = parentIds.slice(offset, offset + 6);
    const snapshots = await db.getAll(...ids.map(id => db.collection("problems").doc(id)));
    snapshots.forEach((snap, index) => parents.set(ids[index], snap.exists ? snap.data() : null));
  }
  const reader = { get: async ref => ({ exists: Boolean(parents.get(ref.id)), data: () => parents.get(ref.id) }) };
  const allowed = [];
  for (const row of candidates.values()) {
    if (!isIndependentProposal(row.data)) {
      const parent = parents.get(row.data.problemId);
      // Be stricter than owner/admin restoration views: related work must never
      // redisclose a hidden/removed/private parent's proposals through AI.
      if (!parent || BLOCKED.has(parent.moderationStatus) || !PARENT_VISIBLE.has(parent.status)) continue;
      if (!await canReadContent(reader, db, "problem", parent, uid, profile.data())) continue;
    }
    if (await canReadContent(reader, db, "proposal", row.data, uid, profile.data())) allowed.push(row);
  }
  return { items: rankProposals(allowed, queryTerms, category), truncated: true };
}
