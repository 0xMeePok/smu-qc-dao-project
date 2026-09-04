import { useEffect, useRef, useState } from "react";
import { opportunityTypes } from "./data.js";
import { ROLES } from "./config/roles.js";
import { getPermittedNavRoutes, getRouteConfig } from "./config/routes.js";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { useSession } from "./context/SessionContext.jsx";
import { shortenAddress } from "./lib/chain.js";
import { isAdmin } from "./lib/roles.js";
import { RouteGuard } from "./components/RouteGuard.jsx";
import { Login } from "./components/Login.jsx";
import { AccessDenied } from "./components/AccessDenied.jsx";
import { SignInWithWallet } from "./components/SignInWithWallet.jsx";
import { OnboardingModal } from "./components/OnboardingModal.jsx";
import { NetworkBanner } from "./components/NetworkBanner.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";
import PublicProfilePage from "./pages/PublicProfilePage.jsx";
import { SuspensionBanner } from "./components/SuspensionBanner.jsx";
import {
  MyProblems,
  ResearcherProposals,
  EvaluatorQueue,
  FundingPortfolio,
} from "./components/RoleViews.jsx";
import AdminPage from "./pages/AdminPage.jsx";
import CreatePostingPage from "./pages/CreatePostingPage.jsx";
import CreateFundingOpportunityPage from "./pages/CreateFundingOpportunityPage.jsx";
import PostingDetailPage from "./pages/PostingDetailPage.jsx";
import { listPublishedPostings } from "./lib/postings.js";
import { OPEN_FUNDING_TYPE } from "./config/fundingOpportunity.js";
import { toOpportunityListItem } from "./lib/opportunityPresentation.js";

function parseHash() {
  if (typeof window !== "undefined") {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.has("demo") || window.location.pathname.includes("/demo")) {
      return { section: "404-not-found", id: null, fullPath: "demo", params: new URLSearchParams() };
    }
  }

  const hash = window.location.hash.replace(/^#\/?/, "") || "home";
  const [pathAndParams, queryString] = hash.split("?");
  const params = new URLSearchParams(queryString || "");
  if (params.has("demo") || pathAndParams === "demo" || pathAndParams.startsWith("demo/")) {
    return { section: "404-not-found", id: null, fullPath: pathAndParams, params };
  }

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
    window.addEventListener("popstate", updateRoute);
    return () => {
      window.removeEventListener("hashchange", updateRoute);
      window.removeEventListener("popstate", updateRoute);
    };
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

function AccountControls() {
  const { isSignedIn, profile, address, signOut } = useSession();
  const { hasRole } = useAuth();

  if (isSignedIn) {
    const isDaoAdmin = isAdmin(profile?.role) || hasRole(ROLES.ADMIN);
    return (
      <div className="account-controls">
        <div className="user-session-pill">
          <div className="user-session-info">
            <button className="user-name account-profile-link" type="button" onClick={() => go("profile")}>
              {profile?.fullName || shortenAddress(address)}
            </button>
            <div className="role-tags-row">
              {isDaoAdmin ? (
                <span className="user-role-badge admin-badge">DAO Admin</span>
              ) : (
                <span className="user-role-badge member-badge" title="Owner · Researcher · Evaluator · Funder">
                  Platform Member
                </span>
              )}
            </div>
          </div>
          <button className="signout-btn" type="button" onClick={() => signOut()} title="Sign Out">
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="account-controls">
      <SignInWithWallet />
    </div>
  );
}

function Shell({ route, children }) {
  const { roles } = useAuth();
  const navRoutes = getPermittedNavRoutes(roles);

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
          <AccountControls />
        </div>
      </header>

      <main className="content">{children}</main>

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
    <button className="opportunity-card" type="button" onClick={() => go(`${item.route ?? "opportunity"}/${item.id}`)}>
      <span className="opportunity-mark">
        <OpportunityIcon type={item.type} />
      </span>
      <div className="opportunity-summary">
        <strong>{item.title}</strong>
        <span className="opportunity-byline">
          <small>{item.owner}</small>
          <span className={`opportunity-type-badge ${item.type === "Open funding" ? "funding" : "problem"}`}>
            {item.type}
          </span>
        </span>
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
  const { postings, loading, isAuthenticated } = usePublishedPostings();

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
        {!isAuthenticated && <SignedOutNotice />}
        {isAuthenticated && loading && <p className="lead">Loading opportunities…</p>}
        {isAuthenticated && !loading && postings.length === 0 && (
          <p className="lead">No open opportunities yet. Publish the first one.</p>
        )}
        {postings.length > 0 && <OpportunityList items={postings.slice(0, 5)} />}
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

// Live postings, shared by Home and Discover. Reading one needs an active session,
// so a signed-out visitor is never sent to Firestore just to be denied.
function usePublishedPostings() {
  const { isAuthenticated } = useAuth();
  const [postings, setPostings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    if (!isAuthenticated) {
      setPostings([]);
      setLoadError(null);
      setLoading(false);
      return () => { cancelled = true; };
    }

    setLoading(true);
    listPublishedPostings()
      .then((items) => {
        if (cancelled) return;
        setPostings(items.map(toOpportunityListItem));
      })
      .catch((error) => { if (!cancelled) setLoadError(error); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [isAuthenticated]);

  return { postings, loading, loadError, isAuthenticated };
}

function SignedOutNotice() {
  return (
    <p className="notice" role="status">
      Sign in to see opportunities posted by other organisations.
    </p>
  );
}

function Discover() {
  const { postings, loading, loadError, isAuthenticated } = usePublishedPostings();
  const [filter, setFilter] = useState("All");

  const filters = ["All", ...opportunityTypes.map(({ label }) => label)];
  const visibleOpportunities = filter === "All"
    ? postings
    : postings.filter((item) => item.type === filter);

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
            aria-pressed={filter === item}
            onClick={() => setFilter(item)}
          >
            {item}
          </button>
        ))}
      </div>
      {!isAuthenticated && <SignedOutNotice />}
      {loading && <p className="lead">Loading published opportunities…</p>}
      {loadError && (
        <p className="notice notice-error" role="alert">
          We could not load published opportunities. Please refresh and try again.
        </p>
      )}
      {!loading && !loadError && visibleOpportunities.length === 0 && (
        <p className="lead">No published opportunities match this filter.</p>
      )}
      {!loadError && <OpportunityList items={visibleOpportunities} />}
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
  const { section, id, fullPath, params } = useRoute();
  const routeConfig = getRouteConfig(section);

  let pageComponent = <NotFound />;

  if (section === "home") {
    pageComponent = <Home />;
  } else if (section === "discover") {
    pageComponent = <Discover />;
  } else if (section === "profile") {
    pageComponent = id ? (
      <PublicProfilePage address={id} onNavigate={go} />
    ) : (
      <RouteGuard
        targetRoute={section}
        allowedRoles={routeConfig?.allowedRoles}
        authRequired={routeConfig?.authRequired}
        onNavigate={go}
      >
        <ProfilePage />
      </RouteGuard>
    );
  } else if (section === "posting") {
    pageComponent = (
      <RouteGuard
        targetRoute={section}
        allowedRoles={routeConfig?.allowedRoles}
        authRequired={routeConfig?.authRequired}
        onNavigate={go}
      >
        <PostingDetailPage postingId={id} onNavigate={go} />
      </RouteGuard>
    );
    } else if (section === "login") {
    pageComponent = <Login redirectTarget={params.get("redirect")} onNavigate={go} />;
  } else if (section === "create") {
    pageComponent = (
      <RouteGuard
        targetRoute={fullPath}
        allowedRoles={routeConfig?.allowedRoles}
        authRequired={routeConfig?.authRequired}
        onNavigate={go}
      >
        {id === OPEN_FUNDING_TYPE
          ? <CreateFundingOpportunityPage onNavigate={go} />
          : <CreatePostingPage onNavigate={go} />}
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
        <AdminPage />
      </RouteGuard>
    );
  } else if (section === "access-denied") {
    pageComponent = <AccessDenied onNavigate={go} />;
  }

  return (
    <>
      <NetworkBanner />
      <SuspensionBanner />
      <Shell route={section}>{pageComponent}</Shell>
      <OnboardingModal />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
