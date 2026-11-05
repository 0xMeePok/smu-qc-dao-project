import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpsError } from "firebase-functions/v2/https";
import { isIndependentProposal } from "./independentProposal.js";
import { isAuthTimeRevoked, SESSION_REVOCATIONS_COLLECTION } from "./adminActions.js";

export const MAX_PROPOSAL_PDF_BYTES = 10 * 1024 * 1024;
const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const WALLET = /^0x[0-9a-f]{40}$/;
const PUBLISHED = new Set(["submitted", "under_review", "accepted", "rejected", "withdrawn"]);
const PARENT_VISIBLE = new Set(["submitted", "open", "cancelled", "expired"]);
const blocked = (record) => ["hidden", "removed"].includes(record?.moderationStatus);
const deny = () => { throw new HttpsError("permission-denied", "You do not have permission to use this file."); };

/** Read live authorization state; cached problemBrowsable is never byte authority. */
export async function authorizeProposalAttachment({ db, uid, authTime, proposalId }) {
  return db.runTransaction(async (tx) => {
    const [profileDoc, proposalDoc, cutoff] = await Promise.all([
      tx.get(db.collection("users").doc(uid)), tx.get(db.collection("proposals").doc(proposalId)),
      tx.get(db.collection(SESSION_REVOCATIONS_COLLECTION).doc(uid)),
    ]);
    const profile = profileDoc.data();
    if (!profileDoc.exists || profile.suspended
      || isAuthTimeRevoked(authTime, profile.sessionsValidAfterEpoch, cutoff.data()?.sessionsValidAfterEpoch)) deny();
    if (!proposalDoc.exists) throw new HttpsError("not-found", "That proposal is no longer available.");
    const proposal = proposalDoc.data();
    if (!WALLET.test(proposal.researcherId ?? "")) deny();
    if (proposal.researcherId === uid || profile.role === 1) return proposal.researcherId;
    if (!PUBLISHED.has(proposal.status) || blocked(proposal)) deny();
    // Sponsors retain access to an unmoderated submitted child even when the
    // parent is removed; drafts and child moderation never take this branch.
    if (proposal.postingOwnerId === uid || isIndependentProposal(proposal)) return proposal.researcherId;
    if (!RECORD_ID.test(proposal.problemId ?? "")) deny();
    const parent = await tx.get(db.collection("problems").doc(proposal.problemId));
    if (!parent.exists || !PARENT_VISIBLE.has(parent.data().status) || blocked(parent.data())) deny();
    return proposal.researcherId;
  });
}

const STATUS = { "invalid-argument": 400, unauthenticated: 401, "permission-denied": 403,
  "not-found": 404, "failed-precondition": 409, unavailable: 503 };

/** Resolve an exact configured origin; only local emulators accept loopback origins. */
function resolveAttachmentCorsOrigin(req, allowedOrigins, emulator) {
  const requestedOrigin = req.headers.origin;
  if (requestedOrigin === undefined || requestedOrigin === "") return undefined;
  if (typeof requestedOrigin !== "string") return null;
  const configuredOrigin = allowedOrigins.find((candidate) => candidate === requestedOrigin);
  if (configuredOrigin !== undefined) return configuredOrigin;
  if (emulator && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(requestedOrigin)) return requestedOrigin;
  return null;
}

/**
 * A bounded Buffer response keeps a full 10 MiB PDF out of callable JSON/base64
 * bodies and below the non-streaming response limit (32 MB). Do not pipe the
 * object into the HTTP response: streaming responses have a lower 10 MB limit.
 * requireMember supplies the application's two session cutoffs and maintenance
 * gate. ID-token and App Check verification are explicit for this onRequest API.
 */
export function createProposalAttachmentHandler({ db, getBucket, requireMember, verifyIdToken,
  verifyAppCheckToken, emulator = false, allowedOrigins = [] }) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const allowedOrigin = resolveAttachmentCorsOrigin(req, allowedOrigins, emulator);
    if (allowedOrigin === null) return res.status(403).json({ error: "Origin is not allowed." });
    if (allowedOrigin !== undefined) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, X-Firebase-AppCheck");
      return res.status(204).end();
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      return res.status(405).json({ error: "Use GET to download a PDF." });
    }
    let source;
    try {
      const bearer = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "");
      if (!bearer) throw new HttpsError("unauthenticated", "Sign in to use this file.");
      let token;
      try { token = await verifyIdToken(bearer[1]); }
      catch { throw new HttpsError("unauthenticated", "Sign in again to use this file."); }
      if (!WALLET.test(token?.uid ?? "")) throw new HttpsError("unauthenticated", "Sign in to use this file.");
      if (!emulator) {
        const appToken = req.headers["x-firebase-appcheck"];
        if (typeof appToken !== "string" || !appToken) deny();
        try { await verifyAppCheckToken(appToken); } catch { deny(); }
      }
      const uid = await requireMember({ auth: { uid: token.uid, token } });
      const { proposalId, attachmentId } = req.query;
      if (!RECORD_ID.test(proposalId ?? "") || typeof proposalId !== "string"
        || !ATTACHMENT_ID.test(attachmentId ?? "") || typeof attachmentId !== "string"
        || Object.keys(req.query).some((key) => !["proposalId", "attachmentId"].includes(key))) {
        throw new HttpsError("invalid-argument", "Choose a valid proposal PDF.");
      }
      const ownerId = await authorizeProposalAttachment({ db, uid, authTime: token.auth_time ?? 0, proposalId });
      // The caller supplies neither an owner nor an arbitrary object path. Access
      // covers immutable retained PDFs under this same authorized proposal too.
      const path = `proposals/${ownerId}/${proposalId}/${attachmentId}.pdf`;
      const bucket = getBucket();
      const [metadata] = await bucket.file(path).getMetadata();
      const size = Number(metadata.size);
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PROPOSAL_PDF_BYTES
        || metadata.contentType !== "application/pdf" || !metadata.generation) {
        throw new HttpsError("failed-precondition", "That PDF has invalid stored metadata.");
      }
      if (res.destroyed) return;
      const bytes = Buffer.alloc(size);
      source = bucket.file(path, { generation: metadata.generation }).createReadStream();
      let transferred = 0;
      const bounded = new Writable({ write(chunk, _encoding, callback) {
        transferred += chunk.length;
        if (transferred > size || transferred > MAX_PROPOSAL_PDF_BYTES) return callback(new Error("PDF size mismatch"));
        bytes.set(chunk, transferred - chunk.length);
        callback();
      }, final(callback) {
        callback(transferred === size ? null : new Error("PDF size mismatch"));
      } });
      const disconnect = () => source.destroy();
      res.once("close", disconnect);
      try { await pipeline(source, bounded); }
      finally { res.off("close", disconnect); }
      if (res.destroyed) return;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(size));
      res.setHeader("Content-Disposition", `attachment; filename="${attachmentId}.pdf"`);
      // One raw Buffer response, with no chunks or headers emitted during reads.
      return res.end(bytes);
    } catch (error) {
      source?.destroy();
      if (res.destroyed || res.headersSent) { if (!res.destroyed) res.destroy(); return; }
      res.removeHeader("Content-Length");
      res.removeHeader("Content-Disposition");
      const status = Number(error?.code) === 404 ? 404 : STATUS[error?.code] ?? 500;
      return res.status(status).json({ error: status === 500 ? "The PDF download failed. Please try again." :
        status === 404 ? "That file is no longer stored." : error.message });
    }
  };
}
