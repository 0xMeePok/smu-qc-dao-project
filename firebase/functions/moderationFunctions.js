import { onCall } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { prepareModerationMatching } from "./matching.js";
import { submitContentReport, listModerationQueue, getModerationContext, moderateContent,
  listModerationNotifications, markModerationNotificationRead, flagSubmittedContent, listReportableComments } from "./moderation.js";

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
    (event) => event.data?.after?.exists ? flagSubmittedContent({ db, contentType, contentId: event.params.contentId }) : null,
  );
  return {
    submitContentReport: member(submitContentReport),
    listModerationQueue: admin(listModerationQueue),
    getModerationContext: admin(getModerationContext),
    moderateContent: admin((args) => moderateContent({ ...args, prepareMatching: prepareModerationMatching })),
    listModerationNotifications: member(listModerationNotifications),
    markModerationNotificationRead: member(markModerationNotificationRead),
    listReportableComments: member(listReportableComments),
    screenProblemContent: screening("problem", "problems"),
    screenProposalContent: screening("proposal", "proposals"),
    screenCommentContent: screening("comment", "comments"),
  };
}
