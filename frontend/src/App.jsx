import { useEffect, useMemo, useRef, useState } from "react";
import { opportunities, opportunityTypes } from "./data.js";
import { ROLES } from "./config/roles.js";
import { FEATURES } from "./config/features.js";
import { getPermittedNavRoutes, getRouteConfig } from "./config/routes.js";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { RouteGuard } from "./components/RouteGuard.jsx";
import { Login } from "./components/Login.jsx";
import { AccessDenied } from "./components/AccessDenied.jsx";
import {
  MyProblems,
  ResearcherProposals,
  EvaluatorQueue,
  FundingPortfolio,
  AdminAudit,
} from "./components/RoleViews.jsx";

function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, "") || "home";
  const [pathAndParams, queryString] = hash.split("?");
  const params = new URLSearchParams(queryString || "");
  const parts = pathAndParams.split("/");
  const section = parts[0] || "home";
  const id = parts[1] || null;

  return { section, id, fullPath: pathAndParams, params };
}

function useRoute() {
  const [routeInfo, setRouteInfo] = useState(parseHash);

  useEffect(() => {
    const updateRoute = () => {
      setRouteInfo(parseHash());
      window.scrollTo({ top: 0, behavior: "auto" });
    };

    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

  return routeInfo;
}

function go(route) {
  window.location.hash = route.startsWith("/") ? route : `/${route}`;
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" />
    </svg>
  );
}

function Logo() {
  return (
    <button className="brand" type="button" onClick={() => go("home")} aria-label="QC DAO home">
      <span aria-hidden="true">Q</span>
      QC DAO
    </button>
  );
}

function DemoToolbar() {
  const { roles, login, logout, user } = useAuth();
  const isAdmin = roles.includes(ROLES.ADMIN);
  const isMember = roles.includes(ROLES.OWNER) && roles.includes(ROLES.RESEARCHER);
  const isGuest = !user;

  return (
    <aside className="demo-toolbar" aria-label="Demo role switcher">
      <div className="demo-toolbar-inner">
        <div className="demo-title">
          <span className="live-dot" />
          <strong>O1-KR4 Multi-Role Access Tester</strong>
          <small>
            Active:{" "}
            <span className="active-role-highlight">
              {isGuest ? "Guest (Unauthenticated)" : isAdmin ? "DAO Admin" : "Platform Member (All Roles)"}
            </span>
          </small>
        </div>
        <div className="demo-roles-group">
          <button
            type="button"
            className={`demo-role-btn ${isGuest ? "selected" : ""}`}
            onClick={() => logout()}
          >
            Guest (Sign Out)
          </button>
          <button
            type="button"
            className={`demo-role-btn ${isMember ? "selected" : ""}`}
            onClick={() => login("member")}
          >
            Platform Member (Multi-Role)
          </button>
          <button
            type="button"
            className={`demo-role-btn ${isAdmin ? "selected" : ""}`}
            onClick={() => login("admin")}
          >
            DAO Admin
          </button>
        </div>
      </div>
    </aside>
  );
}

function WorkspacesDropdown({ route, workspaceRoutes }) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);
  const isCurrentWorkspace = workspaceRoutes.some((w) => w.key === route);
  const activeWorkspace = workspaceRoutes.find((w) => w.key === route);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const workspaceDescriptions = {
    "my-problems": "Manage owned challenges & proposals",
    "proposals": "Track grant proposals & deliverables",
    "evaluations": "Conduct blind evaluations & scoring",
    "funding": "Oversee capital & escrow releases",
  };

  return (
    <div className="nav-dropdown-wrapper" ref={dropdownRef}>
      <button
        type="button"
        className={`nav-dropdown-trigger ${isCurrentWorkspace ? "active" : ""}`}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <span>{activeWorkspace ? `Workspaces: ${activeWorkspace.label}` : "Workspaces"}</span>
        <svg
          className={`dropdown-chevron ${isOpen ? "open" : ""}`}
          viewBox="0 0 20 20"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 10 13 14 9" />
        </svg>
      </button>

      {isOpen && (
        <div className="nav-dropdown-menu" role="menu">
          <div className="nav-dropdown-header">
            <span className="eyebrow">Member Workspaces</span>
          </div>
          {workspaceRoutes.map(({ key, label }) => {
            const isActive = route === key;
            return (
              <button
                key={key}
                type="button"
                className={`nav-dropdown-item ${isActive ? "selected" : ""}`}
                role="menuitem"
                onClick={() => {
                  setIsOpen(false);
                  go(key);
                }}
              >
                <div className="dropdown-item-content">
                  <div className="dropdown-item-title">
                    <strong>{label}</strong>
                    {isActive && <span className="current-dot" />}
                  </div>
                  <small>{workspaceDescriptions[key] || ""}</small>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Shell({ route, children }) {
  const { user, roles, logout, hasRole } = useAuth();
  const navRoutes = getPermittedNavRoutes(roles);
  const isAdmin = hasRole(ROLES.ADMIN);

  // Group primary navigation vs stakeholder workspaces
  const workspaceKeys = new Set(["my-problems", "proposals", "evaluations", "funding"]);
  const primaryRoutes = navRoutes.filter((r) => !workspaceKeys.has(r.key));
  const workspaceRoutes = navRoutes.filter((r) => workspaceKeys.has(r.key));

  return (
    <>
      <header className="topbar">
        <div className="topbar-left">
          <Logo />
          <nav aria-label="Primary navigation">
            {primaryRoutes.map(({ key, label }) => (
              <button
                key={key}
                className={route === key ? "active" : ""}
                type="button"
                onClick={() => go(key)}
              >
                {label}
              </button>
            ))}

            {workspaceRoutes.length > 0 && (
              <WorkspacesDropdown route={route} workspaceRoutes={workspaceRoutes} />
            )}
          </nav>
        </div>

        <div className="topbar-right">
          {user ? (
            <div className="user-session-pill">
              <div className="user-session-info">
                <span className="user-name">{user.name}</span>
                <div className="role-tags-row">
                  {isAdmin ? (
                    <span className="user-role-badge admin-badge">DAO Admin</span>
                  ) : (
                    <span className="user-role-badge member-badge" title="Owner · Researcher · Evaluator · Funder">
                      Platform Member
                    </span>
                  )}
                </div>
              </div>
              <button className="signout-btn" type="button" onClick={logout} title="Sign Out">
                Sign Out
              </button>
            </div>
          ) : (
            <button className="primary small signin-nav-btn" type="button" onClick={() => go("login")}>
              Sign In
            </button>
          )}
        </div>
      </header>

      <main className="content">{children}</main>

      {FEATURES.DEMO_ROLE_SWITCHER && <DemoToolbar />}

      <footer className="footer">
        <div>
          <strong>QC DAO</strong> — Multi-role quantum funding platform with verifiable on-chain audit trails.
        </div>
        <div className="footer-links">
          <span>Arbitrum Sepolia (421614)</span>
          <span>·</span>
          <span>Proof of Concept</span>
        </div>
      </footer>
    </>
  );
}

function OpportunityIcon({ type }) {
  if (type === "Business problem") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7.5 3.5h7L19 8v12.5H7.5z" />
        <path d="M14.5 3.5V8H19M10.5 12h5M10.5 15.5h5" />
      </svg>
    );
  }

  if (type === "Open funding") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 8.5h16v11H4zM7 8.5V5h10v3.5M8 12h8M8 16h5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 12h7M12 8.5v7" />
    </svg>
  );
}

function StakeholderIcon({ type }) {
  if (type === "owner") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3.75h6.25L17 7.5v12.75H7z" />
        <path d="M13.25 3.75V7.5H17M9.5 11h5M9.5 14h5M9.5 17h3.5" />
      </svg>
    );
  }

  if (type === "evaluator") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 4.25l6 3.25v5c0 4.25-2.75 7.5-6 8.5-3.25-1-6-4.25-6-8.5v-5z" />
        <path d="M9.5 12.25l1.75 1.75 3.25-3.5" />
      </svg>
    );
  }

  if (type === "researcher") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M10 4.5h4M12 4.5v6M8.5 19.5h7l-1.5-6h-4z" />
        <circle cx="12" cy="10.5" r="1.5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v9M14.5 10a2.5 2.5 0 0 0-5 0c0 3 5 2 5 5a2.5 2.5 0 0 1-5 0" />
    </svg>
  );
}

function OpportunityCard({ item }) {
  return (
    <button className="opportunity-card" type="button" onClick={() => go(`opportunity/${item.id}`)}>
      <span className="opportunity-mark">
        <OpportunityIcon type={item.type} />
      </span>
      <div className="opportunity-summary">
        <strong>{item.title}</strong>
        <small>{item.owner} · {item.type}</small>
      </div>
      <div>
        <span className="status-dot">{item.status}</span>
      </div>
      <div className="opportunity-amount">{item.amount}</div>
      <div className="opportunity-deadline">{item.deadline}</div>
      <span className="row-arrow">
        <ArrowIcon />
      </span>
    </button>
  );
}

function OpportunityList({ items }) {
  return (
    <div className="opportunity-list">
      <div className="opportunity-list-head">
        <span>Problem or funding call</span>
        <span>Status</span>
        <span>Indicative budget</span>
        <span>Timeline</span>
        <span />
      </div>
      {items.map((item) => <OpportunityCard item={item} key={item.id} />)}
    </div>
  );
}

function ResearchNetwork() {
  return (
    <div className="research-network" aria-label="Stakeholder network">
      <svg className="network-lines" viewBox="0 0 460 320" aria-hidden="true">
        <path d="M100 80 L230 160" />
        <path d="M360 70 L230 160" />
        <path d="M90 240 L230 160" />
        <path d="M370 250 L230 160" />
        <path d="M100 80 L90 240" />
        <path d="M360 70 L370 250" />
        <circle cx="100" cy="80" r="4" />
        <circle cx="360" cy="70" r="4" />
        <circle cx="90" cy="240" r="4" />
        <circle cx="370" cy="250" r="4" />
      </svg>
      <div className="network-core">QC</div>
      <div className="network-node owner">
        <div className="network-icon"><StakeholderIcon type="owner" /></div>
        <strong>Problem owner</strong>
        <span>Defines problem</span>
      </div>
      <div className="network-node evaluator">
        <div className="network-icon"><StakeholderIcon type="evaluator" /></div>
        <strong>Evaluator</strong>
        <span>Scores proposals</span>
      </div>
      <div className="network-node researcher">
        <div className="network-icon"><StakeholderIcon type="researcher" /></div>
        <strong>Researcher</strong>
        <span>Delivers work</span>
      </div>
      <div className="network-node funder">
        <div className="network-icon"><StakeholderIcon type="funder" /></div>
        <strong>Funder</strong>
        <span>Backs outcomes</span>
      </div>
    </div>
  );
}

function Home() {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>Fund research<br /><span>with clear outcomes.</span></h1>
          <p>Publish important problems, compare thoughtful proposals and support work through clear delivery stages.</p>
          <div className="actions">
            <button className="primary" type="button" onClick={() => go("discover")}>Explore opportunities</button>
            <button className="secondary" type="button" onClick={() => go("create")}>Publish a brief</button>
          </div>
        </div>
        <ResearchNetwork />
      </section>

      <section className="marketplace-section">
        <div className="section-heading">
          <div>
            <h2>Open opportunities</h2>
            <p>Competitive problems and one-to-one research relationships.</p>
          </div>
          <button className="text-button" type="button" onClick={() => go("discover")}>Browse all <ArrowIcon /></button>
        </div>
        <OpportunityList items={opportunities} />
      </section>

      <section className="how">
        <div className="steps">
          <article><b aria-hidden="true">01</b><div><h3>Accountable by design</h3><p>Define outcomes and deliverables before work begins.</p></div></article>
          <article><b aria-hidden="true">02</b><div><h3>Evidence over hype</h3><p>Compare opportunities on methods, feasibility and impact.</p></div></article>
          <article><b aria-hidden="true">03</b><div><h3>Fund with confidence</h3><p>Keep a transparent record from publication onward.</p></div></article>
        </div>
      </section>
    </>
  );
}

function Discover() {
  const [filter, setFilter] = useState("All");
  const filters = ["All", ...opportunityTypes.map(({ label }) => label)];
  const visibleOpportunities = filter === "All"
    ? opportunities
    : opportunities.filter((item) => item.type === filter);

  return (
    <section className="page">
      <div className="page-heading">
        <h1>Explore research opportunities</h1>
        <p>Review open challenges, funding offers and researcher-led requests.</p>
      </div>
      <div className="filters" aria-label="Filter opportunities">
        {filters.map((item) => (
          <button
            className={filter === item ? "selected" : ""}
            key={item}
            type="button"
            onClick={() => setFilter(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <OpportunityList items={visibleOpportunities} />
    </section>
  );
}

function OpportunityDetail({ id }) {
  const item = opportunities.find((candidate) => candidate.id === id);
  const { hasRole, isAuthenticated } = useAuth();
  if (!item) return <NotFound />;

  const canSubmitProposal = !isAuthenticated || hasRole(ROLES.RESEARCHER);
  const canCreateBrief = !isAuthenticated || hasRole(ROLES.OWNER) || hasRole(ROLES.FUNDER);

  return (
    <section className="page detail-page">
      <button className="back" type="button" onClick={() => go("discover")}>Back to opportunities</button>
      <div className="detail-layout">
        <article className="detail-main">
          <div className="card-top">
            <span className="eyebrow">{item.type}</span>
            <span className="status-dot">{item.status}</span>
          </div>
          <h1>{item.title}</h1>
          <p className="lead">{item.summary}</p>
          <div className="detail-section"><h2>Why this work matters</h2><p>{item.benefits}</p></div>
          <div className="detail-section"><h2>Expected outcomes</h2><p>{item.outcomes}</p></div>
          <div className="detail-section"><h2>Deliverables</h2><p>{item.deliverables}</p></div>
        </article>
        <aside className="context-panel">
          <span className="eyebrow">Funding overview</span>
          <strong>{item.amount}</strong>
          <dl>
            <div><dt>Published by</dt><dd>{item.owner}</dd></div>
            <div><dt>Timing</dt><dd>{item.deadline}</dd></div>
            <div><dt>Current stage</dt><dd>{item.status}</dd></div>
          </dl>
          <div className="context-panel-actions">
            {canSubmitProposal && (
              <button className="primary" type="button" onClick={() => go("proposals")}>
                Submit Proposal for Brief
              </button>
            )}
            {canCreateBrief && (
              <button className="secondary" type="button" onClick={() => go("create")}>
                Create a similar brief
              </button>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function getAvailableOpportunityTypes(roles) {
  const roleList = Array.isArray(roles) ? roles : roles ? [roles] : [];
  if (roleList.includes(ROLES.ADMIN)) {
    return opportunityTypes;
  }

  const allowedTypes = new Set();
  if (roleList.includes(ROLES.RESEARCHER)) {
    allowedTypes.add("funding-request");
  }
  if (roleList.includes(ROLES.OWNER)) {
    allowedTypes.add("business-problem");
    allowedTypes.add("open-funding");
  }
  if (roleList.includes(ROLES.FUNDER)) {
    allowedTypes.add("open-funding");
    allowedTypes.add("business-problem");
  }

  // If user has no specific role (e.g. guest fallback), return standard options
  if (allowedTypes.size === 0) {
    return opportunityTypes;
  }

  return opportunityTypes.filter((t) => allowedTypes.has(t.value));
}

function CreateOpportunity() {
  const { roles, hasRole } = useAuth();
  const availableTypes = useMemo(() => getAvailableOpportunityTypes(roles), [roles]);

  const [form, setForm] = useState(() => ({
    opportunityType: availableTypes[0]?.value || "business-problem",
    title: "",
    summary: "",
    outcomes: "",
    amount: "",
  }));

  useEffect(() => {
    if (!availableTypes.some((t) => t.value === form.opportunityType)) {
      setForm((prev) => ({
        ...prev,
        opportunityType: availableTypes[0]?.value || "business-problem",
      }));
    }
  }, [availableTypes, form.opportunityType]);

  const [submitted, setSubmitted] = useState(false);
  const selectedType = useMemo(
    () => opportunityTypes.find((type) => type.value === form.opportunityType),
    [form.opportunityType],
  );

  const update = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setSubmitted(false);
  };

  const submit = (event) => {
    event.preventDefault();
    if (form.opportunityType === "funding-request" && !hasRole(ROLES.RESEARCHER) && !hasRole(ROLES.ADMIN)) {
      alert("Only researchers are permitted to submit funding requests.");
      return;
    }
    setSubmitted(true);
  };

  return (
    <section className="page create-page">
      <div className="page-heading">
        <h1>Create a research brief</h1>
        <p>Publish a clear challenge, open funding offer, or researcher-led funding request.</p>
      </div>

      <div className="form-layout">
        <form className="brief-form" onSubmit={submit}>
          <fieldset className="field-group">
            <legend>1. Opportunity type</legend>
            <p className="field-hint">Choose your publishing capacity for this brief.</p>
            <div className="radio-group" role="radiogroup">
              {availableTypes.map((type) => (
                <label
                  key={type.value}
                  className={`radio-card ${form.opportunityType === type.value ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="opportunityType"
                    value={type.value}
                    checked={form.opportunityType === type.value}
                    onChange={update}
                  />
                  <div>
                    <strong>{type.label}</strong>
                    <span>{type.note}</span>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="field-group">
            <legend>2. Core details</legend>
            <div className="field">
              <label htmlFor="title">Opportunity title</label>
              <input
                id="title"
                name="title"
                type="text"
                required
                placeholder="e.g. Robust error decoding for neutral atom systems"
                value={form.title}
                onChange={update}
              />
            </div>
            <div className="field">
              <label htmlFor="summary">Problem summary & scope</label>
              <textarea
                id="summary"
                name="summary"
                rows={4}
                required
                placeholder="Describe the context, technical bottleneck and what a solution should achieve."
                value={form.summary}
                onChange={update}
              />
            </div>
          </fieldset>

          <fieldset className="field-group">
            <legend>3. Deliverables & funding</legend>
            <div className="field">
              <label htmlFor="outcomes">Key deliverables & milestones</label>
              <textarea
                id="outcomes"
                name="outcomes"
                rows={3}
                required
                placeholder="List verification milestones required before funds are unlocked."
                value={form.outcomes}
                onChange={update}
              />
            </div>
            <div className="field">
              <label htmlFor="amount">Target funding / budget allocation</label>
              <input
                id="amount"
                name="amount"
                type="text"
                required
                placeholder="e.g. $80,000"
                value={form.amount}
                onChange={update}
              />
            </div>
          </fieldset>

          <div className="form-actions">
            <button className="primary" type="submit">Publish brief to registry</button>
            <button className="secondary" type="button" onClick={() => go("discover")}>Cancel</button>
          </div>

          {submitted && (
            <div className="success-banner" role="status">
              <strong>Brief published successfully!</strong>
              <p>Your brief "{form.title}" is now available in the platform registry.</p>
              <button className="text-button" type="button" onClick={() => go("discover")}>
                View in Discover <ArrowIcon />
              </button>
            </div>
          )}
        </form>

        <aside className="preview-panel" aria-label="Live preview">
          <div className="preview-sticky">
            <span className="eyebrow">Registry Live Preview</span>
            <div className="preview-card">
              <div className="card-top">
                <span className="eyebrow">{selectedType?.label || "Opportunity"}</span>
                <span className="status-dot">Draft Preview</span>
              </div>
              <h3>{form.title || "Untitled Research Brief"}</h3>
              <p>{form.summary || "Summary and problem description will appear here as you type."}</p>
              <div className="preview-meta">
                <div>
                  <small>Funding</small>
                  <strong>{form.amount || "$0"}</strong>
                </div>
                <div>
                  <small>Deliverables</small>
                  <span>{form.outcomes ? "Milestones defined" : "Pending entry"}</span>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

function NotFound() {
  return (
    <section className="page empty">
      <div className="empty-icon-wrapper" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M16 16s-1.5-2-4-2-4 2-4 2" />
          <line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3" />
          <line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3" />
        </svg>
      </div>
      <span className="http-status">HTTP 404 · Not Found</span>
      <h1>This page or research opportunity does not exist.</h1>
      <p>The requested URL route was not found in the QC DAO platform registry.</p>
      <button className="primary" type="button" onClick={() => go("discover")}>Browse opportunities</button>
    </section>
  );
}

function AppContent() {
  const { section, id, params } = useRoute();
  const routeConfig = getRouteConfig(section);

  let pageComponent = <NotFound />;

  if (section === "home") {
    pageComponent = <Home />;
  } else if (section === "discover") {
    pageComponent = <Discover />;
  } else if (section === "opportunity") {
    pageComponent = <OpportunityDetail id={id} />;
  } else if (section === "login") {
    pageComponent = <Login redirectTarget={params.get("redirect")} onNavigate={go} />;
  } else if (section === "create") {
    pageComponent = (
      <RouteGuard
        targetRoute={section}
        allowedRoles={routeConfig?.allowedRoles}
        authRequired={routeConfig?.authRequired}
        onNavigate={go}
      >
        <CreateOpportunity />
      </RouteGuard>
    );
  } else if (section === "my-problems") {
    pageComponent = (
      <RouteGuard
        targetRoute={section}
        allowedRoles={routeConfig?.allowedRoles}
        authRequired={routeConfig?.authRequired}
        onNavigate={go}
      >
        <MyProblems onNavigate={go} />
      </RouteGuard>
    );
  } else if (section === "proposals") {
    pageComponent = (
      <RouteGuard
        targetRoute={section}
        allowedRoles={routeConfig?.allowedRoles}
        authRequired={routeConfig?.authRequired}
        onNavigate={go}
      >
        <ResearcherProposals onNavigate={go} />
      </RouteGuard>
    );
  } else if (section === "evaluations") {
    pageComponent = (
      <RouteGuard
        targetRoute={section}
        allowedRoles={routeConfig?.allowedRoles}
        authRequired={routeConfig?.authRequired}
        onNavigate={go}
      >
        <EvaluatorQueue onNavigate={go} />
      </RouteGuard>
    );
  } else if (section === "funding") {
    pageComponent = (
      <RouteGuard
        targetRoute={section}
        allowedRoles={routeConfig?.allowedRoles}
        authRequired={routeConfig?.authRequired}
        onNavigate={go}
      >
        <FundingPortfolio onNavigate={go} />
      </RouteGuard>
    );
  } else if (section === "admin") {
    pageComponent = (
      <RouteGuard
        targetRoute={section}
        allowedRoles={routeConfig?.allowedRoles}
        authRequired={routeConfig?.authRequired}
        onNavigate={go}
      >
        <AdminAudit onNavigate={go} />
      </RouteGuard>
    );
  } else if (section === "access-denied") {
    pageComponent = <AccessDenied onNavigate={go} />;
  }

  return <Shell route={section}>{pageComponent}</Shell>;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
