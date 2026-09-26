import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../config/proposal.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { RECOMMENDATIONS, recommendationLabel } from "../lib/comments.js";
import { downloadAttachment, saveBlobAs } from "../lib/attachments.js";
import { formatInstant } from "../lib/datetime.js";
import { matchingError, proposalFundingStatus, selectMockProposal } from "../lib/matching.js";
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

// Dot colour for the evaluator summary. Advisory only: it echoes the label
// beside it and never stands alone.
function recommendationTone(row) {
  const counts = row.recommendations ?? {};
  if (!row.qualifyingCount) return "neutral";
  if ((counts.do_not_recommend || 0) > (counts.recommend || 0) + (counts.recommend_with_revisions || 0)) return "danger";
  return "brand";
}

const FILTERS = [["", "All"], ...RECOMMENDATIONS];

export function ProposalComparison({ problemId, refreshKey = "", onSelected, onNavigate }) {
  const { user } = useAuth();
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [outcome, setOutcome] = useState("");
  const [sort, setSort] = useState("title:asc");
  const [openId, setOpenId] = useState("");
  const [selectedId, setSelectedId] = useState("");
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
  // Only a row the server still marks selectable can stay chosen after a reload.
  const selected = showDecision ? state?.rows?.find((row) => row.id === selectedId && row.canSelect) ?? null : null;
  const selectableCount = (state?.rows ?? []).filter((row) => row.canSelect).length;

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
      setSelectedId("");
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
    <p className="field-hint">Each problem is matched with a single proposal. Evaluator recommendations are optional and advisory. The problem owner can select any eligible, fully funded proposal without one.</p>

    <div className="comparison-controls">
      <div className="segmented" role="group" aria-label="Filter by evaluator recommendation">
        {FILTERS.map(([value, label]) => (
          <button key={value || "any"} type="button" className={outcome === value ? "selected" : ""}
            aria-pressed={outcome === value} onClick={() => setOutcome(value)}>{label}</button>
        ))}
      </div>
      <div className="comparison-controls-end">
        {state && <span className="comparison-count">
          {rows.length} {rows.length === 1 ? "proposal" : "proposals"}{showDecision ? ` · ${selectableCount} selectable` : ""}
        </span>}
        <label className="comparison-sort">
          <span className="sr-only">Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            {COMPARISON_SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
    </div>

    {error && !pending && <p className="error-banner" role="alert">{error}</p>}
    {loading && !state ? <p role="status">Loading comparison…</p> : null}
    {state && rows.length === 0 && <p className="comparison-empty">{state.rows?.length ? "No proposals match this recommendation." : "No submitted proposals to compare yet."}</p>}
    {state && rows.length > 0 && <div className="comparison-list" role={showDecision ? "radiogroup" : undefined} aria-label={showDecision ? "Choose the proposal to match" : undefined}>
      {rows.map((row) => <ComparisonRow key={row.id} row={row} problemMatching={state.problemMatching} showDecision={showDecision}
        open={openId === row.id} checked={selected?.id === row.id}
        onToggle={() => setOpenId((current) => current === row.id ? "" : row.id)}
        onOpen={() => onNavigate?.(`proposal/${row.id}`)}
        onChoose={() => setSelectedId((current) => current === row.id ? "" : row.id)} />)}
    </div>}
    {state?.truncated && <p className="field-hint">Showing the first 200 proposals.</p>}

    {selected && !pending && <div className="selection-bar-wrap">
      <div className="selection-bar" role="region" aria-label="Selected proposal">
        <span className="selection-bar-text">
          <span className="muted">Selected </span><strong>{selected.title}</strong>
          <span className="muted"> · {money(selected.currency, selected.amount)}</span>
        </span>
        <button type="button" className="text-button" onClick={() => setSelectedId("")}>Clear</button>
        <button type="button" className="primary" onClick={() => { setError(""); setRationale(""); setPending(selected); }}>Confirm match</button>
      </div>
    </div>}

    {pending && <Modal labelledBy="comparison-select-title" onDismiss={() => { if (!busy) setPending(null); }}>
      <form onSubmit={select}>
        <div className="modal-head"><h2 id="comparison-select-title">Select this proposal?</h2></div>
        <div className="modal-body">
          <div className="selection-summary">
            <span>{pending.title}</span>
            <strong>{money(pending.currency, pending.amount)}</strong>
          </div>
          <p>Selecting records your acceptance as the problem owner and your rationale in the audit record. Funding for the other proposals pauses while the researcher confirms. Recommendations are optional and advisory: this does not mark the proposal as the highest scored or the preferred submission.</p>
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

function ComparisonRow({ row, problemMatching, showDecision, open, checked, onToggle, onOpen, onChoose }) {
  const funding = proposalFundingStatus(row, problemMatching);
  const eligible = Boolean(row.canSelect);
  const decision = showDecision && !eligible ? row.selectionHint : "";
  return <article className={`comparison-card${checked ? " is-checked" : ""}${showDecision && !eligible ? " is-ineligible" : ""}`}>
    {showDecision && <button type="button" role="radio" className="comparison-radio" aria-checked={checked} disabled={!eligible}
      aria-label={`Select ${row.title}`} title={eligible ? undefined : row.selectionHint || "Not selectable"} onClick={onChoose} />}
    <div className="comparison-card-body">
      <div className="comparison-card-head">
        <button type="button" className="comparison-expand" aria-expanded={open}
          aria-label={open ? `Hide details for ${row.title}` : `Show details for ${row.title}`} onClick={onToggle}>
          <span className="comparison-title">
            <strong>{row.title}</strong>
            <svg className={`comparison-chevron${open ? " open" : ""}`} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
          </span>
          <span className="comparison-sub">{developerLabel(row)} · {row.organisation || "Organisation unavailable"} · {categoryLabel(row.category)}</span>
        </button>
        {decision && <span className="comparison-decision">{decision}</span>}
      </div>
      <dl className="comparison-metrics">
        <div><dt>Requested</dt><dd className="numeric">{money(row.currency, row.amount)}</dd></div>
        <div><dt>Evaluators</dt><dd><span className={`dot dot-${recommendationTone(row)}`} aria-hidden="true" />{recommendationSummary(row)}</dd></div>
        <div><dt>Comments</dt><dd>{row.commentCount ? `${row.qualifyingCount || 0} qualifying · ${row.commentCount} total` : "None yet"}</dd></div>
        <div>
          <dt>Funding status</dt>
          <dd className="funding-status">
            <span className={`funding-pill tone-${funding.tone}`}>{funding.label}</span>
            {funding.detail && <small>{funding.detail}</small>}
          </dd>
        </div>
      </dl>
      <button type="button" className="text-button comparison-open" onClick={onOpen}>Go to proposal</button>
      {open && <div className="comparison-detail"><ExpandedProposal proposalId={row.id} /></div>}
    </div>
  </article>;
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
