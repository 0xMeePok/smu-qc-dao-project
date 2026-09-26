import CreateProposalPage from "./pages/CreateProposalPage.jsx";
import ProposalDetailPage from "./pages/ProposalDetailPage.jsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { opportunityTypes } from "./data.js";
import { POSTING_CATEGORIES } from "./config/postingCategories.js";
import { ROLES } from "./config/roles.js";
import { getPermittedNavRoutes, getRouteConfig } from "./config/routes.js";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { useSession } from "./context/SessionContext.jsx";
import { shortenAddress } from "./lib/chain.js";
import { isAdmin, isAssignedEvaluator } from "./lib/roles.js";
import { ResponsiveHeader } from "./components/ResponsiveHeader.jsx";
import { useTheme } from "./lib/theme.js";
import { NotificationCentre } from "./components/ModerationNotifications.jsx";
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
import HomePage from "./pages/HomePage.jsx";
import ArchitectureHelpPage from "./pages/ArchitectureHelpPage.jsx";
import CreatePostingPage from "./pages/CreatePostingPage.jsx";
import CreateFundingOpportunityPage from "./pages/CreateFundingOpportunityPage.jsx";
import OpportunityEditPage from "./pages/OpportunityEditPage.jsx";
import PostingDetailPage from "./pages/PostingDetailPage.jsx";
import { listPublishedPostings } from "./lib/postings.js";
import { OPEN_FUNDING_TYPE } from "./config/fundingOpportunity.js";
import { toOpportunityListItem } from "./lib/opportunityPresentation.js";
import { ExpiryCountdown } from "./components/ExpiryCountdown.jsx";
import { VerifiedBadge } from "./components/VerifiedBadge.jsx";
import { opportunityStatusLabel } from "./config/workflowStatus.js";
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

const LAST_WORKSPACE_KEY = "qcdao-last-workspace";

function rememberWorkspace(key) {
  try { window.localStorage.setItem(LAST_WORKSPACE_KEY, key); } catch { /* private mode */ }
}

// Where "Workspaces" leads: the last workspace opened, if it is still permitted,
// otherwise the first one. The tabs on the page switch between them.
function workspaceHome(workspaceRoutes) {
  let last = null;
  try { last = window.localStorage.getItem(LAST_WORKSPACE_KEY); } catch { /* private mode */ }
  return workspaceRoutes.find((w) => w.key === last)?.key ?? workspaceRoutes[0]?.key;
}

function WorkspacesLink({ route, workspaceRoutes }) {
  const active = workspaceRoutes.some((w) => w.key === route);
  return (
    <button
      type="button"
      className={`nav-dropdown-trigger${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={() => go(workspaceHome(workspaceRoutes))}
    >
      Workspaces
    </button>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M12 5v14" />
    </svg>
  );
}

function ChevronIcon({ direction = "right", size = 16 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

function ThemeToggle({ theme, onToggle }) {
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button className="icon-button theme-toggle" type="button" onClick={onToggle} aria-label={label} title={label}>
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2m-7.07-2.93 1.41-1.41m11.32-11.32 1.41-1.41M2 12h2m16 0h2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )}
    </button>
  );
}

function AccountMenu({ name, roleLabel, workspaceRoutes, onSignOut }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event) => { if (!menuRef.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const navigate = (route) => { setOpen(false); go(route); };

  return (
    <div className="account-menu" ref={menuRef}>
      <button
        type="button"
        className="avatar-button"
        aria-label={`Account menu for ${name}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="avatar" aria-hidden="true">{initial}</span>
        <span className="account-menu-inline-name">{name}</span>
      </button>
      {open && (
        <div className="account-menu-panel" role="menu">
          <div className="account-menu-identity">
            <span className="avatar avatar-lg" aria-hidden="true">{initial}</span>
            <div>
              <strong>{name}</strong>
              <small>{roleLabel}</small>
            </div>
          </div>
          <div className="account-menu-divider" />
          <button type="button" role="menuitem" onClick={() => navigate("profile")}>Profile</button>
          {workspaceRoutes.length > 0 && (
            <button type="button" role="menuitem" onClick={() => navigate(workspaceHome(workspaceRoutes))}>Workspaces</button>
          )}
          <div className="account-menu-divider" />
          <button type="button" role="menuitem" className="account-menu-signout" onClick={() => { setOpen(false); onSignOut(); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function AccountControls({ theme, onToggleTheme, canCreate, workspaceRoutes }) {
  const { isSignedIn, profile, address, signOut } = useSession();
  const { hasRole } = useAuth();

  const newBrief = canCreate && (
    <button className="primary small new-brief-button" type="button" onClick={() => go("create")}>
      <PlusIcon />New brief
    </button>
  );

  if (isSignedIn) {
    const isDaoAdmin = isAdmin(profile?.role) || hasRole(ROLES.ADMIN);
    const roleLabel = isDaoAdmin ? "DAO Admin" : isAssignedEvaluator(profile?.role) ? "Evaluator" : "Platform member";
    const name = profile?.fullName || shortenAddress(address);
    return (
      <div className="account-controls">
        {newBrief}
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <NotificationCentre userId={address} />
        <AccountMenu
          name={name}
          roleLabel={profile?.organisation ? `${roleLabel} · ${profile.organisation}` : roleLabel}
          workspaceRoutes={workspaceRoutes}
          onSignOut={() => signOut()}
        />
      </div>
    );
  }

  return (
    <div className="account-controls">
      <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      <SignInWithWallet />
    </div>
  );
}

const WORKSPACE_ICONS = {
  "my-problems": "owner",
  proposals: "researcher",
  evaluations: "evaluator",
  funding: "funder",
};

function WorkspaceTabs({ route, workspaceRoutes }) {
  if (workspaceRoutes.length < 2) return null;
  return (
    <nav className="workspace-tabs" aria-label="Workspaces">
      {workspaceRoutes.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          className={route === key ? "selected" : ""}
          aria-current={route === key ? "page" : undefined}
          onClick={() => go(key)}
        >
          <StakeholderIcon type={WORKSPACE_ICONS[key]} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function Shell({ route, children }) {
  const { roles } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navRoutes = getPermittedNavRoutes(roles);

  // Primary navigation stays short: Profile lives in the account menu and
  // Create is the "New brief" button, so neither repeats as a nav link.
  const workspaceKeys = new Set(["my-problems", "proposals", "evaluations", "funding"]);
  const accountKeys = new Set(["profile", "create"]);
  const primaryRoutes = navRoutes.filter((r) => !workspaceKeys.has(r.key) && !accountKeys.has(r.key));
  const workspaceRoutes = navRoutes.filter((r) => workspaceKeys.has(r.key));
  const canCreate = navRoutes.some((r) => r.key === "create");

  useEffect(() => {
    if (workspaceKeys.has(route)) rememberWorkspace(route);
  }, [route]);
  const onHome = route === "home";

  return (
    <div className={`app-shell${onHome ? " is-home" : ""}`}>
      {/* The Liquid Glass colour field every pane floats over. */}
      <div className="ambient-backdrop" aria-hidden="true">
        <span className="ambient-blob b1" />
        <span className="ambient-blob b2" />
        <span className="ambient-blob b3" />
      </div>
      <ResponsiveHeader route={route} primaryRoutes={primaryRoutes} workspaceRoutes={workspaceRoutes}
        desktopWorkspaces={<WorkspacesLink route={route} workspaceRoutes={workspaceRoutes} />}
        accountControls={<AccountControls theme={theme} onToggleTheme={toggleTheme} canCreate={canCreate} workspaceRoutes={workspaceRoutes} />}
        onNavigate={go} />

      <main className="content">
        {workspaceKeys.has(route) && <div className="workspace-tabs-wrap"><WorkspaceTabs route={route} workspaceRoutes={workspaceRoutes} /></div>}
        {children}
      </main>

      <footer className="footer">
        <span className="footer-brand">QC DAO</span>
        <div className="footer-links">
          <button type="button" onClick={() => go("architecture")}>On-chain vs off-chain</button>
          <span>Arbitrum Sepolia (421614)</span>
          <span>Proof of concept</span>
        </div>
      </footer>
    </div>
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

function proposalLabel(count) {
  return `${count} ${count === 1 ? "proposal" : "proposals"}`;
}

function categoryLine(labels) {
  if (labels.length === 0) return "";
  return labels.length > 2 ? `${labels.slice(0, 2).join(", ")} +${labels.length - 2}` : labels.join(", ");
}

function openOpportunity(item) {
  go(`${item.route ?? "opportunity"}/${item.id}`);
}

function OpportunityTrust({ item }) {
  const statusLabel = opportunityStatusLabel(item.status, { expiresAt: item.expiresAt, matching: item.matching });
  return (
    <span className="trust-status-row">
      <span className={`status-dot${item.matching?.status === "awaiting_confirmation" ? " is-awaiting" : ""}`}>{statusLabel}</span>
      <VerifiedBadge audit={item.audit} recordStatus={item.status} hidePending />
    </span>
  );
}

// One row per opportunity. The stretched hit button makes the whole row a link
// while the verification badge above it stays independently focusable.
function OpportunityRow({ item }) {
  const categories = categoryLine(item.categoryLabels);
  return (
    <div className="opportunity-row">
      <button className="opportunity-card-hit" type="button" onClick={() => openOpportunity(item)} aria-label={`View ${item.title}`} />
      <div className="opportunity-row-main">
        <strong>{item.title}</strong>
        <small>{[item.owner, item.type, categories].filter(Boolean).join(" · ")}</small>
        <OpportunityTrust item={item} />
      </div>
      <div className="opportunity-row-side">
        <strong>{item.amount}</strong>
        <small>
          <ExpiryCountdown expiresAt={item.expiresAt} status={item.status} matching={item.matching} showInstant={false} />
          <span aria-hidden="true"> · </span>
          {proposalLabel(item.proposalCount)}
        </small>
      </div>
      <span className="row-chevron"><ChevronIcon /></span>
    </div>
  );
}

function OpportunityTile({ item }) {
  const categories = categoryLine(item.categoryLabels);
  return (
    <div className="opportunity-tile">
      <button className="opportunity-card-hit" type="button" onClick={() => openOpportunity(item)} aria-label={`View ${item.title}`} />
      <small className="opportunity-tile-type">{item.type}</small>
      <strong className="opportunity-tile-title">{item.title}</strong>
      <span className="opportunity-tile-org">{item.owner}</span>
      <span className="opportunity-tile-spacer" />
      {categories && <small className="opportunity-tile-tags">{categories}</small>}
      <OpportunityTrust item={item} />
      <div className="opportunity-tile-foot">
        <strong>{item.amount}</strong>
        <ExpiryCountdown expiresAt={item.expiresAt} status={item.status} matching={item.matching} showInstant={false} />
      </div>
    </div>
  );
}

function OpportunityTable({ items }) {
  return (
    <div className="opportunity-table-scroll">
      <table className="opportunity-table">
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Organisation</th>
            <th scope="col">Status</th>
            <th scope="col" className="numeric">Funding</th>
            <th scope="col" className="numeric">Proposals</th>
            <th scope="col" className="numeric">Closes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <button className="opportunity-table-link" type="button" onClick={() => openOpportunity(item)}>{item.title}</button>
                <small>{item.type}</small>
              </td>
              <td>{item.owner}</td>
              <td><OpportunityTrust item={item} /></td>
              <td className="numeric">{item.amount}</td>
              <td className="numeric">{item.proposalCount}</td>
              <td className="numeric">{item.deadline}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpportunityList({ items, view = "rows" }) {
  if (view === "cards") {
    return <div className="opportunity-grid">{items.map((item) => <OpportunityTile item={item} key={item.id} />)}</div>;
  }
  if (view === "table") return <OpportunityTable items={items} />;
  return <div className="opportunity-list">{items.map((item) => <OpportunityRow item={item} key={item.id} />)}</div>;
}

function OpportunityListSkeleton() {
  return (
    <div className="opportunity-list opportunity-list-skeleton" aria-label="Loading opportunities" aria-busy="true">
      {[0, 1, 2, 3].map((row) => (
        <div className="opportunity-skeleton-row" key={row}>
          <span className="skeleton-lines"><i /><i /></span>
          <span className="skeleton-block" />
        </div>
      ))}
    </div>
  );
}

function Home() {
  const { postings, loading, isAuthenticated } = usePublishedPostings();
  const { roles } = useAuth();
  const workspaceRoutes = getPermittedNavRoutes(roles)
    .filter((r) => ["my-problems", "proposals", "evaluations", "funding"].includes(r.key));
  return (
    <HomePage
      postings={postings}
      loading={loading}
      isAuthenticated={isAuthenticated}
      onNavigate={go}
      // Signed out there is no workspace yet; the guard on my-problems sends them to sign in.
      onOpenWorkspaces={() => go(workspaceHome(workspaceRoutes) ?? "my-problems")}
    />
  );
}

// Live postings, shared by Home and Discover. Reading one needs an active session,
// so a signed-out visitor is never sent to Firestore just to be denied.
function usePublishedPostings() {
  const { isAuthenticated } = useAuth();
  const [postings, setPostings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const cursor = useRef(null);
  const generation = useRef(0);
  const busy = useRef(false);

  async function loadPage(reset = false) {
    if (busy.current || !isAuthenticated) return;
    busy.current = true;
    const current = generation.current;
    setLoading(true);
    setLoadError(null);
    try {
      const page = await listPublishedPostings({ cursor: reset ? null : cursor.current });
      if (generation.current !== current) return;
      cursor.current = page.cursor;
      setHasMore(page.hasMore);
      setPostings((old) => reset ? page.items.map(toOpportunityListItem)
        : [...old, ...page.items.filter((item) => !old.some((row) => row.id === item.id)).map(toOpportunityListItem)]);
    } catch (error) { if (generation.current === current) setLoadError(error); }
    finally {
      if (generation.current === current) { busy.current = false; setLoading(false); }
    }
  }

  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    cursor.current = null;
    setPostings([]);
    setHasMore(false);
    setLoadError(null);
    if (isAuthenticated) loadPage(true);
    else setLoading(false);
    return () => { generation.current += 1; };
  }, [isAuthenticated]);

  return { postings, loading, loadError, isAuthenticated, hasMore, loadMore: () => loadPage(false) };
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

const DISCOVER_VIEWS = [
  { value: "rows", label: "List", icon: <path d="M3 6h18M3 12h18M3 18h18" /> },
  { value: "cards", label: "Cards", icon: <><rect width="7" height="7" x="3" y="3" rx="1.5" /><rect width="7" height="7" x="14" y="3" rx="1.5" /><rect width="7" height="7" x="14" y="14" rx="1.5" /><rect width="7" height="7" x="3" y="14" rx="1.5" /></> },
  { value: "table", label: "Table", icon: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></> },
];
const DISCOVER_VIEW_KEY = "qcdao-discover-view";

function useDiscoverView() {
  const [view, setView] = useState(() => {
    try {
      const stored = window.localStorage.getItem(DISCOVER_VIEW_KEY);
      return DISCOVER_VIEWS.some(({ value }) => value === stored) ? stored : "rows";
    } catch {
      return "rows";
    }
  });
  const choose = (next) => {
    setView(next);
    try { window.localStorage.setItem(DISCOVER_VIEW_KEY, next); } catch { /* private mode */ }
  };
  return [view, choose];
}

function Discover({ params }) {
  const { postings, loading, loadError, isAuthenticated, hasMore, loadMore } = usePublishedPostings();
  const paramsKey = params.toString();
  const [filters, setFilters] = useState(() => parseDiscoveryParams(params));
  const [view, setView] = useDiscoverView();

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
  const panelFilterCount = ["category", "status", "organisation", "timeRemaining", "minimumFunding", "maximumFunding"]
    .filter((key) => String(filters[key] ?? "") !== "").length;
  const [filtersOpen, setFiltersOpen] = useState(panelFilterCount > 0);

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

  const typeTabs = [{ value: "", label: "All" }, ...opportunityTypes.filter(({ value }) => value !== "funding-request")];

  return (
    <section className="page discover-page">
      <div className="page-heading">
        <h1>Discover</h1>
        <p>Every open problem and funding call, in one place.</p>
      </div>

      <div className="discover-search-row">
        <label className="discover-search">
          <span className="sr-only">Search opportunities</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={filters.query}
            placeholder="Search title, description or tags"
            onChange={(event) => updateFilters({ query: event.target.value })}
          />
        </label>
        <button
          className={`filter-toggle${filtersOpen ? " is-open" : ""}`}
          type="button"
          aria-expanded={filtersOpen}
          aria-controls="discover-filter-panel"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
          </svg>
          Filters{panelFilterCount > 0 ? ` · ${panelFilterCount}` : ""}
        </button>
        <label className="discover-sort">
          <span className="sr-only">Sort by</span>
          <select value={filters.sort} onChange={(event) => updateFilters({ sort: event.target.value })}>
            {DISCOVERY_SORT_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      {filtersOpen && (
        <div id="discover-filter-panel" className="discover-filter-panel" aria-label="Opportunity filters">
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
                <option value={status} key={status}>{opportunityStatusLabel(status)}</option>
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
            <span>Closes within</span>
            <select value={filters.timeRemaining} onChange={(event) => updateFilters({ timeRemaining: event.target.value })}>
              <option value="">Any closing date</option>
              {DISCOVERY_TIME_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <fieldset className="funding-range">
            <legend>Funding</legend>
            <label>
              <span className="sr-only">Minimum funding</span>
              <input
                min="0"
                inputMode="decimal"
                type="number"
                value={filters.minimumFunding}
                placeholder="Min"
                onChange={(event) => updateFilters({ minimumFunding: event.target.value })}
              />
            </label>
            <label>
              <span className="sr-only">Maximum funding</span>
              <input
                min="0"
                inputMode="decimal"
                type="number"
                value={filters.maximumFunding}
                placeholder="Max"
                onChange={(event) => updateFilters({ maximumFunding: event.target.value })}
              />
            </label>
          </fieldset>
          {activeFilters && (
            <button className="text-button discover-clear" type="button" onClick={clearFilters}>Clear filters</button>
          )}
        </div>
      )}

      <div className="discover-toolbar">
        <div className="segmented" role="group" aria-label="Posting type">
          {typeTabs.map((item) => (
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
        <div className="discover-toolbar-end">
          {!loading && !loadError && postings.length > 0 && (
            <span className="discover-results-summary" aria-live="polite">
              {results.totalResults} {results.totalResults === 1 ? "opportunity" : "opportunities"}
              {results.totalPages > 1 && ` · showing ${results.firstResult}–${results.lastResult}`}
            </span>
          )}
          <div className="segmented segmented-icons" role="group" aria-label="Layout">
            {DISCOVER_VIEWS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={view === option.value ? "selected" : ""}
                aria-pressed={view === option.value}
                aria-label={option.label}
                title={option.label}
                onClick={() => setView(option.value)}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">{option.icon}</svg>
              </button>
            ))}
          </div>
        </div>
      </div>

      {hasMore && <p className="notice">Filters and sorting apply to the opportunities loaded so far. Load more to search further.</p>}
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
          {results.totalResults === 0 ? (
            <div className="discover-empty discover-no-results" role="status">
              <h2>No matches</h2>
              <p>Try a different search or clear your filters.</p>
              <button className="secondary" type="button" onClick={clearFilters}>Clear all filters</button>
            </div>
          ) : (
            <OpportunityList items={results.items} view={view} />
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
      {hasMore && <div className="discover-load-more">
        <button type="button" className="secondary" disabled={loading} onClick={loadMore}>
          {loading ? "Loading opportunities…" : "Load more opportunities"}
        </button>
      </div>}
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
  const { user } = useAuth();
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
        <ProfilePage onNavigate={go} />
      </RouteGuard>
    );
  } else if (section === "submit-proposal" || section === "edit-proposal" || section === "proposal") {
    pageComponent = <RouteGuard targetRoute={fullPath} allowedRoles={routeConfig?.allowedRoles} authRequired={routeConfig?.authRequired} onNavigate={go}>
      {/* submit-proposal carries an opportunity id, edit-proposal a proposal id.
          Both render the same form; see CreateProposalPage. */}
      {section === "submit-proposal" ? <CreateProposalPage key={`${id}-${user?.id}`} postingId={id} onNavigate={go} />
        : section === "edit-proposal" ? <CreateProposalPage key={`edit-${id}-${user?.id}`} proposalId={id} onNavigate={go} />
        : <ProposalDetailPage key={`${id}-${user?.id}`} proposalId={id} onNavigate={go} />}
    </RouteGuard>;
  } else if (section === "edit-posting") {
    pageComponent = (
      <RouteGuard targetRoute={fullPath} allowedRoles={routeConfig?.allowedRoles} authRequired={routeConfig?.authRequired} onNavigate={go}>
        <OpportunityEditPage key={`edit-posting-${id}-${user?.id}`} postingId={id} onNavigate={go} />
      </RouteGuard>
    );
  } else if (section === "create-funding") {
    // Resuming an open-funding draft. Keyed on the id for the same reason
    // CreatePostingPage is: the opportunity id is seeded once, so without a
    // remount a switch between drafts would keep the old one for saves.
    pageComponent = (
      <RouteGuard
        targetRoute={fullPath}
        allowedRoles={routeConfig?.allowedRoles}
        authRequired={routeConfig?.authRequired}
        onNavigate={go}
      >
        <CreateFundingOpportunityPage key={id ?? "new"} resumeId={id} onNavigate={go} />
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
        <AdminPage onNavigate={go} />
      </RouteGuard>
    );
  } else if (section === "architecture") {
    pageComponent = <ArchitectureHelpPage onNavigate={go} />;
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
