// Keep room for moderation metadata even after repeated maximum-size edits.
export const COMMENT_REVISIONS_MAX = 20;

export function boundedCommentHistory(data, revision) {
  const history = Array.isArray(data.revisions) ? data.revisions : [];
  const length = history.length + (revision ? 1 : 0);
  const dropped = Math.max(0, length - COMMENT_REVISIONS_MAX);
  const revisions = history.slice(dropped);
  if (revision) revisions.push(revision);
  const revisionsDropped = (data.revisionsDropped || 0) + dropped;
  return { revisions, revisionsDropped, revisionsTruncated: revisionsDropped > 0 };
}
