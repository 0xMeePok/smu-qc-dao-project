import { useEffect, useRef, useState } from "react";
import { MODERATION_REASONS, getModerationContext, listModerationQueue, moderateContent, moderationError } from "../lib/moderation.js";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../config/proposal.js";
import { findPosting } from "../lib/postings.js";
import { findProposal } from "../lib/proposals.js";
import { formatInstant } from "../lib/datetime.js";
import { Modal } from "./Modal.jsx";
import { downloadAttachment, saveBlobAs } from "../lib/attachments.js";
import { RELATED_AUDIT_KIND, RelatedAuditReceiptPane } from "./RelatedAuditReceiptPane.jsx";

function relatedAuditTarget(selected, context) {
  if (!selected || !context) return null;
  if (selected.contentType === "comment") {
    const parent = context.parent;
    if (parent?.contentType === "proposal" && parent.id) return { kind: RELATED_AUDIT_KIND.PROPOSAL, id: parent.id };
    if (parent?.contentType === "problem" && parent.id) return { kind: RELATED_AUDIT_KIND.LISTING, id: parent.id };
    return null;
  }
  if (selected.contentType === "proposal" && context.content?.id) {
    return { kind: RELATED_AUDIT_KIND.PROPOSAL, id: context.content.id };
  }
  if (selected.contentType === "problem" && context.content?.id) {
    return { kind: RELATED_AUDIT_KIND.LISTING, id: context.content.id };
  }
  return null;
}

const reasonLabel = (value) => MODERATION_REASONS.find(([key]) => key === value)?.[1] || value;
const CONTENT_FIELDS = [...new Set(["title", "summary", "body", "text", "content", "businessContext", "currentApproach", "currentLimitations", "expectedOutcome", "successCriteria", "dataAvailability", "fundingThesis", "eligibilityNotes", "methodology", "approach", "deliverables", "timeline", "team", "problemStatement", "proposedSolution", ...PROPOSAL_FIELDS.map(([key]) => key), ...PROBLEM_FRAMING_FIELDS.map(([key]) => key)])];

function ContextBody({ title, content, contentType, onDownload }) {
  if (!content) return null;
  return <section className="moderation-context"><h4>{title}</h4>{CONTENT_FIELDS.filter((key) => typeof content[key] === "string" && content[key]).map((key) => <div key={key}><strong>{key.replace(/([A-Z])/g, " $1")}</strong><p className="proposal-text">{content[key]}</p></div>)}
    <dl>{content.amount != null && <><dt>Requested amount</dt><dd>{content.currency} {Number(content.amount).toLocaleString()}</dd></>}{content.category && <><dt>Category</dt><dd>{content.category}</dd></>}{content.expiresAt && <><dt>Submission deadline</dt><dd>{formatInstant(content.expiresAt)}</dd></>}</dl>
    {Array.isArray(content.attachments) && content.attachments.map((attachment) => <p key={attachment.id}><button type="button" className="text-button" onClick={() => onDownload(content, contentType, attachment)}>Download {attachment.name}</button></p>)}
  </section>;
}

export function ModerationQueue({ onCountChange }) {
  const [filter, setFilter] = useState({ contentType: "", status: "pending", sort: "oldest" });
  const [page, setPage] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(null);
  const [context, setContext] = useState(null);
  const [contextError, setContextError] = useState("");
  const [action, setAction] = useState("");
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [relatedAudit, setRelatedAudit] = useState(null);
  const inFlight = useRef(false);
  const relatedAuditRequest = useRef(0);
  const countRef = useRef(onCountChange);
  countRef.current = onCountChange;

  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    listModerationQueue({ ...filter, ...(page ? { cursor: page } : {}) }).then((next) => {
      if (active) { setData(next); countRef.current?.(next.pendingCount ?? 0); }
    }).catch((err) => { if (active) setError(moderationError(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filter, page, revision]);

  useEffect(() => {
    relatedAuditRequest.current += 1;
    setRelatedAudit(null);
    setContext(null); setContextError(""); setAction(""); setReason(""); setDetails("");
    if (!selected) return undefined;
    let active = true;
    getModerationContext(selected.id).then((next) => { if (active) setContext(next); })
      .catch((err) => { if (active) setContextError(moderationError(err)); });
    return () => { active = false; };
  }, [selected]);

  const updateFilter = (key, value) => { setPage(null); setFilter((current) => ({ ...current, [key]: value })); };
  const download = async (content, contentType, attachment) => {
    try {
      saveBlobAs(await downloadAttachment({ attachment, ownerId: contentType === "proposal" ? content.researcherId : content.ownerId,
        problemId: content.id, scope: contentType === "proposal" ? "proposals" : "problems" }), attachment.name);
    } catch { setContextError("Could not download this attachment. Please try again."); }
  };
  const submit = async (event) => {
    event.preventDefault();
    if (inFlight.current || !selected) return;
    if (!action || !reason) { setContextError("Choose an action and its reason."); return; }
    inFlight.current = true; setBusy(true); setContextError("");
    try {
      await moderateContent({ queueId: selected.id, action, reason, details: details.trim() });
      setSelected(null); setRevision((value) => value + 1);
    } catch (err) { setContextError(moderationError(err)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const auditTarget = relatedAuditTarget(selected, context);
  const openRelatedAudit = async () => {
    if (!auditTarget) return;
    const request = ++relatedAuditRequest.current;
    setRelatedAudit({ kind: auditTarget.kind, loading: true, record: null, error: "" });
    try {
      const record = auditTarget.kind === RELATED_AUDIT_KIND.PROPOSAL
        ? await findProposal(auditTarget.id)
        : await findPosting(auditTarget.id);
      if (request !== relatedAuditRequest.current) return;
      setRelatedAudit({
        kind: auditTarget.kind,
        loading: false,
        record,
        error: record ? "" : "This record is no longer available, so its verification receipt cannot be opened.",
      });
    } catch (err) {
      if (request !== relatedAuditRequest.current) return;
      setRelatedAudit({
        kind: auditTarget.kind,
        loading: false,
        record: null,
        error: err?.message || "The audit receipt could not be loaded. Try again.",
      });
    }
  };

  return <section className="moderation-queue">
    <div className="table-header"><div><h2>Content moderation {data && <span className="count-pill">{data.pendingCount ?? 0} pending</span>}</h2><p>Reported content and submissions flagged for review. Every decision records a reason and can be reversed.</p></div><button className="secondary" type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Refresh queue</button></div>
    <div className="moderation-filters"><label>Content type<select value={filter.contentType} onChange={(event) => updateFilter("contentType", event.target.value)}><option value="">All types</option><option value="problem">Problem statements</option><option value="proposal">Proposals</option><option value="comment">Comments</option></select></label><label>Status<select value={filter.status} onChange={(event) => updateFilter("status", event.target.value)}>{["pending", "hidden", "removed", "restored", "all"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>Sort<select value={filter.sort} onChange={(event) => updateFilter("sort", event.target.value)}><option value="oldest">Oldest first</option><option value="most_reported">Most reported</option></select></label></div>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {loading ? <p role="status" className="table-empty">Loading moderation queue…</p> : <div className="card-table">{data?.items?.length ? data.items.map((item) => <article key={item.id} className="table-row"><div><span className="eyebrow">{item.contentType} · {item.status}</span><h3>{item.title || "Submitted content"}</h3><p>{item.excerpt}</p><small className="table-row-meta">{item.authorName || item.authorId} · {item.organisation || "Organisation not provided"} · {formatInstant(item.contentCreatedAt || item.createdAt)}</small><p>{item.reportCount || 0} reports · {(item.reasons ?? []).map(reasonLabel).join(", ") || "Flagged submission"}</p></div><button className="secondary" type="button" onClick={() => setSelected(item)}>Review content</button></article>) : <p className="table-empty">No items match these filters.</p>}</div>}
    <div className="matching-actions">{page && <button className="secondary" type="button" disabled={loading} onClick={() => setPage(null)}>First page</button>}{data?.nextCursor && <button className="secondary" type="button" disabled={loading} onClick={() => setPage(data.nextCursor)}>Next page</button>}</div>
    {selected && <Modal labelledBy="moderation-review-title" onDismiss={() => { if (!busy) setSelected(null); }}><form onSubmit={submit}>
      <div className="modal-head"><h2 id="moderation-review-title">Review {selected.contentType}</h2></div><div className="modal-body moderation-review-body">
        {context ? <><ContextBody title="Content" content={context.content} contentType={selected.contentType} onDownload={download} /><ContextBody title="Parent context" content={context.parent} contentType={context.parent?.contentType} onDownload={download} />
          {selected.contentType === "comment" && <p className="field-hint">Comments are recorded off-chain and do not have an on-chain audit receipt.</p>}
          {auditTarget && <p><button type="button" className="text-button" disabled={relatedAudit?.loading} onClick={openRelatedAudit}>{relatedAudit?.loading ? "Loading audit receipt…" : selected.contentType === "comment" ? "View parent audit receipt" : "View audit receipt"}</button></p>}
          <h3>Reports</h3>{context.reports?.length ? context.reports.map((report, index) => <p key={report.id || index}><strong>{reasonLabel(report.reason)}</strong> · {report.reporterId} · {formatInstant(report.createdAt)}{report.details ? ` — ${report.details}` : ""}</p>) : <p>No member reports. This item was flagged for review.</p>}
          {context.reportsTruncated && <p className="field-hint">Showing the first 100 reports.</p>}
          <h3>Moderation history</h3>{context.history?.length ? context.history.map((entry, index) => <p key={entry.id || index}>{entry.action} · {reasonLabel(entry.reason)} · {formatInstant(entry.createdAt)}{entry.details ? ` — ${entry.details}` : ""}<small className="table-row-meta">By {entry.actorId} · Record {entry.id} · On-chain recording pending</small></p>) : <p>No prior decisions.</p>}
          {context.historyTruncated && <p className="field-hint">Showing the first 100 moderation decisions.</p>}
          <label htmlFor="moderation-action">Action</label><select id="moderation-action" required disabled={busy} value={action} onChange={(event) => setAction(event.target.value)}><option value="">Choose an action</option><option value="hide">Hide from public view</option><option value="remove">Remove from workflow</option><option value="restore">Restore content</option></select>
          <label htmlFor="moderation-reason">Reason</label><select id="moderation-reason" required disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)}><option value="">Choose a reason</option>{MODERATION_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <label htmlFor="moderation-details">Additional explanation (optional)</label><textarea id="moderation-details" rows={3} maxLength={2000} value={details} disabled={busy} onChange={(event) => setDetails(event.target.value)} />
          <p className="field-hint">The author receives a private notice. Hide and remove refund affected mock pledges; confirmed funds remain locked. Restoring content does not recreate refunded contributions.</p>
        </> : !contextError && <p role="status">Loading full context…</p>}
        {contextError && <p role="alert" className="error-banner">{contextError}</p>}
      </div><div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setSelected(null)}>Close</button><button type="submit" className="primary" disabled={busy || !context}>{busy ? "Recording…" : "Record moderation decision"}</button></div>
      </form></Modal>}
    {relatedAudit && <RelatedAuditReceiptPane kind={relatedAudit.kind} record={relatedAudit.record} loading={relatedAudit.loading} error={relatedAudit.error} onClose={() => { relatedAuditRequest.current += 1; setRelatedAudit(null); }} />}
  </section>;
}
