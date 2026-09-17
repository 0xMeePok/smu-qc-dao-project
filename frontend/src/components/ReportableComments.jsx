import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { ROLES } from "../config/roles.js";
import { listReportableComments, moderationError } from "../lib/moderation.js";
import { COMMENT_BODY_MAX, canEditComment, commentError, createComment, deleteComment, editComment,
  RECOMMENDATIONS, recommendationLabel } from "../lib/comments.js";
import { ReportContentButton } from "./ReportContentButton.jsx";
import { formatInstant } from "../lib/datetime.js";

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

export function ReportableComments({ problemId, proposalId }) {
  const { user } = useAuth();
  return <CommentsPage key={`${user?.id || "guest"}:${problemId}:${proposalId || ""}`} problemId={problemId} proposalId={proposalId} />;
}

function CommentsPage({ problemId, proposalId }) {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState("oldest");
  const [editingId, setEditingId] = useState(null);
  const request = useRef(0);
  const busy = useRef(false);
  const canCompose = Boolean(user?.id && proposalId);
  async function load(nextCursor, direction = sort) {
    if (busy.current || !problemId) return;
    busy.current = true;
    const token = ++request.current;
    setLoading(true); setError("");
    try {
      const data = await listReportableComments({ problemId, ...(proposalId ? { proposalId } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {}), ...(direction === "newest" ? { sort: "newest" } : {}) });
      if (token !== request.current) return;
      setItems((previous) => [...new Map([...(nextCursor ? previous : []), ...(data.items ?? [])].map((item) => [item.id, item])).values()]);
      setCursor(data.nextCursor ?? null);
    } catch (err) {
      if (token === request.current) setError(moderationError(err));
    } finally {
      if (token === request.current) { busy.current = false; setLoading(false); }
    }
  }
  function refresh() {
    setEditingId(null); setItems([]); setCursor(null); busy.current = false; load(null, sort);
  }
  useEffect(() => {
    load(null, sort);
    return () => { request.current += 1; busy.current = false; };
  }, [sort]);
  function changeSort(next) {
    if (next === sort) return;
    setEditingId(null); setItems([]); setCursor(null); setSort(next);
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
    {canCompose && !editingId && <CommentComposer proposalId={proposalId} evaluator={isEvaluator(user)} onPosted={refresh} />}
    {error && <p role="alert" className="field-hint">{error}</p>}
    {items.map((item) => <CommentItem key={item.id} item={item} user={user} editing={editingId === item.id}
      onEdit={() => setEditingId(item.id)} onCancel={() => setEditingId(null)} onChanged={refresh} />)}
    {loading && <p role="status" className="field-hint">Loading comments…</p>}
    {(cursor || error) && <button className="secondary" type="button" disabled={loading} onClick={() => load(cursor, sort)}>{error ? "Retry comments" : "Load more comments"}</button>}
  </section>;
}

function CommentComposer({ proposalId, evaluator, onPosted, initial, onCancel }) {
  const [body, setBody] = useState(initial?.body || "");
  const [recommendation, setRecommendation] = useState(initial?.recommendation || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!body.trim()) { setError("Enter a comment."); return; }
    if (evaluator && !recommendation) { setError("Choose Recommend, Recommend with revisions, or Do not recommend."); return; }
    setBusy(true); setError("");
    try {
      const payload = { body, ...(evaluator ? { recommendation } : {}) };
      if (initial) await editComment({ commentId: initial.id, ...payload });
      else await createComment({ proposalId, ...payload });
      setBody(""); setRecommendation("");
      onPosted();
    } catch (err) {
      setError(commentError(err));
    } finally {
      setBusy(false);
    }
  };
  return <form className="comment-composer" onSubmit={submit}>
    <label htmlFor={initial ? `edit-comment-${initial.id}` : "new-comment"}>{initial ? "Edit comment" : "Write a comment"}</label>
    <textarea id={initial ? `edit-comment-${initial.id}` : "new-comment"} rows={4} maxLength={COMMENT_BODY_MAX}
      value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} />
    {evaluator && <fieldset className="comment-recommendations" disabled={busy}>
      <legend>Recommendation</legend>
      {RECOMMENDATIONS.map(([value, label]) => <label key={value}>
        <input type="radio" name={initial ? `edit-recommendation-${initial.id}` : "comment-recommendation"}
          value={value} checked={recommendation === value} onChange={() => setRecommendation(value)} />{label}
      </label>)}
    </fieldset>}
    {error && <p role="alert" className="field-hint">{error}</p>}
    <div className="comment-actions">
      {onCancel && <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>}
      <button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : initial ? "Save comment" : "Post comment"}</button>
    </div>
  </form>;
}

function CommentItem({ item, user, editing, onEdit, onCancel, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mine = sameAuthor(user, item);
  const editable = mine && canEditComment(item);
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { await deleteComment(item.id); onChanged(); }
    catch (err) { setError(commentError(err)); setBusy(false); }
  };
  if (editing) {
    return <article className="matching-candidate">
      <CommentComposer proposalId={item.proposalId} evaluator={isEvaluator(user)} initial={item}
        onPosted={onChanged} onCancel={onCancel} />
    </article>;
  }
  const role = roleText(item.authorRole);
  return <article className="matching-candidate">
    <p className="proposal-text">{item.body || item.text || item.content}</p>
    <div className="comment-meta">
      <small>{item.authorName || item.authorId} · {formatInstant(item.createdAt)}{item.editedAt ? " · Edited" : ""}</small>
      {role && <span className={`role-chip ${roleChip(item.authorRole)}`}>{role}</span>}
      {item.qualifying && item.badge === "evaluator" && <span className="user-role-badge evaluator-badge">Evaluator</span>}
      {item.qualifying && recommendationLabel(item.recommendation) && <span className="comment-recommendation">{recommendationLabel(item.recommendation)}</span>}
    </div>
    {error && <p role="alert" className="field-hint">{error}</p>}
    <div className="comment-actions">
      {editable && <button type="button" className="text-button" disabled={busy} onClick={onEdit}>Edit comment</button>}
      {mine && <button type="button" className="text-button" disabled={busy} onClick={remove}>{busy ? "Deleting…" : "Delete comment"}</button>}
      <ReportContentButton contentType="comment" contentId={item.id} />
    </div>
  </article>;
}
