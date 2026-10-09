import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { ROLES } from "../config/roles.js";
import { listReportableComments, moderationError } from "../lib/moderation.js";
import { COMMENT_BODY_MAX, canEditComment, commentError, createComment, deleteComment, editComment,
  RECOMMENDATIONS } from "../lib/comments.js";
import { ReportContentButton } from "./ReportContentButton.jsx";
import { StatusBadge } from "./StatusBadge.jsx";
import { formatInstant } from "../lib/datetime.js";
import { useLiveActivity } from "../hooks/useLiveActivity.js";

function isEvaluator(user) {
  return Boolean(user?.roles?.includes(ROLES.EVALUATOR));
}

function sameAuthor(user, item) {
  return Boolean(user?.id && item?.authorId && user.id.toLowerCase() === item.authorId.toLowerCase());
}

function roleChip(authorRole) {
  if (authorRole === "evaluator") return "role-chip-evaluator";
  if (authorRole === "administrator") return "role-chip-admin";
  return "role-chip-user";
}

function roleText(authorRole) {
  if (authorRole === "evaluator") return "Evaluator";
  if (authorRole === "administrator") return "Administrator";
  if (authorRole === "user") return "User";
  return "";
}

export function ReportableComments({
  problemId, proposalId, authorId, recommenders = [], onRecommendationChange,
  discussionOpen = true, allowRecommendations = true,
}) {
  const { user } = useAuth();
  return <CommentsPage key={`${user?.id || "guest"}:${problemId || ""}:${proposalId || ""}`}
    problemId={problemId} proposalId={proposalId} authorId={authorId}
    recommenders={recommenders} onRecommendationChange={onRecommendationChange}
    discussionOpen={discussionOpen} allowRecommendations={allowRecommendations} />;
}

function replyCount(item) {
  return item?.replyCount ?? item?.replies?.length ?? 0;
}

function CommentsPage({ problemId, proposalId, authorId, recommenders, onRecommendationChange, discussionOpen, allowRecommendations }) {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState("oldest");
  const [editingId, setEditingId] = useState(null);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const request = useRef(0);
  const busy = useRef(false);
  const refreshPending = useRef(false);
  const loadedPages = useRef(1);
  const loadedReplyPages = useRef(new Map());
  const [pendingMutations, setPendingMutations] = useState(0);
  const [loadingThreads, setLoadingThreads] = useState(0);
  const mutationBusy = (active) => setPendingMutations((count) => Math.max(0, count + (active ? 1 : -1)));
  const parentPayload = {
    ...(proposalId ? { proposalId } : {}),
    ...(problemId ? { problemId } : {}),
  };
  const canCompose = Boolean(user?.id && proposalId && discussionOpen);
  // One recommendation per evaluator, and never from the solution's own author.
  const ownSolution = Boolean(authorId && user?.id && authorId.toLowerCase() === user.id.toLowerCase());
  const recommended = recommenders.some((id) => id.toLowerCase() === user?.id?.toLowerCase())
    || items.some((item) => item.qualifying && sameAuthor(user, item));
  async function load(nextCursor, direction = sort, quiet = false) {
    if (!(problemId || proposalId)) return;
    if (busy.current) { if (quiet) refreshPending.current = true; return; }
    busy.current = true;
    const token = ++request.current;
    setLoading(true); setError("");
    try {
      let pageCursor = nextCursor;
      let rows = [];
      let pages = 0;
      // Replay the visible pages from fresh cursors so insertions and deletions do
      // not leave stale rows or discard pages the reader has already opened.
      const pageLimit = quiet ? loadedPages.current : 1;
      do {
        const data = await listReportableComments({ ...parentPayload,
          ...(pageCursor ? { cursor: pageCursor } : {}), ...(direction === "newest" ? { sort: "newest" } : {}) });
        if (token !== request.current) return;
        rows.push(...(data.items ?? []).map((item) => ({ ...item })));
        pageCursor = data.nextCursor ?? null;
        pages += 1;
      } while (pageCursor && pages < pageLimit);
      if (!nextCursor) {
        for (const item of rows) {
          let replyCursor = item.nextReplyCursor;
          const replies = [...(item.replies || [])];
          for (let page = 0; replyCursor && page < (loadedReplyPages.current.get(item.id) || 0); page += 1) {
            const data = await listReportableComments({ ...parentPayload, threadId: item.id, cursor: replyCursor });
            if (token !== request.current) return;
            replies.push(...(data.items ?? []));
            replyCursor = data.nextCursor ?? null;
          }
          item.replies = [...new Map(replies.map((reply) => [reply.id, reply])).values()];
          item.nextReplyCursor = replyCursor ?? null;
        }
      }
      setItems((previous) => [...new Map([...(nextCursor ? previous : []), ...rows].map((item) => [item.id, item])).values()]);
      loadedPages.current = nextCursor ? loadedPages.current + 1 : pages;
      setCursor(pageCursor);
    } catch (err) {
      if (token === request.current) setError(moderationError(err));
    } finally {
      if (token === request.current) {
        busy.current = false; setLoading(false);
        if (refreshPending.current) { refreshPending.current = false; load(null, direction, true); }
      }
    }
  }
  useEffect(() => {
    // A fully deleted thread may disappear from the server response. Do not
    // leave the top-level composer hidden by an edit that is no longer visible.
    if (editingId && !items.some((item) => item.id === editingId || item.replies?.some((reply) => reply.id === editingId))) {
      setEditingId(null);
    }
  }, [items]);
  function refresh() {
    return load(null, sort, true);
  }
  function changed() {
    setEditingId(null);
    refresh();
    onRecommendationChange?.();
  }
  useLiveActivity({ proposalId, problemId, identity: user?.id, channel: "comments", onRefresh: refresh,
    enabled: Boolean(problemId || proposalId), blocked: loading || pendingMutations > 0 || loadingThreads > 0 });
  // QCDAO-70: replies arrive as a bounded preview; a thread pages on demand.
  async function loadThread(threadId, cursor) {
    const token = request.current;
    setLoadingThreads((count) => count + 1);
    try {
      const data = await listReportableComments({ ...parentPayload, threadId,
        ...(cursor ? { cursor } : {}) });
      if (token === request.current) {
        loadedReplyPages.current.set(threadId, (loadedReplyPages.current.get(threadId) || 0) + 1);
      }
      return data;
    } finally {
      setLoadingThreads((count) => Math.max(0, count - 1));
    }
  }
  function toggleThread(id, open) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (open === true) next.add(id);
      else if (open === false || next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  useEffect(() => {
    load(null, sort);
    return () => { request.current += 1; busy.current = false; };
  }, [sort]);
  function changeSort(next) {
    if (next === sort) return;
    request.current += 1; busy.current = false; refreshPending.current = false;
    loadedPages.current = 1; loadedReplyPages.current.clear();
    setEditingId(null); setExpandedIds(new Set()); setItems([]); setCursor(null); setSort(next);
  }
  if (!items.length && !error && !cursor && !loading && !canCompose) return null;
  return <section className="detail-section comment-thread">
    <div className="comment-thread-heading">
      <h2>Comments</h2>
      {(items.length > 0 || cursor) && <label className="comment-sort">Sort comments
        <select value={sort} onChange={(event) => changeSort(event.target.value)}>
          <option value="oldest">Oldest first</option>
          <option value="newest">Newest first</option>
        </select>
      </label>}
    </div>
    {canCompose && !editingId && <CommentComposer proposalId={proposalId} evaluator={isEvaluator(user)}
      ownSolution={ownSolution} recommended={recommended} allowRecommendations={allowRecommendations}
      onPosted={changed} onRefresh={refresh} onBusyChange={mutationBusy} />}
    {!discussionOpen && items.length > 0 && <p className="field-hint">The listing window has closed. Existing comments remain visible.</p>}
    {error && <p role="alert" className="field-hint">{error}</p>}
    {items.map((item) => <CommentItem key={item.id} item={item} user={user} editing={editingId === item.id}
      editingId={editingId} canReply={canCompose} expanded={expandedIds.has(item.id)}
      onToggle={() => toggleThread(item.id)} onReply={() => toggleThread(item.id, true)}
      onEdit={(id) => setEditingId(id || item.id)} onCancel={() => setEditingId(null)} onChanged={changed}
      onLoadReplies={loadThread} onBusyChange={mutationBusy} allowRecommendations={allowRecommendations} />)}
    {loading && !items.length && <p role="status" className="field-hint">Loading comments…</p>}
    {(cursor || error) && <button className="secondary" type="button" disabled={loading} onClick={() => load(cursor, sort)}>{error ? "Retry comments" : "Load more comments"}</button>}
  </section>;
}

function CommentComposer({ proposalId, evaluator, onPosted, initial, onCancel, parentId, ownSolution = false, recommended = false, onRefresh, onBusyChange, unavailable = false, allowRecommendations = true }) {
  const reply = Boolean(parentId) || Boolean(initial?.parentId);
  // Editing my own recommendation keeps the picker; a second one is refused.
  const blocked = allowRecommendations && evaluator && !reply && (ownSolution || (recommended && !initial?.qualifying));
  const recommend = allowRecommendations && evaluator && !reply && !blocked;
  const [body, setBody] = useState(initial?.body || "");
  const [recommendation, setRecommendation] = useState(initial?.recommendation || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fieldId = initial ? `edit-comment-${initial.id}` : parentId ? `reply-comment-${parentId}` : "new-comment";
  const submit = async (event) => {
    event.preventDefault();
    if (busy || unavailable) return;
    if (!body.trim()) { setError(reply ? "Enter a reply." : "Enter a comment."); return; }
    if (recommend && !recommendation) { setError("Choose Recommend, Recommend with revisions, or Do not recommend."); return; }
    setBusy(true); onBusyChange?.(true); setError("");
    try {
      const payload = { body, ...(recommend ? { recommendation } : {}) };
      if (initial) await editComment({ commentId: initial.id, ...payload });
      else await createComment({ proposalId, ...payload, ...(parentId ? { parentId } : {}) });
      setBody(""); setRecommendation("");
      onPosted();
    } catch (err) {
      setError(commentError(err));
      // A duplicate from another tab: show the recommendation already on record.
      if (/already recommended/i.test(String(err?.message ?? ""))) onRefresh?.();
    } finally {
      setBusy(false); onBusyChange?.(false);
    }
  };
  return <form className="comment-composer" onSubmit={submit}>
    <label htmlFor={fieldId}>{initial ? "Edit comment" : reply ? "Write a reply" : "Write a comment"}</label>
    <textarea id={fieldId} rows={reply ? 3 : 4} maxLength={COMMENT_BODY_MAX}
      value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} />
    {blocked && <p className="field-hint">
      {ownSolution
        ? "You cannot evaluate your own solution."
        : "You have already recommended this solution. Edit or delete that comment to change it."}
    </p>}
    {recommend && <fieldset className="comment-recommendations" disabled={busy}>
      <legend>Recommendation</legend>
      {RECOMMENDATIONS.map(([value, label]) => <label key={value} className="comment-recommendation-option">
        <input type="radio" name={initial ? `edit-recommendation-${initial.id}` : "comment-recommendation"}
          value={value} checked={recommendation === value} onChange={() => setRecommendation(value)} />
        <span>{label}</span>
      </label>)}
    </fieldset>}
    {unavailable && <p role="alert" className="field-hint">This comment was removed. Your draft is still here; cancel to return to the discussion.</p>}
    {error && <p role="alert" className="field-hint">{error}</p>}
    <div className="comment-actions">
      {onCancel && <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>}
      <button type="submit" className="primary" disabled={busy || unavailable}>{busy ? "Saving…" : initial ? "Save comment" : reply ? "Post reply" : "Post comment"}</button>
    </div>
  </form>;
}

function CommentItem({ item, user, editing, editingId, canReply, expanded, onToggle, onReply, onEdit, onCancel, onChanged, onLoadReplies, onBusyChange, nested, allowRecommendations = true }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [extraReplies, setExtraReplies] = useState([]);
  const [replyCursor, setReplyCursor] = useState(item.nextReplyCursor ?? null);
  const [loadingReplies, setLoadingReplies] = useState(false);
  const replyRequest = useRef(0);
  useEffect(() => {
    replyRequest.current += 1;
    setExtraReplies([]);
    setReplyCursor(item.nextReplyCursor ?? null);
    setLoadingReplies(false);
    return () => { replyRequest.current += 1; };
  }, [item.id, item.replies]);
  const loadMoreReplies = async () => {
    if (loadingReplies || !replyCursor || !onLoadReplies) return;
    const token = ++replyRequest.current;
    setLoadingReplies(true); setError("");
    try {
      const data = await onLoadReplies(item.id, replyCursor);
      if (token !== replyRequest.current) return;
      setExtraReplies((current) => [...current, ...(data?.items ?? [])]);
      setReplyCursor(data?.nextCursor ?? null);
    } catch (err) {
      if (token === replyRequest.current) setError(moderationError(err));
    } finally {
      if (token === replyRequest.current) setLoadingReplies(false);
    }
  };
  const removed = Boolean(item.deleted || item.deletedAt);
  const withdrawn = item.moderationStatus === "removed" || item.moderationStatus === "hidden";
  const mine = !removed && !withdrawn && sameAuthor(user, item);
  const editable = mine && canEditComment(item);
  const replies = [...new Map([...(item.replies || []), ...extraReplies].map((reply) => [reply.id, reply])).values()];
  const count = replyCount(item);
  const parent = !nested && !item.parentId;
  const remove = async () => {
    if (busy) return;
    setBusy(true); onBusyChange?.(true); setError("");
    try { await deleteComment(item.id); onChanged(); }
    catch (err) { setError(commentError(err)); }
    finally { setBusy(false); onBusyChange?.(false); }
  };
  const role = roleText(item.authorRole);
  const outcome = !removed && item.qualifying ? item.recommendation : null;
  return <article id={`comment-${item.id}`} className={nested ? "matching-candidate comment-reply" : "matching-candidate"}>
    {editing ? <CommentComposer proposalId={item.proposalId} evaluator={isEvaluator(user)} initial={item}
      unavailable={removed || withdrawn} allowRecommendations={allowRecommendations} onPosted={onChanged} onCancel={onCancel} onBusyChange={onBusyChange} /> : <>
      {outcome && <p className="comment-recommendation"><StatusBadge status={outcome} prefix="Evaluator · " /></p>}
      <p className={removed ? "proposal-text comment-removed" : "proposal-text"}>
        {removed ? "This comment was removed" : (item.body || item.text || item.content)}
      </p>
      {!removed && <div className="comment-meta">
        <small>{item.authorName || item.authorId} · {formatInstant(item.createdAt)}{item.editedAt ? " · Edited" : ""}</small>
        {role && <span className={`role-chip ${roleChip(item.authorRole)}`}>{role}</span>}
      </div>}
      {error && <p role="alert" className="field-hint">{error}</p>}
      <div className="comment-actions">
        {withdrawn ? <p>This comment was removed by an administrator</p> : <>
          {editable && <button type="button" className="text-button" disabled={busy} onClick={() => onEdit(item.id)}>Edit comment</button>}
          {mine && <button type="button" className="text-button" disabled={busy} onClick={remove}>{busy ? "Deleting…" : "Delete comment"}</button>}
          {parent && canReply && <button type="button" className="text-button" onClick={onReply}>Reply</button>}
          {!removed && <ReportContentButton contentType="comment" contentId={item.id} />}
        </>}
        {parent && count > 0 && <button type="button" className="text-button" aria-expanded={expanded}
          onClick={onToggle}>{expanded ? "Hide replies" : count === 1 ? "Show 1 reply" : `Show ${count} replies`}</button>}
      </div>
    </>}
    {parent && expanded && <div className="comment-replies">
      {replies.map((reply) => <CommentItem key={reply.id} item={reply} user={user} nested editing={editingId === reply.id}
        onEdit={() => onEdit(reply.id)} onCancel={onCancel} onChanged={onChanged} onBusyChange={onBusyChange} allowRecommendations={allowRecommendations} />)}
      {replyCursor && <button type="button" className="text-button" disabled={loadingReplies} onClick={loadMoreReplies}>
        {loadingReplies ? "Loading…" : "Load more replies"}
      </button>}
      {canReply && !editingId && !withdrawn && <CommentComposer proposalId={item.proposalId} parentId={item.id} evaluator={isEvaluator(user)}
        allowRecommendations={allowRecommendations} onPosted={onChanged} onBusyChange={onBusyChange} />}
    </div>}
  </article>;
}
