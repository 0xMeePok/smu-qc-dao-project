import { useAuth } from "../context/AuthContext.jsx";
import { ROLE_LABELS } from "../config/roles.js";

function RoleBadge({ role }) {
  return <span className="role-chip">{ROLE_LABELS[role] || role}</span>;
}

export function MyProblems({ onNavigate }) {
  const { user } = useAuth();
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

      <div className="dashboard-stats-grid">
        <div className="stat-card">
          <span className="stat-num">2</span>
          <span className="stat-label">Active Challenges</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">5</span>
          <span className="stat-label">Proposals Received</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">$200,000</span>
          <span className="stat-label">Committed Capital</span>
        </div>
      </div>

      <div className="card-table">
        <div className="table-header">
          <h3>Published Problem Statements</h3>
          <button className="primary small" type="button" onClick={() => onNavigate("create")}>+ New Brief</button>
        </div>
        <div className="table-row">
          <div>
            <strong>Reduce calibration drift in topological qubit arrays</strong>
            <small>Status: Accepting proposals · 3 submissions received</small>
          </div>
          <span className="status-dot">Active</span>
        </div>
        <div className="table-row">
          <div>
            <strong>Error mitigation protocols for noisy intermediate-scale hardware</strong>
            <small>Status: Under evaluation · 2 submissions received</small>
          </div>
          <span className="status-dot">In Review</span>
        </div>
      </div>
    </section>
  );
}

export function ResearcherProposals({ onNavigate }) {
  const { user } = useAuth();
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

      <div className="dashboard-stats-grid">
        <div className="stat-card">
          <span className="stat-num">3</span>
          <span className="stat-label">Submitted Proposals</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">1</span>
          <span className="stat-label">Awarded & Active</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">$80,000</span>
          <span className="stat-label">Funded Grants</span>
        </div>
      </div>

      <div className="card-table">
        <div className="table-header">
          <h3>Active Proposal Records</h3>
          <button className="secondary small" type="button" onClick={() => onNavigate("discover")}>Browse Open Calls</button>
        </div>
        <div className="table-row">
          <div>
            <strong>Formal verification for hybrid quantum compilers</strong>
            <small>Target: Northstar Applied Research · Submitted: Aug 2026</small>
          </div>
          <span className="status-dot">Under Review</span>
        </div>
        <div className="table-row">
          <div>
            <strong>Machine-checkable proof suite covering agreed compiler core</strong>
            <small>Milestone 1 Deliverable · Due in 14 days</small>
          </div>
          <span className="status-dot">In Progress</span>
        </div>
      </div>
    </section>
  );
}

export function EvaluatorQueue() {
  const { user } = useAuth();
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

      <div className="dashboard-stats-grid">
        <div className="stat-card">
          <span className="stat-num">4</span>
          <span className="stat-label">Pending Reviews</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">12</span>
          <span className="stat-label">Completed Reviews</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">98.4%</span>
          <span className="stat-label">Consensus Score</span>
        </div>
      </div>

      <div className="card-table">
        <div className="table-header">
          <h3>Assigned Blind Submissions</h3>
        </div>
        <div className="table-row">
          <div>
            <strong>Submission #PROP-2026-081 · "Topological Drift Compensation"</strong>
            <small>Double-blind assessment · Rubric: Feasibility, Novelty, Methodology</small>
          </div>
          <button className="primary small" type="button">Score Proposal</button>
        </div>
        <div className="table-row">
          <div>
            <strong>Submission #PROP-2026-094 · "Photonic Error Mapping Toolkit"</strong>
            <small>Double-blind assessment · Rubric: Feasibility, Novelty, Methodology</small>
          </div>
          <button className="primary small" type="button">Score Proposal</button>
        </div>
      </div>
    </section>
  );
}

export function FundingPortfolio({ onNavigate }) {
  const { user } = useAuth();
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

      <div className="dashboard-stats-grid">
        <div className="stat-card">
          <span className="stat-num">$450,000</span>
          <span className="stat-label">Total Allocated</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">$180,000</span>
          <span className="stat-label">Locked in Escrow</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">4</span>
          <span className="stat-label">Active Research Grants</span>
        </div>
      </div>

      <div className="card-table">
        <div className="table-header">
          <h3>Disbursement Schedule</h3>
          <button className="primary small" type="button" onClick={() => onNavigate("create")}>+ New Funding Call</button>
        </div>
        <div className="table-row">
          <div>
            <strong>Open benchmark suite for photonic error models (Dr. Mira Chen)</strong>
            <small>Tranche 1 ($22,500) Released · Tranche 2 Pending Milestone 2</small>
          </div>
          <span className="status-dot">Escrow Active</span>
        </div>
      </div>
    </section>
  );
}

export function AdminAudit() {
  const { user } = useAuth();
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

      <div className="dashboard-stats-grid">
        <div className="stat-card">
          <span className="stat-num">1,420</span>
          <span className="stat-label">On-chain Audit Events</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">100%</span>
          <span className="stat-label">O1-KR4 RBAC Enforcement</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">Arbitrum Sepolia</span>
          <span className="stat-label">Chain ID 421614</span>
        </div>
      </div>

      <div className="card-table">
        <div className="table-header">
          <h3>Recent System Audit Events</h3>
        </div>
        <div className="table-row">
          <div>
            <strong>PROPOSAL_HASH_ANCHORED · Tx: 0x8a92...b411</strong>
            <small>Block #18239102 · Verified SHA-256 Merkle root committed</small>
          </div>
          <span className="status-dot">Verified</span>
        </div>
        <div className="table-row">
          <div>
            <strong>EVALUATOR_RUBRIC_COMMITTED · Tx: 0x4f12...99ca</strong>
            <small>Block #18239088 · Blind score consensus calculated (3/3 signatures)</small>
          </div>
          <span className="status-dot">Verified</span>
        </div>
      </div>
    </section>
  );
}
