import { onCall } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { prepareModerationMatching } from "./matching.js";
import { prepareCommentEvaluationGate } from "./comments.js";
import { submitContentReport, listModerationQueue, getModerationContext, moderateContent,
  listModerationNotifications, markModerationNotificationRead, markAllModerationNotificationsRead, listReportableComments,
  notifyProposalReceived, syncProposalParentVisibility, syncProblemProposalsBrowsable } from "./moderation.js";
import { enqueueModerationVoidJobs } from "./escrowModerationVoid.js";
import { cancelPendingFundingApproaches } from "./fundingApproach.js";
import { enqueueIndependentFundingCancellation } from "./independentFundingModeration.js";

/** Keep moderation transport separate while reusing the application's session checks. */
export function registerModerationCallables({ db, requireMember, requireAdmin, options, region }) {
  const member = (handler) => onCall(options, async (request) => {
    const uid = await requireMember(request);
    return handler({ ...request.data, db, uid, now: Timestamp.now() });
  });
  const admin = (handler) => onCall(options, async (request) => {
    const { uid } = await requireAdmin(request);
    return handler({ ...request.data, db, uid, now: Timestamp.now() });
  });
  const screening = (contentType, collection) => onDocumentWritten(
    { document: `${collection}/{contentId}`, region, maxInstances: 3, retry: true },
    async (event) => {
      if (!event.data?.after?.exists) return null;
      const contentId = event.params.contentId;
      if (contentType === "proposal") {
        await notifyProposalReceived({
          db, proposalId: contentId,
          before: event.data.before?.exists ? event.data.before.data() : null,
          after: event.data.after.data(),
        });
        await syncProposalParentVisibility({ db, proposalId: contentId });
      }
      if (contentType === "problem") await syncProblemProposalsBrowsable({ db, problemId: contentId });
      return null;
    },
  );
  return {
    submitContentReport: member(submitContentReport),
    listModerationQueue: admin(listModerationQueue),
    getModerationContext: admin(getModerationContext),
    moderateContent: admin(async (args) => {
      const result = await moderateContent({
        ...args, prepareMatching: prepareModerationMatching, prepareCommentGate: prepareCommentEvaluationGate,
      });
      if (args.action === "remove" && result?.eventId && !result.unchanged) {
        const index = String(args.queueId || "").indexOf("_");
        const contentType = index > 0 ? args.queueId.slice(0, index) : "";
        const contentId = index > 0 ? args.queueId.slice(index + 1) : "";
        await enqueueModerationVoidJobs({
          db, contentType, contentId, eventId: result.eventId, reason: args.reason, now: args.now,
        });
        await enqueueIndependentFundingCancellation({
          db, contentType, contentId, eventId: result.eventId, reason: args.reason, now: args.now,
        });
        if (contentType === "proposal") {
          await cancelPendingFundingApproaches({ db, proposalId: contentId, now: args.now });
        }
      }
      // The matching transaction only reaches the proposals it loaded. Stamp the
      // rest before returning, so no child keeps serving PDFs for a hidden parent.
      if (args.contentType === "problem") {
        await syncProblemProposalsBrowsable({ db: args.db, problemId: args.contentId, now: args.now });
      }
      return result;
    }),
    listModerationNotifications: member(listModerationNotifications),
    markModerationNotificationRead: member(markModerationNotificationRead),
    markAllModerationNotificationsRead: member(markAllModerationNotificationsRead),
    listReportableComments: member(listReportableComments),
    screenProblemContent: screening("problem", "problems"),
    screenProposalContent: screening("proposal", "proposals"),
    screenCommentContent: screening("comment", "comments"),
  };
}
