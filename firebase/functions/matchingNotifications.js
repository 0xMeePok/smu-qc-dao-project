import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { writeMemberNotice } from "./moderation.js";

const PAGE_SIZE = 100;
const JOBS = "matchingNotificationJobs";
const DECISIONS = new Set(["owner_selected", "owner_confirmed", "creator_confirmed", "match_confirmed", "owner_declined", "creator_declined", "confirmation_expired", "admin_force_expired", "posting_expired"]);
const GATES = new Set(["funding_target_reached"]);
const idFor = (eventId, recipientId) => createHash("sha256").update(`${eventId}:${recipientId}`).digest("hex");

function acceptanceDeadline(event) {
  const date = event.deadlineAt?.toDate?.();
  const deadline = date ? `by ${date.toISOString().replace("T", " ").replace(".000Z", " UTC")}`
    : "within the acceptance window shown on the posting";
  return `${deadline}${event.deadlineLimitedByPosting ? " (shortened to the original posting deadline)" : ""}`;
}

function messageFor(job, recipientId) {
  const deadline = acceptanceDeadline(job.event);
  switch (job.event.type) {
    case "owner_selected": return recipientId === job.selectedCreatorId
      ? `Your proposal was selected and accepted by the problem owner. Accept ${deadline} to confirm the match. Either party may reject during this window; rejection refunds this proposal's mock funding. Expiry invalidates the posting and refunds all outstanding mock contributions.`
      : `The problem owner selected and accepted a proposal. Its creator must accept ${deadline}, and either party can reject during the window. Mock funding for all proposals is paused until the match is resolved.`;
    case "owner_confirmed": return "The problem owner accepted the selected match. Funds lock only when both parties accept before the recorded deadline.";
    case "creator_confirmed": return "The selected creator accepted the match. Funds lock only when both parties accept before the recorded deadline.";
    case "match_confirmed": return "Both parties accepted the match. Its mock funding is locked; other proposals are cancelled and their mock contributions refunded.";
    case "owner_declined": return "The problem owner rejected the selection. That proposal's mock contributions were refunded. Other proposals reopened until the original posting deadline with their funding and evaluations retained.";
    case "creator_declined": return "The selected creator declined. That proposal's mock contributions were refunded. Other proposals reopened until the original posting deadline with their funding and evaluations retained.";
    case "confirmation_expired":
    case "admin_force_expired": return "The selected proposal's confirmation window expired. The posting is invalidated and closed to funding and selection. All outstanding mock contributions for its proposals were refunded.";
    case "posting_expired": return "The original posting deadline expired. The posting is invalidated and closed to funding and selection. All outstanding mock contributions for its proposals were refunded.";
    default: return "A proposal has reached its funding target. Selecting it with a rationale records your acceptance and starts its creator's acceptance window: up to seven days, capped by the original posting deadline. Either party can reject during the window.";
  }
}

/** An immutable matching event creates one resumable delivery job. */
export async function enqueueMatchingNotifications({ db, eventId, now = Timestamp.now() }) {
  return db.runTransaction(async tx => {
    const jobRef = db.collection(JOBS).doc(eventId);
    const [existing, snapshot] = await Promise.all([tx.get(jobRef), tx.get(db.collection("matchingEvents").doc(eventId))]);
    if (existing.exists) return { queued: existing.data().status !== "complete" };
    if (!snapshot.exists) return { queued: false };
    const event = snapshot.data();
    if (!DECISIONS.has(event.type) && !GATES.has(event.type)) return { queued: false };
    const [problem, selected] = await Promise.all([
      tx.get(db.collection("problems").doc(event.problemId)),
      event.proposalId ? tx.get(db.collection("proposals").doc(event.proposalId)) : Promise.resolve(null),
    ]);
    // Funding readiness notifies only the owner; expert evaluation is optional.
    const gatesReady = ["submitted", "open"].includes(problem.data()?.status)
      && (!problem.data()?.expiresAt?.toMillis?.() || problem.data().expiresAt.toMillis() > now.toMillis())
      && !problem.data()?.moderated && !selected?.data()?.moderated
      && ["submitted", "under_review"].includes(selected?.data()?.status)
      && !problem.data()?.acceptedProposalId && !problem.data()?.acceptedSolutionId && !problem.data()?.hasAcceptedSolution
      && (problem.data()?.matching?.status || "open") === "open"
      && !["hidden", "removed"].includes(problem.data()?.moderationStatus)
      && !["hidden", "removed"].includes(selected?.data()?.moderationStatus)
      && (selected?.data()?.matching?.status || "funding") === "funding"
      && (selected.data().matching?.fundedMinor || 0) >= Math.round(Number(selected.data().amount) * 100)
      && Number(selected.data().amount) > 0;
    const gateOnly = GATES.has(event.type);
    const noticeKey = gateOnly ? `ready:${event.problemId}:${event.proposalId}:${selected?.data()?.matching?.updatedAt?.toMillis?.() || 0}` : eventId;
    tx.set(jobRef, { eventId, noticeKey, event: { type: event.type, problemId: event.problemId, proposalId: event.proposalId || null,
      createdAt: event.createdAt || now, deadlineAt: event.deadlineAt || null,
      deadlineLimitedByPosting: event.deadlineLimitedByPosting === true }, ownerId: problem.data()?.ownerId || null,
      selectedCreatorId: selected?.data()?.researcherId || null, gateOnly,
      phase: "owners", cursor: null, status: gateOnly && !gatesReady ? "complete" : "pending",
      deliveredCount: 0, scannedCount: 0, createdAt: now, updatedAt: now });
    return { queued: !gateOnly || gatesReady };
  });
}

/** At most 100 source records and 100 notifications per atomic page. */
export async function processMatchingNotificationPage({ db, eventId, now = Timestamp.now() }) {
  return db.runTransaction(async tx => {
    const jobRef = db.collection(JOBS).doc(eventId), snapshot = await tx.get(jobRef);
    if (!snapshot.exists || snapshot.data().status === "complete") return { complete: true, delivered: 0 };
    const job = snapshot.data();
    let recipients, nextPhase, nextCursor = null, scanned = 0;
    if (job.phase === "owners") {
      recipients = [job.ownerId, ...(!job.gateOnly ? [job.selectedCreatorId] : [])].filter(Boolean);
      nextPhase = job.gateOnly ? "done" : "authors";
    } else {
      let query = db.collection(job.phase === "authors" ? "proposals" : "mockFunding")
        .where("problemId", "==", job.event.problemId).orderBy("__name__");
      if (job.cursor) query = query.startAfter(job.cursor);
      const rows = await tx.get(query.limit(PAGE_SIZE));
      scanned = rows.size;
      recipients = rows.docs.filter(doc => {
        const data = doc.data();
        // A later-created proposal or contribution was not part of this event.
        if (data.createdAt?.toMillis?.() > job.event.createdAt.toMillis()) return false;
        return job.phase !== "authors" || data.status !== "draft";
      }).map(doc => doc.data()[job.phase === "authors" ? "researcherId" : "funderId"]).filter(Boolean);
      nextPhase = rows.size < PAGE_SIZE ? (job.phase === "authors" ? "funders" : "done") : job.phase;
      nextCursor = nextPhase === job.phase ? rows.docs.at(-1).id : null;
    }
    recipients = [...new Set(recipients)];
    const refs = recipients.map(uid => db.collection("moderationNotifications").doc(idFor(job.noticeKey || eventId, uid)));
    const existing = await Promise.all(refs.map(ref => tx.get(ref)));
    let delivered = 0;
    for (let i = 0; i < refs.length; i++) {
      if (existing[i].exists) continue; // Preserve acknowledgements and dedupe cross-role recipients.
      tx.set(refs[i], { recipientId: recipients[i], kind: "matching", mode: "mock", eventId,
        problemId: job.event.problemId, proposalId: job.event.proposalId, contentType: "problem", contentId: job.event.problemId,
        title: "Mock matching update", message: messageFor(job, recipients[i]),
        navigationTarget: `posting/${job.event.problemId}`, link: `#/posting/${job.event.problemId}`,
        createdAt: job.event.createdAt, deliveredAt: now, readAt: null });
      delivered += 1;
    }
    const complete = nextPhase === "done";
    tx.update(jobRef, { phase: nextPhase, cursor: nextCursor, status: complete ? "complete" : "pending",
      deliveredCount: job.deliveredCount + delivered, scannedCount: job.scannedCount + scanned, updatedAt: now });
    return { complete, delivered };
  });
}

export async function resumeMatchingNotifications({ db, now = Timestamp.now() }) {
  const jobs = await db.collection(JOBS).where("status", "==", "pending").orderBy("updatedAt").limit(20).get();
  let delivered = 0;
  // Persisted updatedAt rotates a large job behind older work, avoiding starvation.
  for (const job of jobs.docs) delivered += (await processMatchingNotificationPage({ db, eventId: job.id, now })).delivered;
  return { processed: jobs.size, delivered };
}

const NEARING_MS = 24 * 60 * 60 * 1000;

export async function remindNearingApprovalWindows({ db, now = Timestamp.now() }) {
  const horizon = Timestamp.fromMillis(now.toMillis() + NEARING_MS);
  const rows = await db.collection("problems").where("matching.deadlineAt", "<=", horizon).limit(100).get();
  let notified = 0;
  for (const doc of rows.docs) {
    const problem = doc.data();
    const matching = problem.matching || {};
    const deadlineMs = matching.deadlineAt?.toMillis?.() ?? 0;
    if (matching.status !== "awaiting_confirmation" || deadlineMs <= now.toMillis()) continue;
    const proposalId = matching.proposalId || null;
    const selectionId = matching.selectionId || proposalId;
    if (!selectionId) continue;
    const selected = proposalId ? await db.collection("proposals").doc(proposalId).get() : null;
    const recipients = [...new Set([problem.ownerId, selected?.data()?.researcherId].filter(Boolean))];
    const title = String(problem.title || "Posting").slice(0, 160);
    const date = matching.deadlineAt?.toDate?.();
    const when = date ? date.toISOString().replace("T", " ").replace(".000Z", " UTC") : "soon";
    for (const uid of recipients) {
      const written = await writeMemberNotice({
        db, now, createdAt: now, id: idFor(`nearing:${selectionId}`, uid), recipientId: uid,
        kind: "approval_nearing_expiry", contentType: "problem", contentId: doc.id,
        problemId: doc.id, proposalId, title,
        message: `The acceptance window for “${title}” closes at ${when}. Confirm or reject before it expires.`,
      });
      if (written.written) notified += 1;
    }
  }
  return { notified };
}

export function registerMatchingNotificationFunctions({ db, region }) {
  return {
    notifyMatchingEvent: onDocumentCreated({ document: "matchingEvents/{eventId}", region, maxInstances: 3, retry: true }, async event => {
      const eventId = event.params.eventId;
      if ((await enqueueMatchingNotifications({ db, eventId })).queued) await processMatchingNotificationPage({ db, eventId });
    }),
    resumeMatchingNotificationDelivery: onSchedule({ schedule: "every 1 minutes", region, maxInstances: 1, retryCount: 3 },
      () => resumeMatchingNotifications({ db })),
    remindNearingApprovalWindows: onSchedule({ schedule: "every 5 minutes", region, maxInstances: 1, retryCount: 3 },
      () => remindNearingApprovalWindows({ db })),
  };
}
