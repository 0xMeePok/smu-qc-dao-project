import { ProposalList } from "./ProposalList.jsx";
import { ProposalTracker } from "./ProposalTracker.jsx";
import { ACTION_ITEMS_KEY, QUEUE_FILTERS, listActionItems, listEvaluatorQueue, queueError, sortProposalRows } from "../lib/proposalQueues.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SelectProposalDialog } from "./ProposalComparison.jsx";
import { SelectionResponseDialog } from "./MatchingPanel.jsx";
import { OwnerReviewForm } from "./OwnerReviewPanel.jsx";
import { MockFundingPortfolio } from "./MockFundingPortfolio.jsx";
import { AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { isEscrowRegistry } from "../../../firebase/functions/escrowAudit.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { collection, getDocs, limit, orderBy, query, startAfter, where } from "firebase/firestore";
import { db } from "../lib/firebase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Modal } from "./Modal.jsx";
import { POSTING_STATUS_DRAFT, deletePosting, findPosting, listOwnPostings } from "../lib/postings.js";
import { RELATED_AUDIT_KIND, RelatedAuditReceiptPane } from "./RelatedAuditReceiptPane.jsx";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { formatInstant } from "../lib/datetime.js";
import { ExpiryCountdown } from "./ExpiryCountdown.jsx";
import { eventWorkflowStatus, expiryReasonLabel, opportunityWorkflowStatus } from "../config/workflowStatus.js";
import { EvaluationBadges, StatusBadge } from "./StatusBadge.jsx";
import { problemMatchingLocked } from "../lib/matching.js";
import { ROLE_LABELS } from "../config/roles.js";
import { VerifiedBadge } from "./VerifiedBadge.jsx";
import { EscrowReleaseSummary } from "./EscrowReleaseSummary.jsx";
import { escrowEventLabel, escrowExplorer, escrowFundingAmount } from "../lib/escrowFunding.js";

function RoleBadge({ role }) {
  return <span className="role-chip">{ROLE_LABELS[role] || role}</span>;
}

function ProfileLink({ address, label, onNavigate }) {
  if (!address) return null;
  return (
    <button
      className="profile-link"
      type="button"
      onClick={() => onNavigate(`profile/${address}`)}
    >
      {label}
    </button>
  );
}

export function MyProblems({ onNavigate }) {
  const { user } = useAuth();
  const [data, setData] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const cursor = useRef(null);
  const generation = useRef(0);
  const loadingPage = useRef(false);
  const [hasMore, setHasMore] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (append = false) => {
    if (!user?.id || !db) {
      setLoading(false);
      return;
    }
    if (append && loadingPage.current) return;
    const version = append ? generation.current : ++generation.current;
    loadingPage.current = true;
    setLoading(true);
    try {
      const page = await listOwnPostings(user.id, { cursor: append ? cursor.current : null });
      if (version !== generation.current) return;
      cursor.current = page.cursor;
      setHasMore(page.hasMore);
      setData((previous) => append
        ? [...previous, ...page.items.filter((item) => !previous.some((old) => old.id === item.id))]
        : page.items);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      if (version === generation.current) { loadingPage.current = false; setLoading(false); }
    }
  }, [user?.id]);

  useEffect(() => { setData([]); setHasMore(false); load(); return () => { generation.current++; }; }, [load]);

  const drafts = data.filter((item) => item.status === POSTING_STATUS_DRAFT);
  const published = data.filter((item) => item.status !== POSTING_STATUS_DRAFT);

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await deletePosting(pendingDelete);
      setPendingDelete(null);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setDeleting(false);
    }
  };

  function Row({ item, isDraft }) {
    const live = !isDraft && ["submitted", "open"].includes(item.status);
    // A selection or committed funding freezes the posting (the dual lock), so
    // the row says so instead of "Open", and editing is withdrawn.
    const locked = live && problemMatchingLocked(item);
    return (
      <div className="table-row">
        <div>
          <strong>{item.title || "Untitled draft"}</strong>
          <small className="table-row-meta">
            {isDraft ? "Last saved " : "Submitted "}
            {formatInstant(item.updatedAt)}
          </small>
          <StatusBadge status={opportunityWorkflowStatus(item)} />
          {live && (
            <ExpiryCountdown expiresAt={item.expiresAt} status={item.status} matching={item.matching} />
          )}
        </div>
        <div className="table-row-actions">
          <VerifiedBadge audit={item.audit} recordStatus={item.status} hidePending />
          <button
            className="text-button"
            type="button"
            onClick={() => onNavigate(isDraft
              ? (item.opportunityType === OPEN_FUNDING_TYPE ? `create-funding/${item.id}` : `create/${item.id}`)
              : `posting/${item.id}`)}
          >
            {isDraft ? "Resume editing" : "View"}
          </button>
          {live && !locked && (
            <button
              className="text-button"
              type="button"
              onClick={() => onNavigate(`edit-posting/${item.id}`)}
            >
              Edit
            </button>
          )}
          {isDraft && (
            <button
              className="text-button danger-text"
              type="button"
              onClick={() => setPendingDelete(item)}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="page dashboard-page">
      <div className="page-heading">
        <div className="eyebrow-row">
          <RoleBadge role="owner" />
          <span>Organization: {user?.org}</span>
        </div>
        <h1>My Problem Statements</h1>
        <p>Manage your published research challenges, track submission deadlines, and evaluate inbound researcher proposals.</p>
      </div>

      {error && (
        <div className="error-banner" role="alert" style={{ padding: "1rem" }}>
          <strong>Error:</strong> {error.message}
        </div>
      )}

      {/* Drafts are visible only here, and only to their owner. */}
      <div className="card-table">
        <div className="table-header">
          <h3>Drafts {drafts.length > 0 && <span className="count-pill">{drafts.length}</span>}</h3>
          <button className="primary small" type="button" onClick={() => onNavigate("create")}>+ New Brief</button>
        </div>
        {loading ? (
          <div className="table-empty">Loading…</div>
        ) : drafts.length === 0 ? (
          <div className="table-empty">No drafts. Start a brief and save it to finish later.</div>
        ) : (
          drafts.map((item) => <Row item={item} isDraft key={item.id} />)
        )}
      </div>

      <div className="card-table">
        <div className="table-header">
          <h3>Published Problem Statements</h3>
        </div>
        {loading ? (
          <div className="table-empty">Loading…</div>
        ) : published.length === 0 ? (
          <div className="table-empty">Nothing published yet.</div>
        ) : (
          published.map((item) => <Row item={item} isDraft={false} key={item.id} />)
        )}
      </div>

      {hasMore && <button type="button" className="secondary" disabled={loading} onClick={() => load(true)}>
        {loading ? "Loading…" : "Load older opportunities"}
      </button>}
      <ProposalList received onNavigate={onNavigate} />
      {isEscrowRegistry(AUDIT_REGISTRY_CONFIG) && <EscrowReleaseSummary onNavigate={onNavigate} />}

      {isEscrowRegistry(AUDIT_REGISTRY_CONFIG)
        ? <p className="field-hint">Open a proposal’s escrow to view your wallet contribution, vote on delivery, or claim an available refund.</p>
        : <MockFundingPortfolio onNavigate={onNavigate} />}

      {pendingDelete && (
        <Modal
          labelledBy="delete-draft-title"
          describedBy="delete-draft-desc"
          onDismiss={() => setPendingDelete(null)}
        >
          <div className="modal-head">
            <div>
              <h2 id="delete-draft-title">Delete this draft?</h2>
              <p id="delete-draft-desc">
                <strong>{pendingDelete.title || "Untitled draft"}</strong> and any files
                attached to it will be permanently removed. This cannot be undone.
              </p>
            </div>
          </div>
          <div className="modal-actions">
            <button className="secondary" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>
              Keep it
            </button>
            <button className="danger-btn" type="button" disabled={deleting} onClick={confirmDelete}>
              {deleting ? "Deleting…" : "Delete draft"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** QCDAO-91. The member's open actions; shared by the tab count and the page. */
export function useActionItems() {
  const { user } = useAuth();
  return useQuery({ queryKey: [...ACTION_ITEMS_KEY, user?.id], queryFn: listActionItems,
    enabled: Boolean(user?.id), staleTime: 30_000 });
}

const money = (currency, amount) => `${currency || ""} ${Number(amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`.trim();

const NOTICES = {
  select: "Selection recorded. The proposal's creator now has until the acceptance deadline to respond.",
  confirm: "Your acceptance is recorded. Funds are locked only once both parties have accepted.",
  decline: "Selection rejected. Its funders are refunded and the other proposals reopen.",
  review: "Review recorded. The developer can see it on their proposal.",
};

function ActionRow({ item, meta, children, onNavigate }) {
  return <div className="table-row">
    <div>
      <strong>{item.title || "Untitled proposal"}</strong>
      <small className="table-row-meta">Proposal for: {item.posting?.title || "Untitled opportunity"}</small>
      <span className="status-badges">
        <StatusBadge status={item.workflowStatus} />
        {item.recommendations && <EvaluationBadges counts={item.recommendations} />}
      </span>
      {meta && <small className="table-row-meta">{meta}</small>}
    </div>
    <div className="table-row-actions">
      {children}
      <button className="text-button" type="button" onClick={() => onNavigate(`proposal/${item.id}`)}>View proposal</button>
    </div>
  </div>;
}

function ActionGroup({ title, hint, items, render }) {
  if (!items?.length) return null;
  return <div className="card-table">
    <div className="table-header"><h3>{title} <span className="count-pill">{items.length}</span></h3></div>
    {hint && <p className="field-hint action-group-hint">{hint}</p>}
    {items.map(render)}
  </div>;
}

/** QCDAO-91 - everything waiting on this member, acted on in place. */
export function ActionNeeded({ onNavigate }) {
  const queryClient = useQueryClient();
  const { data, error, isPending, isFetching, refetch } = useActionItems();
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState("");
  const open = (kind, item) => { setNotice(""); setDialog({ kind, item }); };
  const done = async (kind) => {
    setDialog(null);
    setNotice(NOTICES[kind]);
    await queryClient.invalidateQueries({ queryKey: ACTION_ITEMS_KEY });
  };
  const owner = data?.owner ?? {};
  const evaluator = data?.evaluator;

  return <section className="page dashboard-page">
    <div className="page-heading">
      <h1>Action Needed</h1>
      <p>Everything waiting on you, across every role you hold. Act here, or open the proposal for the full context.</p>
    </div>
    {notice && <p className="proposal-success" role="status">{notice}</p>}
    {isPending ? <p className="table-empty" role="status">Loading your actions…</p>
      : error ? <div className="card-table"><p className="error-banner" role="alert">{queueError(error)}</p>
        <button className="secondary" type="button" onClick={() => refetch()}>Retry</button></div>
      : !data?.total ? <div className="card-table"><p className="table-empty">Nothing needs your attention right now.</p></div>
      : <>
        <ActionGroup title="Ready to select" items={owner.readyToSelect}
          hint="Fully funded proposals on your problems. Selecting records your acceptance and starts the creator's acceptance window."
          render={(item) => <ActionRow key={`select-${item.id}`} item={item} onNavigate={onNavigate}
            meta={`Submitted ${formatInstant(item.submittedAt)} · Funded ${money(item.currency, item.fundedAmount)} of ${money(item.currency, item.amount)}`}>
            <button className="primary" type="button" disabled={isFetching} onClick={() => open("select", item)}>Select…</button>
          </ActionRow>} />
        <ActionGroup title="Awaiting my review" items={owner.awaitingReview}
          hint="Submitted proposals on your problems with no owner review yet. A review is feedback only; it does not select a winner."
          render={(item) => <ActionRow key={`review-${item.id}`} item={item} onNavigate={onNavigate}
            meta={`Submitted ${formatInstant(item.submittedAt)}${item.canSelect ? " · Fully funded, ready to select" : ""}`}>
            {Object.hasOwn(item, "fundingTerms")
              ? <button className="secondary" type="button" onClick={() => onNavigate(`proposal/${item.id}`)}>Review proposal</button>
              : <button className="secondary" type="button" disabled={isFetching} onClick={() => open("review", item)}>Record review…</button>}
            {item.canSelect && <button className="primary" type="button" disabled={isFetching} onClick={() => open("select", item)}>Select…</button>}
          </ActionRow>} />
        <ActionGroup title="Selection to accept" items={data.researcher?.selectionToAccept}
          hint="An owner selected your proposal. Accept or reject it before the deadline, or the posting is invalidated."
          render={(item) => <ActionRow key={`accept-${item.id}`} item={item} onNavigate={onNavigate}
            meta={<>Submitted {formatInstant(item.submittedAt)} · Respond by <ExpiryCountdown expiresAt={item.deadlineAt} showInstant={false} /></>}>
            <button className="primary" type="button" disabled={isFetching} onClick={() => open("confirm", item)}>Accept…</button>
            <button className="secondary" type="button" disabled={isFetching} onClick={() => open("decline", item)}>Reject…</button>
          </ActionRow>} />
        <ActionGroup title="Awaiting my recommendation" items={evaluator?.awaitingRecommendation}
          hint="Proposals you have not recommended yet. Each evaluator files their own recommendation on the proposal page."
          render={(item) => <ActionRow key={`recommend-${item.id}`} item={item} onNavigate={onNavigate}
            meta={`Submitted ${formatInstant(item.submittedAt)}`}>
            <button className="primary" type="button" onClick={() => onNavigate(`proposal/${item.id}`)}>Recommend</button>
          </ActionRow>} />
        {evaluator?.more && <p className="field-hint">More proposals are waiting. <button className="text-button" type="button" onClick={() => onNavigate("evaluations")}>Open the evaluation queue</button></p>}
        {data.truncated && <p className="field-hint">Showing the first 200 records. Open a problem from My Problems for the rest.</p>}
      </>}

    {dialog?.kind === "select" && <SelectProposalDialog problemId={dialog.item.problemId} proposal={dialog.item}
      onCancel={() => setDialog(null)} onSelected={() => done("select")} />}
    {(dialog?.kind === "confirm" || dialog?.kind === "decline") && <SelectionResponseDialog kind={dialog.kind}
      problemId={dialog.item.problemId} proposal={dialog.item} onCancel={() => setDialog(null)} onDone={done} />}
    {dialog?.kind === "review" && <Modal labelledBy="action-review-title" onDismiss={() => setDialog(null)}>
      <div className="modal-head"><h2 id="action-review-title">Record owner review</h2></div>
      <div className="modal-body">
        <strong>{dialog.item.title}</strong>
        <p className="field-hint">Written feedback from the designated problem owner. It does not select or reject a winner.</p>
        <OwnerReviewForm proposalId={dialog.item.id} revisionPathOpen={dialog.item.revisionPathOpen} onSaved={() => done("review")} />
      </div>
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setDialog(null)}>Cancel</button></div>
    </Modal>}
  </section>;
}

export function ResearcherProposals({ onNavigate }) {
  return <section className="page dashboard-page">
    <div className="page-heading">
      <h1>My Research Proposals</h1>
      <p>Track submissions to posted problems and independent listings you have published. Unfinished drafts resume below — independent drafts open the independent form, not a parent opportunity.</p>
    </div>
    <ProposalTracker onNavigate={onNavigate} />
    <ProposalList draftsOnly onNavigate={onNavigate} />
    {isEscrowRegistry(AUDIT_REGISTRY_CONFIG) && <EscrowReleaseSummary onNavigate={onNavigate} />}
  </section>;
}

/**
 * QCDAO-63 - solutions still awaiting this evaluator's recommendation comment.
 * Assignment model: an administrator grants the evaluator access level, and the
 * evaluator then self-selects from every live posting's eligible solutions.
 */
export function EvaluatorQueue({ onNavigate }) {
  const [filter, setFilter] = useState("pending");
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (nextFilter, nextCursor = null) => {
    setLoading(true); setError("");
    try {
      const data = await listEvaluatorQueue({ filter: nextFilter, ...(nextCursor ? { cursor: nextCursor } : {}) });
      setRows((current) => (nextCursor ? [...current, ...(data?.items ?? [])] : (data?.items ?? [])));
      setCursor(data?.nextCursor ?? null);
    } catch (err) {
      setError(queueError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(filter); }, [filter, load]);

  // Earliest deadline first: the tightest response window needs the recommendation most.
  const visible = useMemo(() => sortProposalRows(rows, "closing"), [rows]);

  return (
    <section className="page dashboard-page">
      <div className="page-heading">
        <div className="eyebrow-row">
          <RoleBadge role="evaluator" />
          <span>Assigned by a DAO administrator</span>
        </div>
        <h1>Evaluation queue</h1>
        <p>Open a solution with its posting for context, then leave your recommendation. Each evaluator files their own.</p>
      </div>

      <div className="admin-tabs-nav" role="tablist" aria-label="Recommendation status">
        {QUEUE_FILTERS.map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={filter === value}
            className={`admin-tab-btn ${filter === value ? "active" : ""}`}
            onClick={() => { if (value !== filter) { setRows([]); setCursor(null); setFilter(value); } }}>
            {label}
          </button>
        ))}
      </div>

      <div className="card-table">
        <div className="table-header"><h3>{filter === "submitted" ? "My recommendations" : "Awaiting recommendation"}</h3></div>
        {loading && !visible.length ? <p className="table-empty" role="status">Loading queue…</p>
          : error ? <p className="error-banner" role="alert">{error}</p>
          : !visible.length ? <p className="table-empty">
              {filter === "submitted" ? "You have not recommended a solution yet." : "No solution is waiting for a recommendation."}
            </p>
          : visible.map((item) => <div className="table-row" key={item.id}>
            <div>
              <strong>{item.title || "Untitled proposal"}</strong>
              <small className="table-row-meta">Proposal for: {item.posting?.title || "Untitled posting"} · Submitted {formatInstant(item.submittedAt)}</small>
              <span className="status-badges">
                <StatusBadge status={item.workflowStatus} />
                {item.recommendationStatus === "submitted"
                  ? <StatusBadge status={item.recommendation} prefix="My recommendation · " />
                  : <EvaluationBadges counts={item.recommendations ?? {}} />}
              </span>
            </div>
            <div className="table-row-actions">
              <ExpiryCountdown expiresAt={item.posting?.expiresAt} status={item.posting?.status} matching={item.posting?.matching} showInstant={false} />
              {item.posting?.id && <button className="text-button" type="button" onClick={() => onNavigate(`posting/${item.posting.id}`)}>View posting</button>}
              <button className="text-button" type="button" onClick={() => onNavigate(`proposal/${item.id}`)}>Open proposal</button>
            </div>
          </div>)}
        {cursor && <button className="secondary" type="button" disabled={loading} onClick={() => load(filter, cursor)}>
          {loading ? "Loading…" : "Load more"}
        </button>}
      </div>
    </section>
  );
}

export { FunderDashboard as FundingPortfolio } from "./FunderDashboard.jsx";

const AUDIT_PAGE_SIZE = 50;

const AUDIT_FILTERS = {
  all: { label: "All Events", types: null },
  role_change: { label: "Role Changes", types: ["role_change"] },
  suspension: { label: "Suspensions & Reinstatements", types: ["suspension_change"] },
  opportunity_expired: { label: "Opportunity Expiries", types: ["opportunity_expired"] },
  escrow: { label: "Escrow & Funding", types: ["escrow"] },
};

function auditBadge(item) {
  if (item.type === "escrow") return ["badge-system", escrowEventLabel(item.eventType || item.action)];
  if (item.type === "role_change" || item.action === "ROLE_CHANGE") return ["badge-role-change", "ROLE TRANSITION"];
  if (item.type === "suspension_change" || item.action?.includes("SUSPEND")) {
    return ["badge-suspension", item.newState ? "ACCOUNT SUSPENDED" : "ACCOUNT REINSTATED"];
  }
  if (item.type === "opportunity_expired") {
    return ["badge-system", item.action === "OPPORTUNITY_FORCE_EXPIRED" ? "OPPORTUNITY FORCE-EXPIRED" : "OPPORTUNITY LAPSED"];
  }
  return ["badge-system", item.action || "SYSTEM EVENT"];
}

export function AdminAudit() {
  const { user } = useAuth();
  const [data, setData] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [filterType, setFilterType] = useState("all");
  const [relatedAudit, setRelatedAudit] = useState(null);
  const cursorRef = useRef(null);
  const relatedAuditRequest = useRef(0);
  const PAGE_SIZE = AUDIT_PAGE_SIZE;

  const fetchAudits = async ({ append = false } = {}) => {
    if (!user?.id || !db) {
      setLoading(false);
      return;
    }
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setData([]);
      cursorRef.current = null;
      setHasMore(false);
    }
    setError(null);
    try {
      const constraints = [];
      const { types } = AUDIT_FILTERS[filterType] ?? AUDIT_FILTERS.all;
      if (types) constraints.push(where("type", "in", types));
      constraints.push(orderBy("timestamp", "desc"));
      if (append && cursorRef.current) constraints.push(startAfter(cursorRef.current));
      constraints.push(limit(PAGE_SIZE));
      const querySnapshot = await getDocs(query(collection(db, "audits"), ...constraints));
      const items = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      cursorRef.current = querySnapshot.docs[querySnapshot.docs.length - 1] || null;
      setHasMore(querySnapshot.docs.length === PAGE_SIZE);
      setData((current) => append ? [...current, ...items] : items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    relatedAuditRequest.current += 1;
    setRelatedAudit(null);
    fetchAudits();
  }, [user?.id, filterType]);

  const openListingAudit = async (id) => {
    if (!id) return;
    const request = ++relatedAuditRequest.current;
    setRelatedAudit({ kind: RELATED_AUDIT_KIND.LISTING, loading: true, record: null, error: "" });
    try {
      const record = await findPosting(id);
      if (request !== relatedAuditRequest.current) return;
      setRelatedAudit({
        kind: RELATED_AUDIT_KIND.LISTING,
        loading: false,
        record,
        error: record ? "" : "This listing is no longer available, so its verification receipt cannot be opened.",
      });
    } catch (err) {
      if (request !== relatedAuditRequest.current) return;
      setRelatedAudit({
        kind: RELATED_AUDIT_KIND.LISTING,
        loading: false,
        record: null,
        error: err?.message || "The audit receipt could not be loaded. Try again.",
      });
    }
  };

  return (
    <div className="card-table">
      <div className="table-header">
        <div>
          <h3>System Audit Trail & Governance Events</h3>
          <p className="table-subtitle">Role transitions, account suspensions, opportunity expiries, and confirmed escrow funding events.</p>
        </div>
        <div className="audit-header-actions">
          <select
            className="audit-filter-select"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            aria-label="Filter audit log entries"
          >
            {Object.entries(AUDIT_FILTERS).map(([value, { label }]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <button className="secondary small" type="button" onClick={() => fetchAudits()} title="Refresh Audit Log">
            ↻ Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: "2rem", textAlign: "center" }}>Loading audit records...</div>
      ) : error ? (
        <div className="error-banner" style={{ padding: "1.5rem", margin: "1rem" }}>
          <strong>Error loading audit log:</strong> {error.message}
        </div>
      ) : data.length === 0 ? (
        <div style={{ padding: "2.5rem", textAlign: "center", color: "#888" }}>
          No audit events found for the selected filter.
        </div>
      ) : (
        <>
          <div className="audit-table-scroll" role="region" aria-label="Governance audit events" tabIndex={0}>
            <table className="audit-nav-table">
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Summary</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {data.map((item) => {
                  const [badgeClass, eventLabel] = auditBadge(item);
                  const isRoleChange = badgeClass === "badge-role-change";
                  const isSuspension = badgeClass === "badge-suspension";
                  const isExpiry = item.type === "opportunity_expired";
                  const isEscrow = item.type === "escrow";
                  const dateStr = item.timestamp?.toDate
                    ? formatInstant(item.timestamp)
                    : item.createdAt?.toDate
                      ? formatInstant(item.createdAt)
                      : "Recent";
                  const summary = isEscrow ? item.title || item.proposalId || "Escrow activity" : isExpiry
                    ? item.targetName || item.targetId || item.title || "Opportunity"
                    : isRoleChange
                      ? `${item.actorName || item.actor} → ${item.targetName || item.targetAddress}`
                      : isSuspension
                        ? `${item.actorName || item.actor} ${item.newState ? "suspended" : "reinstated"} ${item.targetName || item.targetAddress}`
                        : (item.title || item.action || "Audit Record");

                  return (
                    <tr className="audit-nav-row" key={item.id}>
                      <td>
                        <span className={`audit-type-badge ${badgeClass}`}>{eventLabel}</span>
                        {eventWorkflowStatus(item.type) && <StatusBadge status={eventWorkflowStatus(item.type)} />}
                      </td>
                      <td>
                        {summary}
                        {isEscrow ? <>
                          <div className="table-row-meta">{escrowFundingAmount(item.amountBaseUnits, item.tokenDecimals, item.tokenSymbol)} · Actor: {item.actor || "—"} · Counterparty: {item.counterparty || "—"}</div>
                          <div className="table-row-meta">{item.proposalId && `Proposal: ${item.proposalId}`} {item.problemId && `· Posting: ${item.problemId}`}</div>
                          {item.transactionHash && <a href={escrowExplorer("tx", item.transactionHash)} target="_blank" rel="noreferrer">View verified transaction</a>}
                        </> : null}
                        {isExpiry ? (
                          <>
                            {item.reason && <div className="table-row-meta">Lapse reason: {expiryReasonLabel(item.reason)}.</div>}
                            {item.targetId && <div className="table-row-meta">Reference: <code>problems/{item.targetId}</code></div>}
                            {(item.targetId || item.target) && (
                              <button
                                type="button"
                                className="text-button"
                                disabled={relatedAudit?.loading}
                                onClick={() => openListingAudit(item.targetId || item.target)}
                              >
                                {relatedAudit?.loading ? "Loading receipt…" : "View receipt"}
                              </button>
                            )}
                          </>
                        ) : (
                          item.reason && <div className="table-row-meta">{item.reason}</div>
                        )}
                      </td>
                      <td>{dateStr}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        {hasMore && (
          <div className="submission-log-more">
            <button className="secondary" type="button" disabled={loadingMore} onClick={() => fetchAudits({ append: true })}>
              {loadingMore ? "Loading…" : "Load older events"}
            </button>
          </div>
        )}
        </>
      )}
      {relatedAudit && (
        <RelatedAuditReceiptPane
          kind={relatedAudit.kind}
          record={relatedAudit.record}
          loading={relatedAudit.loading}
          error={relatedAudit.error}
          onClose={() => { relatedAuditRequest.current += 1; setRelatedAudit(null); }}
        />
      )}
    </div>
  );
}
