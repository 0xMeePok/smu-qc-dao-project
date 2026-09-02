import { useCallback, useEffect, useState } from "react";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../lib/firebase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Modal } from "./Modal.jsx";
import { POSTING_STATUS_DRAFT, deletePosting, listOwnPostings } from "../lib/postings.js";
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
      <div className="table-row" key={item.id}>
        <div>
          <strong>{item.title || "Untitled draft"}</strong>
          <small className="table-row-meta">
            {isDraft ? "Last saved " : "Submitted "}
            {formatInstant(item.updatedAt)}
          </small>
        </div>
        <div className="table-row-actions">
          {isDraft && <span className="draft-badge">Draft</span>}
          <button
            className="text-button"
            type="button"
            onClick={() => onNavigate(isDraft ? `create/${item.id}` : `posting/${item.id}`)}
          >
            {isDraft ? "Resume editing" : "View"}
          </button>
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
        const q = query(collection(db, "proposals"), where("researcherId", "==", user.id));
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
          <RoleBadge role="researcher" />
          <span>Affiliation: {user?.org}</span>
        </div>
        <h1>My Research Proposals</h1>
        <p>Track your submitted grant proposals, reviewer scoring outcomes, milestone deliverables, and verification escrow.</p>
      </div>

      <div className="card-table">
        <div className="table-header">
          <h3>Active Proposal Records</h3>
          <button className="secondary small" type="button" onClick={() => onNavigate("discover")}>Browse Open Calls</button>
        </div>
        
        {loading ? (
          <div style={{ padding: "2rem", textAlign: "center" }}>Loading...</div>
        ) : error ? (
          <div className="error-banner" style={{ padding: "2rem", color: "red" }}>
             <strong>Error:</strong> {error.message}
          </div>
        ) : data.length === 0 ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "#666" }}>No proposals found.</div>
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
        <h1>Evaluation & Peer Review Queue</h1>
        <p>Conduct double-blind technical assessments, assign criterion scores, and sign review hashes for on-chain anchoring.</p>
      </div>

      <div className="card-table">
        <div className="table-header">
          <h3>Assigned Blind Submissions</h3>
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
  const [filterType, setFilterType] = useState("all");

  const fetchAudits = async () => {
    if (!user?.id || !db) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const querySnapshot = await getDocs(collection(db, "audits"));
      const items = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      // Sort by timestamp descending if available
      items.sort((a, b) => {
        const tA = a.timestamp?.toMillis ? a.timestamp.toMillis() : a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const tB = b.timestamp?.toMillis ? b.timestamp.toMillis() : b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return tB - tA;
      });
      setData(items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAudits();
  }, [user?.id]);

  const filteredData = data.filter((item) => {
    if (filterType === "all") return true;
    if (filterType === "role_change") return item.type === "role_change" || item.action === "ROLE_CHANGE";
    if (filterType === "suspension") return item.type === "suspension_change" || item.action?.includes("SUSPEND");
    return true;
  });

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
            <option value="all">All Events ({data.length})</option>
            <option value="role_change">Role Changes</option>
            <option value="suspension">Suspensions & Reinstatements</option>
          </select>
          <button className="secondary small" type="button" onClick={fetchAudits} title="Refresh Audit Log">
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
      ) : filteredData.length === 0 ? (
        <div style={{ padding: "2.5rem", textAlign: "center", color: "#888" }}>
          No audit events found for the selected filter.
        </div>
      ) : (
        <div className="audit-list">
          {filteredData.map((item) => {
            const isRoleChange = item.type === "role_change" || item.action === "ROLE_CHANGE";
            const isSuspension = item.type === "suspension_change" || item.action?.includes("SUSPEND");
            const dateStr = item.timestamp?.toDate
              ? item.timestamp.toDate().toLocaleString()
              : item.createdAt?.toDate
              ? item.createdAt.toDate().toLocaleString()
              : "Recent";

            return (
              <div className="audit-item-card" key={item.id}>
                <div className="audit-card-top">
                  <div className="audit-tag-row">
                    <span
                      className={`audit-type-badge ${
                        isRoleChange
                          ? "badge-role-change"
                          : isSuspension
                          ? "badge-suspension"
                          : "badge-system"
                      }`}
                    >
                      {isRoleChange
                        ? "ROLE TRANSITION"
                        : isSuspension
                        ? item.newState
                          ? "ACCOUNT SUSPENDED"
                          : "ACCOUNT REINSTATED"
                        : item.action || "SYSTEM EVENT"}
                    </span>
                    <span className="audit-timestamp">{dateStr}</span>
                  </div>
                </div>

                <div className="audit-card-body">
                  {isRoleChange && (
                    <div className="audit-details">
                      <p className="audit-statement">
                        Admin <strong>{item.actorName || item.actor}</strong> modified role assignment for{" "}
                        <strong>{item.targetName || item.targetAddress}</strong>:
                      </p>
                      <div className="audit-transition-pill">
                        <span>{item.previousRole === 1 ? "Administrator (1)" : "User (0)"}</span>
                        <span className="arrow">→</span>
                        <strong>{item.newRole === 1 ? "Administrator (1)" : "User (0)"}</strong>
                      </div>
                    </div>
                  )}

                  {isSuspension && (
                    <div className="audit-details">
                      <p className="audit-statement">
                        Admin <strong>{item.actorName || item.actor}</strong> {item.newState ? "suspended" : "reinstated"}{" "}
                        account <strong>{item.targetName || item.targetAddress}</strong>.
                      </p>
                    </div>
                  )}

                  {!isRoleChange && !isSuspension && (
                    <div className="audit-details">
                      <strong>{item.title || item.action || "Audit Record"}</strong>
                    </div>
                  )}

                  {item.reason && (
                    <div className="audit-reason-box">
                      <span className="reason-label">Written Reason:</span>
                      <span className="reason-text">"{item.reason}"</span>
                    </div>
                  )}

                  <div className="audit-meta-row">
                    <small>Actor: <code>{item.actor}</code></small>
                    {item.targetAddress && (
                      <small>Target: <code>{item.targetAddress}</code></small>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
