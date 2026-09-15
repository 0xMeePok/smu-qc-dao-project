import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";

const PAGE_SIZE = 100;
const JOBS = "matchingNotificationJobs";
const DECISIONS = new Set(["owner_selected", "creator_confirmed", "creator_declined", "confirmation_expired", "admin_force_expired"]);
const GATES = new Set(["mock_evaluation_completed", "funding_target_reached"]);
const idFor = (eventId, recipientId) => createHash("sha256").update(`${eventId}:${recipientId}`).digest("hex");

function messageFor(job, recipientId) {
  switch (job.event.type) {
    case "owner_selected": return recipientId === job.selectedCreatorId
      ? "Your proposal was selected. Confirm your commitment within seven days of selection; otherwise its mock funding will be refunded."
      : "The problem owner selected a proposal. Mock funding for all proposals is paused while its creator confirms within seven days.";
    case "creator_confirmed": return "The selected creator confirmed the match. Its mock funding is locked; other proposals are cancelled and their mock contributions refunded.";
    case "creator_declined": return "The selected creator declined. That proposal's mock contributions were refunded, and the other proposals reopened with their funding and evaluations retained.";
    case "confirmation_expired":
    case "admin_force_expired": return "The selected proposal's confirmation window expired. Its mock contributions were refunded, and the other proposals reopened with their funding and evaluations retained.";
    default: return "A proposal has completed its mock evaluation and reached its funding target. You can select it with a rationale to start its creator's seven-day confirmation window.";
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
    // Gate events notify only the owner, and only after both trusted gates hold.
    const gatesReady = ["submitted", "open"].includes(problem.data()?.status)
      && !problem.data()?.moderated && !selected?.data()?.moderated
      && ["submitted", "under_review"].includes(selected?.data()?.status)
      && !problem.data()?.acceptedProposalId && !problem.data()?.acceptedSolutionId && !problem.data()?.hasAcceptedSolution
      && (problem.data()?.matching?.status || "open") === "open"
      && !["hidden", "removed"].includes(problem.data()?.moderationStatus)
      && !["hidden", "removed"].includes(selected?.data()?.moderationStatus)
      && (selected?.data()?.matching?.status || "funding") === "funding"
      && selected?.data()?.matching?.evaluationComplete === true
      && (selected.data().matching.fundedMinor || 0) >= Math.round(Number(selected.data().amount) * 100)
      && Number(selected.data().amount) > 0;
    const gateOnly = GATES.has(event.type);
    const noticeKey = gateOnly ? `ready:${event.problemId}:${event.proposalId}:${selected?.data()?.matching?.updatedAt?.toMillis?.() || 0}` : eventId;
    tx.set(jobRef, { eventId, noticeKey, event: { type: event.type, problemId: event.problemId, proposalId: event.proposalId || null,
      createdAt: event.createdAt || now }, ownerId: problem.data()?.ownerId || null,
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

export function registerMatchingNotificationFunctions({ db, region }) {
  return {
    notifyMatchingEvent: onDocumentCreated({ document: "matchingEvents/{eventId}", region, maxInstances: 3, retry: true }, async event => {
      const eventId = event.params.eventId;
      if ((await enqueueMatchingNotifications({ db, eventId })).queued) await processMatchingNotificationPage({ db, eventId });
    }),
    resumeMatchingNotificationDelivery: onSchedule({ schedule: "every 1 minutes", region, maxInstances: 1, retryCount: 3 },
      () => resumeMatchingNotifications({ db })),
  };
}
