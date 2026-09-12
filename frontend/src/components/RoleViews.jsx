import { ProposalList } from "./ProposalList.jsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { collection, getDocs, limit, orderBy, query, startAfter, where } from "firebase/firestore";
import { db } from "../lib/firebase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Modal } from "./Modal.jsx";
import { POSTING_STATUS_DRAFT, deletePosting, listOwnPostings } from "../lib/postings.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { formatInstant } from "../lib/datetime.js";
import { ROLE_LABELS } from "../config/roles.js";

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
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!user?.id || !db) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setData(await listOwnPostings(user.id));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

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
    return (
      <div className="table-row">
        <div>
          <strong>{item.title || "Untitled draft"}</strong>
          <small className="table-row-meta">
            {isDraft ? "Last saved " : "Submitted "}
            {formatInstant(item.updatedAt)}
          </small>
        </div>
        <div className="table-row-actions">
          {isDraft && <span className="draft-badge">Draft</span>}
          {item.status === "cancelled" && <span className="draft-badge">Withdrawn</span>}
          <button
            className="text-button"
            type="button"
            onClick={() => onNavigate(isDraft
              ? (item.opportunityType === OPEN_FUNDING_TYPE ? `create-funding/${item.id}` : `create/${item.id}`)
              : `posting/${item.id}`)}
          >
            {isDraft ? "Resume editing" : "View"}
          </button>
          {!isDraft && ["submitted", "open"].includes(item.status) && (
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

      <ProposalList received onNavigate={onNavigate} />

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

export function ResearcherProposals({ onNavigate }) {
  return <section className="page dashboard-page"><div className="page-heading"><h1>My Research Proposals</h1><p>View your submissions, verification receipts and withdrawal history.</p></div><ProposalList onNavigate={onNavigate} /></section>;
}

export function EvaluatorQueue() {
  const { user } = useAuth();
  const [data, setData] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!user?.id || !db) {
        setLoading(false);
        return;
      }
      try {
        const q = query(collection(db, "evaluations"), where("evaluatorId", "==", user.id));
        const querySnapshot = await getDocs(q);
        setData(querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [user?.id]);

  return (
    <section className="page dashboard-page">
      <div className="page-heading">
        <div className="eyebrow-row">
          <RoleBadge role="evaluator" />
          <span>Panel: {user?.org}</span>
        </div>
        <h1>Evaluation queue</h1>
        <p>Review assigned submissions, assign criterion scores, and record your evaluation.</p>
      </div>

      <div className="card-table">
        <div className="table-header">
          <h3>Assigned submissions</h3>
        </div>
        
        {loading ? (
          <div style={{ padding: "2rem", textAlign: "center" }}>Loading...</div>
        ) : error ? (
          <div className="error-banner" style={{ padding: "2rem", color: "red" }}>
             <strong>Error:</strong> {error.message}
          </div>
        ) : data.length === 0 ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "#666" }}>No evaluations pending.</div>
        ) : (
          data.map(item => (
            <div className="table-row" key={item.id}>
              <div>
                <strong>{item.title}</strong>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function FundingPortfolio({ onNavigate }) {
  const { user } = useAuth();
  const [data, setData] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!user?.id || !db) {
        setLoading(false);
        return;
      }
      try {
        const q = query(collection(db, "funding"), where("funderId", "==", user.id));
        const querySnapshot = await getDocs(q);
        setData(querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [user?.id]);

  return (
    <section className="page dashboard-page">
      <div className="page-heading">
        <div className="eyebrow-row">
          <RoleBadge role="funder" />
          <span>Fund: {user?.org}</span>
        </div>
        <h1>Funding Commitments & Escrow</h1>
        <p>Oversee capital allocation, approve milestone disbursement tranches, and monitor portfolio performance.</p>
      </div>

      <ProposalList received onNavigate={onNavigate} />

      <div className="card-table">
        <div className="table-header">
          <h3>Disbursement Schedule</h3>
          <button className="primary small" type="button" onClick={() => onNavigate("create")}>+ New Funding Call</button>
        </div>
        
        {loading ? (
          <div style={{ padding: "2rem", textAlign: "center" }}>Loading...</div>
        ) : error ? (
          <div className="error-banner" style={{ padding: "2rem", color: "red" }}>
             <strong>Error:</strong> {error.message}
          </div>
        ) : data.length === 0 ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "#666" }}>No funding commitments found.</div>
        ) : (
          data.map(item => (
            <div className="table-row" key={item.id}>
              <div>
                <strong>{item.title}</strong>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function AdminAudit() {
  const { user } = useAuth();
  const [data, setData] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [filterType, setFilterType] = useState("all");
  const cursorRef = useRef(null);
  const PAGE_SIZE = 25;

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
      if (filterType === "role_change") constraints.push(where("type", "==", "role_change"));
      if (filterType === "suspension") constraints.push(where("type", "==", "suspension_change"));
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
    fetchAudits();
  }, [user?.id, filterType]);

  return (
    <div className="card-table">
      <div className="table-header">
        <div>
          <h3>System Audit Trail & Governance Events</h3>
          <p className="table-subtitle">Immutable log of role transitions, account suspensions, and platform state updates.</p>
        </div>
        <div className="audit-header-actions">
          <select
            className="audit-filter-select"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            aria-label="Filter audit log entries"
          >
            <option value="all">All Events</option>
            <option value="role_change">Role Changes</option>
            <option value="suspension">Suspensions & Reinstatements</option>
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
            const isRoleChange = item.type === "role_change" || item.action === "ROLE_CHANGE";
            const isSuspension = item.type === "suspension_change" || item.action?.includes("SUSPEND");
            const dateStr = item.timestamp?.toDate
              ? formatInstant(item.timestamp)
              : item.createdAt?.toDate
              ? formatInstant(item.createdAt)
              : "Recent";
            const eventLabel = isRoleChange
              ? "ROLE TRANSITION"
              : isSuspension
                ? item.newState
                  ? "ACCOUNT SUSPENDED"
                  : "ACCOUNT REINSTATED"
                : item.action || "SYSTEM EVENT";
            const summary = isRoleChange
              ? `${item.actorName || item.actor} → ${item.targetName || item.targetAddress}`
              : isSuspension
                ? `${item.actorName || item.actor} ${item.newState ? "suspended" : "reinstated"} ${item.targetName || item.targetAddress}`
                : (item.title || item.action || "Audit Record");

            return (
              <tr className="audit-nav-row" key={item.id}>
                <td>
                  <span
                    className={`audit-type-badge ${
                      isRoleChange
                        ? "badge-role-change"
                        : isSuspension
                          ? "badge-suspension"
                          : "badge-system"
                    }`}
                  >
                    {eventLabel}
                  </span>
                </td>
                <td>
                  {summary}
                  {item.reason && <div className="table-row-meta">{item.reason}</div>}
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
              {loadingMore ? "Loading more…" : "Load more"}
            </button>
          </div>
        )}
        </>
      )}
    </div>
  );
}
