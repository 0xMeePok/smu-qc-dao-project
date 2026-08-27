import { useState, useEffect } from "react";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../lib/firebase.js";
import { useAuth } from "../context/AuthContext.jsx";
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

  useEffect(() => {
    async function fetchData() {
      if (!user?.id || !db) {
        setLoading(false);
        return;
      }
      try {
        const q = query(collection(db, "problems"), where("ownerId", "==", user.id));
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
          <RoleBadge role="owner" />
          <span>Organization: {user?.org}</span>
        </div>
        <h1>My Problem Statements</h1>
        <p>Manage your published research challenges, track submission deadlines, and evaluate inbound researcher proposals.</p>
      </div>

      <div className="card-table">
        <div className="table-header">
          <h3>Published Problem Statements</h3>
          <button className="primary small" type="button" onClick={() => onNavigate("create")}>+ New Brief</button>
        </div>
        
        {loading ? (
          <div style={{ padding: "2rem", textAlign: "center" }}>Loading...</div>
        ) : error ? (
          <div className="error-banner" style={{ padding: "2rem", color: "red" }}>
             <strong>Error:</strong> {error.message}
          </div>
        ) : data.length === 0 ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "#666" }}>No problems found.</div>
        ) : (
          data.map(item => (
            <div className="table-row" key={item.id}>
              <div>
                <strong>{item.title}</strong>
                <small className="table-row-meta">
                  Submitted by <ProfileLink address={item.researcherId} label="view profile" onNavigate={onNavigate} />
                </small>
              </div>
            </div>
          ))
        )}
      </div>
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

  useEffect(() => {
    async function fetchData() {
      if (!user?.id || !db) {
        setLoading(false);
        return;
      }
      try {
        const querySnapshot = await getDocs(collection(db, "audits"));
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
          <RoleBadge role="admin" />
          <span>System Governance</span>
        </div>
        <h1>DAO Platform Administration & Audit Trail</h1>
        <p>Monitor platform state transitions, inspect Arbitrum Sepolia audit event hashes, and enforce RBAC integrity.</p>
      </div>

      <div className="card-table">
        <div className="table-header">
          <h3>Recent System Audit Events</h3>
        </div>
        
        {loading ? (
          <div style={{ padding: "2rem", textAlign: "center" }}>Loading...</div>
        ) : error ? (
          <div className="error-banner" style={{ padding: "2rem", color: "red" }}>
             <strong>Error:</strong> {error.message}
          </div>
        ) : data.length === 0 ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "#666" }}>No audit events found.</div>
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
