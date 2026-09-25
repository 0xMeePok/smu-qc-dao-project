import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../config/proposal.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { RECOMMENDATIONS, recommendationLabel } from "../lib/comments.js";
import { downloadAttachment, saveBlobAs } from "../lib/attachments.js";
import { formatInstant } from "../lib/datetime.js";
import { matchingError, proposalFundingLabel, selectMockProposal } from "../lib/matching.js";
import { listReportableComments } from "../lib/moderation.js";
import { findProposal } from "../lib/proposals.js";
import { messageForProposalError } from "../lib/proposalValidation.js";
import {
  COMPARISON_SORTS, categoryLabel, comparisonError, filterComparisonRows, getProposalComparison,
  recommendationSummary, sortComparisonRows,
} from "../lib/proposalComparison.js";
import { Modal } from "./Modal.jsx";

const money = (currency, amount) => `${currency || ""} ${Number(amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`.trim();

function developerLabel(row) {
  return row.developerName || "Unnamed developer";
}

export function ProposalComparison({ problemId, refreshKey = "", onSelected, onNavigate }) {
  const { user } = useAuth();
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [outcome, setOutcome] = useState("");
  const [sort, setSort] = useState("title:asc");
  const [openId, setOpenId] = useState("");
  const [pending, setPending] = useState(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user?.id || !problemId) {
      setState(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    getProposalComparison(problemId)
      .then((next) => { if (!cancelled) setState(next); })
      .catch((err) => { if (!cancelled) { setState(null); setError(comparisonError(err)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [problemId, refreshKey, user?.id]);

  if (!user?.id || !problemId) return null;
  const rows = sortComparisonRows(filterComparisonRows(state?.rows, outcome), sort, state?.problemMatching);
  const showDecision = state?.viewerIsOwner === true;
  const select = async (event) => {
    event.preventDefault();
    if (!pending || busy) return;
    if (rationale.trim().length < 10) {
      setError("Enter a reason of at least 10 characters for the decision record.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await selectMockProposal({ problemId, proposalId: pending.id, rationale: rationale.trim() });
      const next = await getProposalComparison(problemId);
      setState(next);
      setPending(null);
      setRationale("");
      onSelected?.();
    } catch (err) {
      setError(matchingError(err));
    } finally {
      setBusy(false);
    }
  };

  return <section id="proposal-comparison" className="detail-section proposal-comparison" aria-label="Proposal comparison">
    <h2>Compare proposals</h2>
    <p className="field-hint">Evaluator recommendations are optional and advisory. The problem owner can select any eligible, fully funded proposal without one.</p>
    <div className="comparison-controls">
      <label>Filter by evaluator recommendation
        <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
          <option value="">Any outcome</option>
          {RECOMMENDATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>Sort
        <select value={sort} onChange={(event) => setSort(event.target.value)}>
          {COMPARISON_SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </div>
    {error && !pending && <p className="error-banner" role="alert">{error}</p>}
    {loading && !state ? <p role="status">Loading comparison…</p> : null}
    {state && rows.length === 0 && <p className="table-empty">{state.rows?.length ? "No proposals match this recommendation." : "No submitted proposals to compare yet."}</p>}
    {state && rows.length > 0 && <div className="comparison-scroll"><table className="comparison-table">
      <thead><tr>
        <th>Proposal</th><th>Developer and organisation</th><th>Quantum category</th><th>Requested funding</th>
        <th>Evaluator recommendation</th><th>Qualifying comments</th><th>Comments</th><th>Status</th>{showDecision && <th>Decision</th>}
      </tr></thead>
      <tbody>
        {rows.map((row) => <ComparisonRow key={row.id} row={row} problemMatching={state.problemMatching} showDecision={showDecision} open={openId === row.id}
          onToggle={() => setOpenId((current) => current === row.id ? "" : row.id)}
          onOpen={() => onNavigate?.(`proposal/${row.id}`)}
          onSelect={() => { setError(""); setRationale(""); setPending(row); }} />)}
      </tbody>
    </table></div>}
    {state?.truncated && <p className="field-hint">Showing the first 200 proposals.</p>}
    {pending && <Modal labelledBy="comparison-select-title" onDismiss={() => { if (!busy) setPending(null); }}>
      <form onSubmit={select}>
        <div className="modal-head"><h2 id="comparison-select-title">Select this proposal?</h2></div>
        <div className="modal-body">
          <strong>{pending.title}</strong>
          <p>Selecting records your acceptance as the problem owner and your rationale in the audit record. Recommendations are optional and advisory: this does not mark the proposal as the highest scored or the preferred submission.</p>
          <label htmlFor="comparison-rationale">Selection rationale</label>
          <textarea id="comparison-rationale" value={rationale} minLength={10} maxLength={2000} required rows={4} disabled={busy} onChange={(event) => setRationale(event.target.value)} />
          <p className="field-hint">Required. 10–2000 characters, recorded with your selection.</p>
          {error && <p className="error-banner" role="alert">{error}</p>}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : "Select and accept"}</button>
        </div>
      </form>
    </Modal>}
  </section>;
}

function ComparisonRow({ row, problemMatching, showDecision, open, onToggle, onOpen, onSelect }) {
  return <>
    <tr>
      <td>
        <div className="comparison-proposal-name">
          <button type="button" className="text-button comparison-expand" aria-expanded={open} aria-label={open ? `Hide details for ${row.title}` : `Show details for ${row.title}`} onClick={onToggle}>
            <svg className={`dropdown-chevron${open ? " open" : ""}`} viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <polyline points="6 9 10 13 14 9" />
            </svg>
          </button>
          <div>
            <strong>{row.title}</strong>
            <button type="button" className="text-button" onClick={onOpen}>Go to proposal</button>
          </div>
        </div>
      </td>
      <td>{developerLabel(row)}<small className="table-row-meta">{row.organisation || "Organisation unavailable"}</small></td>
      <td>{categoryLabel(row.category)}</td>
      <td>{money(row.currency, row.amount)}</td>
      <td>{recommendationSummary(row)}</td>
      <td>{row.qualifyingCount || 0}</td>
      <td>{row.commentCount || 0}</td>
      <td>{proposalFundingLabel(row, problemMatching)}</td>
      {showDecision && <td>
        {row.canSelect && <button type="button" className="primary" onClick={onSelect}>Select {row.title}</button>}
        {row.selectionHint && <p className="field-hint">{row.selectionHint}</p>}
      </td>}
    </tr>
    {open && <tr className="comparison-detail"><td colSpan={showDecision ? 9 : 8}><ExpandedProposal proposalId={row.id} /></td></tr>}
  </>;
}

function ExpandedProposal({ proposalId }) {
  const [proposal, setProposal] = useState(null);
  const [comments, setComments] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    findProposal(proposalId).then(async (record) => {
      if (cancelled) return;
      setProposal(record);
      if (!record) {
        setComments([]);
        setError("This proposal is no longer available.");
        return;
      }
      try {
        const discussion = await listReportableComments({ proposalId });
        if (!cancelled) setComments(discussion.items ?? []);
      } catch (err) {
        if (!cancelled) setError(messageForProposalError(err));
      }
    }).catch((err) => {
      if (!cancelled) setError(messageForProposalError(err));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [proposalId]);
  const download = async (attachment) => {
    try {
      saveBlobAs(await downloadAttachment({ attachment, ownerId: proposal.researcherId, problemId: proposal.id, scope: "proposals" }), attachment.name);
    } catch (err) {
      setError(messageForProposalError(err));
    }
  };
  if (loading) return <p role="status">Loading proposal…</p>;
  if (!proposal) return <p role="alert">{error || "This proposal could not be loaded."}</p>;
  const fields = [...PROPOSAL_FIELDS.slice(2), ...(proposal.opportunityType === OPEN_FUNDING_TYPE ? PROBLEM_FRAMING_FIELDS : [])];
  return <div className="comparison-proposal">
    {error && <p className="error-banner" role="alert">{error}</p>}
    <h3>{proposal.title}</h3>
    {proposal.summary && <p className="proposal-text">{proposal.summary}</p>}
    {fields.map(([key, label]) => proposal[key] && <div key={key}><h4>{label}</h4><p className="proposal-text">{proposal[key]}</p></div>)}
    {proposal.attachments?.length > 0 && <div><h4>Supporting attachments</h4>{proposal.attachments.map((item) => <p key={item.id}><button type="button" className="text-button" onClick={() => download(item)}>Download {item.name}</button></p>)}</div>}
    <h4>Evaluator comments</h4>
    {comments.length === 0 && <p>No comments on this proposal yet.</p>}
    {comments.map((item) => <CommentView key={item.id} item={item} />)}
  </div>;
}

function CommentView({ item, nested = false }) {
  const removed = Boolean(item.deleted || item.deletedAt);
  const outcome = !removed && item.qualifying && recommendationLabel(item.recommendation);
  const evaluator = item.badge === "evaluator" || item.authorRole === "evaluator";
  const role = evaluator ? "Evaluator" : item.authorRole === "administrator" ? "Administrator" : item.authorRole === "user" ? "User" : "";
  const chip = evaluator ? "role-chip-evaluator" : item.authorRole === "administrator" ? "role-chip-admin" : "role-chip-user";
  return <article className={nested ? "comment-reply" : "matching-candidate"}>
    {outcome && <p className="comment-recommendation">{outcome}</p>}
    <p className={removed ? "proposal-text comment-removed" : "proposal-text"}>{removed ? "This comment was removed" : item.body}</p>
    {!removed && <div className="comment-meta">
      <small>{item.authorName || "Member"} · {formatInstant(item.createdAt)}{item.editedAt ? " · Edited" : ""}</small>
      {role && <span className={`role-chip ${chip}`}>{role}</span>}
    </div>}
    {(item.replies || []).map((reply) => <CommentView key={reply.id} item={reply} nested />)}
  </article>;
}
