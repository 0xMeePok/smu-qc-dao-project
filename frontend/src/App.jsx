import { useEffect, useMemo, useRef, useState } from "react";
import { opportunityTypes } from "./data.js";
import { POSTING_CATEGORIES } from "./config/postingCategories.js";
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
import { formatCountdown } from "./lib/datetime.js";
import {
  DEFAULT_DISCOVERY_FILTERS,
  DISCOVERY_SORT_OPTIONS,
  DISCOVERY_TIME_OPTIONS,
  discoverOpportunities,
  discoveryParams,
  hasActiveDiscoveryFilters,
  parseDiscoveryParams,
} from "./lib/opportunityDiscovery.js";

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
  const proposalLabel = `${item.proposalCount} ${item.proposalCount === 1 ? "proposal" : "proposals"}`;
  const statusLabel = String(item.status ?? "open")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());

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
        <span className="opportunity-categories" aria-label="Technology areas">
          {item.categoryLabels.slice(0, 3).map((category) => (
            <small className="opportunity-category" key={category}>{category}</small>
          ))}
          {item.categoryLabels.length > 3 && (
            <small className="opportunity-category">+{item.categoryLabels.length - 3}</small>
          )}
        </span>
      </div>
      <div className="opportunity-activity">
        <span className="status-dot">{statusLabel}</span>
        <small>{proposalLabel}</small>
      </div>
      <div className="opportunity-funding">
        <span className="opportunity-amount">{item.amount}</span>
        <span className="funding-progress" aria-label={`${item.fundingProgressPercent}% funded`}>
          <span style={{ width: `${item.fundingProgressPercent}%` }} />
        </span>
        <small>{item.fundingProgressPercent}% funded</small>
      </div>
      <div className="opportunity-deadline">
        <strong>{formatCountdown(item.expiresAt)}</strong>
        <small>{item.deadline}</small>
      </div>
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
        <span>Status &amp; proposals</span>
        <span>Funding</span>
        <span>Time remaining</span>
        <span />
      </div>
      {items.map((item) => <OpportunityCard item={item} key={item.id} />)}
    </div>
  );
}

function OpportunityListSkeleton() {
  return (
    <div className="opportunity-list opportunity-list-skeleton" aria-label="Loading opportunities" aria-busy="true">
      <div className="opportunity-list-head">
        <span>Problem or funding call</span>
        <span>Status &amp; proposals</span>
        <span>Funding</span>
        <span>Time remaining</span>
        <span />
      </div>
      {[0, 1, 2, 3].map((row) => (
        <div className="opportunity-skeleton-row" key={row}>
          <span className="skeleton-block skeleton-icon" />
          <span className="skeleton-lines"><i /><i /></span>
          <span className="skeleton-block" />
          <span className="skeleton-block" />
          <span className="skeleton-block" />
        </div>
      ))}
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
    setLoadError(null);
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

function syncDiscoverUrl(filters) {
  const query = discoveryParams(filters).toString();
  const hash = `#/discover${query ? `?${query}` : ""}`;
  if (window.location.hash !== hash) {
    window.history.replaceState(window.history.state, "", hash);
  }
}

function Discover({ params }) {
  const { postings, loading, loadError, isAuthenticated } = usePublishedPostings();
  const paramsKey = params.toString();
  const [filters, setFilters] = useState(() => parseDiscoveryParams(params));

  useEffect(() => {
    setFilters(parseDiscoveryParams(params));
  }, [paramsKey]);

  const organisations = useMemo(() => (
    [...new Set(postings.map((item) => item.organisation || item.owner).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right))
  ), [postings]);
  const statuses = useMemo(() => (
    [...new Set(postings.map((item) => String(item.status ?? "").toLowerCase()).filter(Boolean))]
      .sort()
  ), [postings]);
  const results = useMemo(
    () => discoverOpportunities(postings, filters),
    [postings, filters],
  );
  const activeFilters = hasActiveDiscoveryFilters(filters);

  const updateFilters = (changes) => {
    setFilters((current) => {
      const next = { ...current, ...changes, page: changes.page ?? 1 };
      syncDiscoverUrl(next);
      return next;
    });
  };

  const clearFilters = () => {
    const next = { ...DEFAULT_DISCOVERY_FILTERS, sort: filters.sort };
    setFilters(next);
    syncDiscoverUrl(next);
  };

  return (
    <section className="page discover-page">
      <div className="discover-heading-row">
        <div className="page-heading">
          <h1>Explore research opportunities</h1>
          <p>Browse every open problem statement and funding opportunity in one place.</p>
        </div>
        <label className="discover-sort">
          <span>Sort by</span>
          <select value={filters.sort} onChange={(event) => updateFilters({ sort: event.target.value })}>
            {DISCOVERY_SORT_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="discover-search-row">
        <label className="discover-search">
          <span className="sr-only">Search opportunities</span>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="M12.5 12.5L17 17" />
          </svg>
          <input
            type="search"
            value={filters.query}
            placeholder="Search title, description or tags"
            onChange={(event) => updateFilters({ query: event.target.value })}
          />
        </label>
        {activeFilters && (
          <button className="secondary discover-clear" type="button" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      <div className="filters" aria-label="Posting type">
        {[{ value: "", label: "All opportunities" }, ...opportunityTypes.filter(({ value }) => value !== "funding-request")].map((item) => (
          <button
            className={filters.type === item.value ? "selected" : ""}
            key={item.value || "all"}
            type="button"
            aria-pressed={filters.type === item.value}
            onClick={() => updateFilters({ type: item.value })}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="discover-filter-panel" aria-label="Opportunity filters">
        <label>
          <span>Technology area</span>
          <select value={filters.category} onChange={(event) => updateFilters({ category: event.target.value })}>
            <option value="">All areas</option>
            {POSTING_CATEGORIES.map((category) => (
              <option value={category.value} key={category.value}>
                {category.value === "quantum" ? "Quantum — gate-based, annealing & quantum-inspired" : category.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select value={filters.status} onChange={(event) => updateFilters({ status: event.target.value })}>
            <option value="">All statuses</option>
            {statuses.map((status) => (
              <option value={status} key={status}>{status.replaceAll("_", " ")}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Organisation</span>
          <select value={filters.organisation} onChange={(event) => updateFilters({ organisation: event.target.value })}>
            <option value="">All organisations</option>
            {organisations.map((organisation) => (
              <option value={organisation} key={organisation}>{organisation}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Time remaining</span>
          <select value={filters.timeRemaining} onChange={(event) => updateFilters({ timeRemaining: event.target.value })}>
            <option value="">Any closing date</option>
            {DISCOVERY_TIME_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <fieldset className="funding-range">
          <legend>Funding amount</legend>
          <label>
            <span className="sr-only">Minimum funding</span>
            <input
              min="0"
              inputMode="decimal"
              type="number"
              value={filters.minimumFunding}
              placeholder="Minimum"
              onChange={(event) => updateFilters({ minimumFunding: event.target.value })}
            />
          </label>
          <span aria-hidden="true">–</span>
          <label>
            <span className="sr-only">Maximum funding</span>
            <input
              min="0"
              inputMode="decimal"
              type="number"
              value={filters.maximumFunding}
              placeholder="Maximum"
              onChange={(event) => updateFilters({ maximumFunding: event.target.value })}
            />
          </label>
        </fieldset>
      </div>

      {!isAuthenticated && <SignedOutNotice />}
      {isAuthenticated && loading && <OpportunityListSkeleton />}
      {loadError && (
        <p className="notice notice-error" role="alert">
          We could not load published opportunities. Please refresh and try again.
        </p>
      )}
      {!loading && !loadError && isAuthenticated && postings.length === 0 && (
        <div className="discover-empty" role="status">
          <span className="empty-icon-wrapper" aria-hidden="true"><OpportunityIcon /></span>
          <h2>No open opportunities yet</h2>
          <p>New problem statements and funding opportunities will appear here once published.</p>
        </div>
      )}
      {!loading && !loadError && postings.length > 0 && (
        <>
          <div className="discover-results-summary" aria-live="polite">
            <strong>{results.totalResults} {results.totalResults === 1 ? "opportunity" : "opportunities"}</strong>
            {results.totalResults > 0 && (
              <span>Showing {results.firstResult}–{results.lastResult}</span>
            )}
          </div>
          {results.totalResults === 0 ? (
            <div className="discover-empty discover-no-results" role="status">
              <span className="empty-icon-wrapper" aria-hidden="true"><OpportunityIcon /></span>
              <h2>No opportunities match these filters</h2>
              <p>Try a broader keyword, funding range, category or closing window.</p>
              <button className="secondary" type="button" onClick={clearFilters}>Clear all filters</button>
            </div>
          ) : (
            <OpportunityList items={results.items} />
          )}
          {results.totalPages > 1 && (
            <nav className="discover-pagination" aria-label="Opportunity pages">
              <button
                className="secondary small"
                type="button"
                disabled={results.page === 1}
                onClick={() => updateFilters({ page: results.page - 1 })}
              >
                Previous
              </button>
              <span>Page {results.page} of {results.totalPages}</span>
              <button
                className="secondary small"
                type="button"
                disabled={results.page === results.totalPages}
                onClick={() => updateFilters({ page: results.page + 1 })}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
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
    pageComponent = <Discover params={params} />;
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
        {/* The id segment carries two meanings now: the funding-opportunity type
            from main, or a draft id to resume (QCDAO-50). Keyed on it because
            postingId is seeded once, so without a remount switching between
            Create and Resume kept the old id for uploads and saves while showing
            the other draft's fields. */}
        {id === OPEN_FUNDING_TYPE
          ? <CreateFundingOpportunityPage onNavigate={go} />
          : <CreatePostingPage key={id ?? "new"} postingId={id} onNavigate={go} />}
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
