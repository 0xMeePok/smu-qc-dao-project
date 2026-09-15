import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { CONTENT_REASONS, moderationError, submitContentReport } from "../lib/moderation.js";
import { Modal } from "./Modal.jsx";

export function ReportContentButton({ contentType, contentId }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setDone(false); setOpen(false); setError(""); return () => { generation.current++; }; }, [contentId, contentType, user?.id]);
  if (!user?.id || !contentId) return null;
  const submit = async (event) => {
    event.preventDefault();
    if (inFlight.current) return;
    if (!reason) { setError("Choose a reason for reporting this content."); return; }
    const version = generation.current;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await submitContentReport({ contentType, contentId, reason, details: details.trim() });
      if (version === generation.current) { setDone(true); setOpen(false); }
    } catch (err) { if (version === generation.current) setError(moderationError(err)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <div className="content-report">
    {done ? <p role="status">Report received. Administrators will review it.</p> : <button type="button" className="text-button" onClick={() => { setOpen(true); setReason(""); setDetails(""); }}>Report this {contentType === "problem" ? "posting" : contentType}</button>}
    {open && <Modal labelledBy="report-content-title" onDismiss={() => { if (!busy) setOpen(false); }}><form onSubmit={submit}>
      <div className="modal-head"><h2 id="report-content-title">Report content</h2></div><div className="modal-body"><p>Your identity is visible only to administrators. You can report an item once.</p>
        <label htmlFor="report-reason">Reason</label><select id="report-reason" required value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)}><option value="">Choose a reason</option>{CONTENT_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <label htmlFor="report-details">Additional details (optional)</label><textarea id="report-details" rows={4} maxLength={2000} value={details} disabled={busy} onChange={(event) => setDetails(event.target.value)} />
        {error && <p role="alert" className="error-banner">{error}</p>}
      </div><div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? "Sending…" : "Submit report"}</button></div>
    </form></Modal>}
  </div>;
}

export function ContentModerationNotice({ record }) {
  if (!["hidden", "removed"].includes(record?.moderationStatus)) return null;
  return <div className="matching-notice" role="status"><strong>This content is {record.moderationStatus} by moderation.</strong><p>{CONTENT_REASONS.find(([value]) => value === record.moderation?.reason)?.[1] || record.moderation?.reason}{record.moderation?.details ? ` — ${record.moderation.details}` : ""}</p><p>It is excluded from the active workflow. The author and administrators can still view it.</p></div>;
}
