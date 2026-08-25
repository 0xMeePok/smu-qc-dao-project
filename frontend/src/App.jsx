import { useEffect, useMemo, useState } from "react";
import { opportunities, opportunityTypes } from "./data.js";
import { ROLES, ROLE_LABELS, DEMO_USERS } from "./config/roles.js";
import { FEATURES } from "./config/features.js";
import { ROUTES_CONFIG, getPermittedNavRoutes, getRouteConfig } from "./config/routes.js";
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
      window.scrollTo({ top: 0, behavior: "instant" });
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
  const { role, switchRole, user } = useAuth();

  return (
    <aside className="demo-toolbar" aria-label="Demo role switcher">
      <div className="demo-toolbar-inner">
        <div className="demo-title">
          <span className="live-dot" />
          <strong>O1-KR4 Role Access Tester</strong>
          <small>Active: <span className="active-role-highlight">{ROLE_LABELS[role] || "Guest"}</span></small>
        </div>
        <div className="demo-roles-group">
          <button
            type="button"
            className={`demo-role-btn ${role === ROLES.GUEST ? "selected" : ""}`}
            onClick={() => switchRole(ROLES.GUEST)}
          >
            Guest
          </button>
          <button
            type="button"
            className={`demo-role-btn ${role === ROLES.OWNER ? "selected" : ""}`}
            onClick={() => switchRole(ROLES.OWNER)}
          >
            Owner
          </button>
          <button
            type="button"
            className={`demo-role-btn ${role === ROLES.RESEARCHER ? "selected" : ""}`}
            onClick={() => switchRole(ROLES.RESEARCHER)}
          >
            Researcher
          </button>
          <button
            type="button"
            className={`demo-role-btn ${role === ROLES.EVALUATOR ? "selected" : ""}`}
            onClick={() => switchRole(ROLES.EVALUATOR)}
          >
            Evaluator
          </button>
          <button
            type="button"
            className={`demo-role-btn ${role === ROLES.FUNDER ? "selected" : ""}`}
            onClick={() => switchRole(ROLES.FUNDER)}
          >
            Funder
          </button>
          <button
            type="button"
            className={`demo-role-btn ${role === ROLES.ADMIN ? "selected" : ""}`}
            onClick={() => switchRole(ROLES.ADMIN)}
          >
            Admin
          </button>
        </div>
      </div>
    </aside>
  );
}

function Shell({ route, children }) {
  const { user, role, logout } = useAuth();
  const navRoutes = getPermittedNavRoutes(role);

  return (
    <>
      <header className="topbar">
        <div className="topbar-left">
          <Logo />
          <nav aria-label="Primary navigation">
            {navRoutes.map(({ key, label }) => (
              <button
                key={key}
                className={route === key ? "active" : ""}
                type="button"
                onClick={() => go(key)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>

        <div className="topbar-right">
          {user ? (
            <div className="user-profile-badge">
              <span className="role-tag">{ROLE_LABELS[role]}</span>
              <span className="user-name">{user.name}</span>
              <button
                type="button"
                className="logout-button"
                onClick={() => {
                  logout();
                  go("home");
                }}
                title="Sign out"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <button
              className="signin-button"
              type="button"
              onClick={() => go("login")}
            >
              Sign In
            </button>
          )}
        </div>
      </header>

      <main>{children}</main>

      <footer>
        <Logo />
        <p>Clear opportunities. Accountable delivery. Transparent outcomes.</p>
        <div className="footer-links">
          <button type="button" onClick={() => go("discover")}>Discover</button>
          {role === ROLES.OWNER || role === ROLES.FUNDER || role === ROLES.ADMIN ? (
            <button type="button" onClick={() => go("create")}>Create Brief</button>
          ) : null}
          {user ? (
            <button type="button" onClick={() => logout()}>Sign Out</button>
          ) : (
            <button type="button" onClick={() => go("login")}>Sign In</button>
          )}
        </div>
      </footer>

      {/* Demo Toolbar enabled conditionally via feature flag or ?demo=true */}
      {FEATURES.DEMO_ROLE_SWITCHER ? <DemoToolbar /> : null}
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
        <circle cx="12" cy="12" r="8.25" />
        <path d="m8.25 12.1 2.45 2.45 5.25-5.35" />
      </svg>
    );
  }

  if (type === "researcher") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 3.75h6M10.25 3.75v5.4L6.1 17.2a2.1 2.1 0 0 0 1.86 3.05h8.08a2.1 2.1 0 0 0 1.86-3.05l-4.15-8.05v-5.4" />
        <path d="M8.45 15h7.1" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m4 9 8-5 8 5M5 9h14M7 10.5v6M10.33 10.5v6M13.67 10.5v6M17 10.5v6M4.5 18h15M3.5 20.25h17" />
    </svg>
  );
}

function ResearchNetwork() {
  const stakeholders = [
    ["owner", "Problem owners"],
    ["evaluator", "Evaluators"],
    ["researcher", "Researchers"],
    ["funder", "Funders"],
  ];

  return (
    <div className="research-network" aria-label="Stakeholders collaborate through QC DAO">
      <svg className="network-lines" viewBox="0 0 520 300" aria-hidden="true">
        <path d="M110 72 260 150 412 62M112 235 260 150 414 232M110 72 414 232M112 235 412 62" />
        <circle cx="110" cy="72" r="3" />
        <circle cx="412" cy="62" r="3" />
        <circle cx="112" cy="235" r="3" />
        <circle cx="414" cy="232" r="3" />
      </svg>
      <span className="network-core" aria-hidden="true">Q</span>
      {stakeholders.map(([type, label]) => (
        <span className={`network-node ${type}`} key={type}>
          <span className="network-icon"><StakeholderIcon type={type} /></span>
          <small>{label}</small>
        </span>
      ))}
    </div>
  );
}

function OpportunityCard({ item }) {
  return (
    <button
      className="opportunity-card"
      type="button"
      onClick={() => go(`opportunity/${item.id}`)}
      aria-label={`Open ${item.title}`}
    >
      <span className="opportunity-mark"><OpportunityIcon type={item.type} /></span>
      <span className="opportunity-summary">
        <strong>{item.title}</strong>
        <small>{item.type} · {item.owner}</small>
      </span>
      <span className="status-dot">{item.status}</span>
      <strong className="opportunity-amount">{item.amount}</strong>
      <span className="opportunity-deadline">{item.deadline}</span>
      <span className="row-arrow"><ArrowIcon /></span>
    </button>
  );
}

function OpportunityList({ items }) {
  return (
    <div className="opportunity-list">
      <div className="opportunity-list-head" aria-hidden="true">
        <span>Opportunity</span>
        <span>Status</span>
        <span>Budget</span>
        <span>Timing</span>
        <span />
      </div>
      {items.map((item) => <OpportunityCard item={item} key={item.id} />)}
    </div>
  );
}

function Home() {
  const { role } = useAuth();
  const canCreate = role === ROLES.OWNER || role === ROLES.RESEARCHER || role === ROLES.FUNDER || role === ROLES.ADMIN;

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>Fund research<br /><span>with clear outcomes.</span></h1>
          <p>Publish important problems, compare thoughtful proposals and support work through clear delivery stages.</p>
          <div className="actions">
            <button className="primary" type="button" onClick={() => go("discover")}>Explore opportunities</button>
            {canCreate && (
              <button className="secondary" type="button" onClick={() => go("create")}>Publish a brief</button>
            )}
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
  const { role } = useAuth();
  if (!item) return <NotFound />;

  const canCreate = role === ROLES.OWNER || role === ROLES.FUNDER || role === ROLES.ADMIN;
  const isResearcher = role === ROLES.RESEARCHER;

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
          {isResearcher ? (
            <button className="primary" type="button" onClick={() => go("proposals")}>
              Submit Proposal for Brief
            </button>
          ) : canCreate ? (
            <button className="primary" type="button" onClick={() => go("create")}>
              Create a similar brief
            </button>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function getAvailableOpportunityTypes(role) {
  if (role === ROLES.RESEARCHER) {
    return opportunityTypes.filter((t) => t.value === "funding-request");
  }
  if (role === ROLES.OWNER) {
    return opportunityTypes.filter((t) => t.value === "business-problem" || t.value === "open-funding");
  }
  if (role === ROLES.FUNDER) {
    return opportunityTypes.filter((t) => t.value === "open-funding" || t.value === "business-problem");
  }
  // Admin or fallback
  return opportunityTypes;
}

function CreateOpportunity() {
  const { role } = useAuth();
  const availableTypes = useMemo(() => getAvailableOpportunityTypes(role), [role]);

  const [form, setForm] = useState(() => ({
    opportunityType: availableTypes[0]?.value || "business-problem",
    title: "",
    summary: "",
    outcomes: "",
    amount: "",
  }));

  // Sync form default if role changes
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
    // Security check: ensure only researcher or admin can submit funding-request
    if (form.opportunityType === "funding-request" && role !== ROLES.RESEARCHER && role !== ROLES.ADMIN) {
      alert("Only researchers are permitted to submit funding requests.");
      return;
    }
    setSubmitted(true);
  };

  return (
    <section className="page create-page">
      <div className="page-heading">
        <h1>Create a funding opportunity</h1>
        <p>
          {role === ROLES.RESEARCHER
            ? "Publish a researcher-led funding request to connect with grants and enterprise sponsors."
            : "Choose the relationship that best fits the work, then add the details researchers and funders need."}
        </p>
      </div>
      {submitted ? (
        <div className="submission-success" role="status">
          <span aria-hidden="true">✓</span>
          <div>
            <h2>Brief preview created</h2>
            <p>Your brief is ready to review. Changes remain available for this session.</p>
          </div>
          <button className="secondary" type="button" onClick={() => setSubmitted(false)}>Continue editing</button>
        </div>
      ) : null}
      <form onSubmit={submit}>
        <fieldset className="workflow-picker">
          <legend>Opportunity type</legend>
          {availableTypes.map((option) => (
            <label className={form.opportunityType === option.value ? "chosen" : ""} key={option.value}>
              <input
                type="radio"
                name="opportunityType"
                value={option.value}
                checked={form.opportunityType === option.value}
                onChange={update}
              />
              <strong>{option.label}</strong>
              <span>{option.note}</span>
            </label>
          ))}
        </fieldset>

        <div className="form-section">
          <div><span className="form-step">01</span><h2>Opportunity overview</h2></div>
          <label>
            Title
            <input required minLength="6" name="title" value={form.title} onChange={update} placeholder={`${selectedType?.label || "Opportunity"} title`} />
          </label>
          <label>
            Summary
            <textarea required minLength="20" name="summary" value={form.summary} onChange={update} placeholder="Explain the need or research direction in plain language." />
          </label>
        </div>

        <div className="form-section">
          <div><span className="form-step">02</span><h2>Expected result</h2></div>
          <label>
            Outcomes
            <textarea required minLength="10" name="outcomes" value={form.outcomes} onChange={update} placeholder="What should be demonstrably true when the work is complete?" />
          </label>
          <label>
            Indicative budget
            <input required min="1" type="number" name="amount" value={form.amount} onChange={update} placeholder="Amount in USD" />
          </label>
        </div>

        <div className="form-actions">
          <p>Review your information before creating the preview.</p>
          <button className="primary" type="submit">Preview brief</button>
        </div>
      </form>
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
