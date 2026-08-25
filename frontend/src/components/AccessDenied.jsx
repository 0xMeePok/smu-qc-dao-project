import { ROLES } from "../config/roles.js";
import { useAuth } from "../context/AuthContext.jsx";

export function AccessDenied({ onNavigate }) {
  const { role, isAuthenticated } = useAuth();

  const getDashboardRoute = () => {
    if (!isAuthenticated) return "login";
    switch (role) {
      case ROLES.OWNER:
        return "my-problems";
      case ROLES.RESEARCHER:
        return "proposals";
      case ROLES.EVALUATOR:
        return "evaluations";
      case ROLES.FUNDER:
        return "funding";
      case ROLES.ADMIN:
        return "admin";
      default:
        return "home";
    }
  };

  const handleReturn = () => {
    const target = getDashboardRoute();
    if (onNavigate) {
      onNavigate(target);
    } else {
      window.location.hash = `/${target}`;
    }
  };

  const handleBrowse = () => {
    if (onNavigate) {
      onNavigate("discover");
    } else {
      window.location.hash = "/discover";
    }
  };

  return (
    <section className="page access-denied-page">
      <div className="access-denied-card">
        <div className="access-denied-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            <line x1="12" y1="15" x2="12" y2="17" />
          </svg>
        </div>

        <span className="http-status">403 · Access Restricted</span>
        <h1>Access Denied</h1>
        <p className="access-explanation">
          You don't have permission to access this page or perform this action.
          If you believe this is a mistake, please verify your credentials or contact your organization administrator.
        </p>

        <div className="access-actions">
          <button className="primary" type="button" onClick={handleReturn}>
            {isAuthenticated ? "Return to Dashboard" : "Sign In with Another Account"}
          </button>
          <button className="secondary" type="button" onClick={handleBrowse}>
            Browse Opportunities
          </button>
        </div>
      </div>
    </section>
  );
}
