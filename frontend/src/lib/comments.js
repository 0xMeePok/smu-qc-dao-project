import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

export const COMMENT_EDIT_WINDOW_MS = 15 * 60 * 1000;
export const RECOMMENDATIONS = [
  ["recommend", "Recommend"],
  ["recommend_with_revisions", "Recommend with revisions"],
  ["do_not_recommend", "Do not recommend"],
];

async function call(name, payload = {}) {
  requireFirebase();
  return (await httpsCallable(functions, name)(payload)).data;
}

export const createComment = (payload) => call("createComment", payload);
export const editComment = (payload) => call("editComment", payload);
export const deleteComment = (commentId) => call("deleteComment", { commentId });

export function commentError(error) {
  const code = String(error?.code || "").split("/").pop();
  if (code === "unauthenticated") return "Sign in again to continue.";
  if (["invalid-argument", "permission-denied", "failed-precondition", "not-found"].includes(code)) return error.message;
  return "Could not save the comment. Please try again.";
}
