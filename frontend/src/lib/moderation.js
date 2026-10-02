import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

export const CONTENT_REASONS = [
  ["off_topic", "Off topic"], ["abusive", "Abusive content"],
  ["misleading", "Misleading information"], ["duplicate", "Suspected duplicate"],
];
export const REMOVE_REASONS = [...CONTENT_REASONS, ["spam", "Spam"], ["policy_violation", "Policy violation"], ["other", "Other"]];
export const RESTORE_REASONS = [["no_violation", "No violation found"], ["appeal_accepted", "Decision reversed after review"]];
export const MODERATION_REASONS = [...REMOVE_REASONS, ...RESTORE_REASONS];

async function call(name, payload = {}) {
  requireFirebase();
  return (await httpsCallable(functions, name)(payload)).data;
}
export const submitContentReport = (payload) => call("submitContentReport", payload);
export const listModerationQueue = (payload) => call("listModerationQueue", payload);
export const getModerationContext = (queueId) => call("getModerationContext", { queueId });
export const moderateContent = (payload) => call("moderateContent", payload);
export const listModerationNotifications = () => call("listModerationNotifications");
export const markModerationNotificationRead = (notificationId) => call("markModerationNotificationRead", { notificationId });
export const markAllModerationNotificationsRead = () => call("markAllModerationNotificationsRead");
export const listReportableComments = (payload) => call("listReportableComments", payload);
export const listRemovedProblems = () => call("listRemovedProblems");
export const readRemovedProblem = (problemId) => call("readRemovedProblem", { problemId });

export function moderationReasonLabel(value) {
  return MODERATION_REASONS.find(([key]) => key === value)?.[1] || value || "No reason recorded";
}

export function moderationError(error) {
  const code = String(error?.code || "").split("/").pop();
  if (code === "unauthenticated") return "Sign in again to continue.";
  if (["invalid-argument", "permission-denied", "failed-precondition", "already-exists", "resource-exhausted"].includes(code)) return error.message;
  return "Could not reach moderation. Please try again.";
}

export function isModerated(record) {
  return ["hidden", "removed"].includes(record?.moderationStatus);
}
