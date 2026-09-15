import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { listReportableComments, moderationError } from "../lib/moderation.js";
import { ReportContentButton } from "./ReportContentButton.jsx";
import { formatInstant } from "../lib/datetime.js";

export function ReportableComments({ problemId, proposalId }) {
  const { user } = useAuth();
  return <CommentsPage key={`${user?.id || "guest"}:${problemId}:${proposalId || ""}`} problemId={problemId} proposalId={proposalId} />;
}

function CommentsPage({ problemId, proposalId }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const busy = useRef(false);
  async function load(nextCursor) {
    if (busy.current || !problemId) return;
    busy.current = true;
    const token = ++request.current;
    setLoading(true); setError("");
    try {
      const data = await listReportableComments({ problemId, ...(proposalId ? { proposalId } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) });
      if (token !== request.current) return;
      setItems((previous) => [...new Map([...previous, ...(data.items ?? [])].map((item) => [item.id, item])).values()]);
      setCursor(data.nextCursor ?? null);
    } catch (err) {
      if (token === request.current) setError(moderationError(err));
    } finally {
      if (token === request.current) { busy.current = false; setLoading(false); }
    }
  }
  useEffect(() => {
    load(null);
    return () => { request.current += 1; busy.current = false; };
  }, []);
  if (!items.length && !error && !cursor && !loading) return null;
  return <section className="detail-section"><h2>Comments</h2>{error && <p role="alert" className="field-hint">{error}</p>}{items.map((item) => <article key={item.id} className="matching-candidate"><p className="proposal-text">{item.body || item.text || item.content}</p><small>{item.authorName || item.authorId} · {formatInstant(item.createdAt)}</small><ReportContentButton contentType="comment" contentId={item.id} /></article>)}{loading && <p role="status" className="field-hint">Loading comments…</p>}{(cursor || error) && <button className="secondary" type="button" disabled={loading} onClick={() => load(cursor)}>{error ? "Retry comments" : "Load more comments"}</button>}</section>;
}
