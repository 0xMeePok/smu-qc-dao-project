import { onCall } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { prepareModerationMatching } from "./matching.js";
import { prepareCommentEvaluationGate } from "./comments.js";
import { submitContentReport, listModerationQueue, getModerationContext, moderateContent,
  listModerationNotifications, markModerationNotificationRead, flagSubmittedContent, listReportableComments,
  syncProposalParentVisibility, syncProblemProposalsBrowsable } from "./moderation.js";

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
      const flagged = await flagSubmittedContent({ db, contentType, contentId });
      if (contentType === "proposal") await syncProposalParentVisibility({ db, proposalId: contentId });
      if (contentType === "problem") await syncProblemProposalsBrowsable({ db, problemId: contentId });
      return flagged;
    },
  );
  return {
    submitContentReport: member(submitContentReport),
    listModerationQueue: admin(listModerationQueue),
    getModerationContext: admin(getModerationContext),
    moderateContent: admin((args) => moderateContent({
      ...args, prepareMatching: prepareModerationMatching, prepareCommentGate: prepareCommentEvaluationGate,
    })),
    listModerationNotifications: member(listModerationNotifications),
    markModerationNotificationRead: member(markModerationNotificationRead),
    listReportableComments: member(listReportableComments),
    screenProblemContent: screening("problem", "problems"),
    screenProposalContent: screening("proposal", "proposals"),
    screenCommentContent: screening("comment", "comments"),
  };
}
