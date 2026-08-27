import { useEffect } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { landingRouteFor } from "../config/roles.js";
import { SignInWithWallet } from "./SignInWithWallet.jsx";
import { getRouteConfig } from "../config/routes.js";

export function Login({ redirectTarget, onNavigate }) {
  const { isAuthenticated, roles, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated) {
      // An interrupted route wins; otherwise land on the screen this role actually
      // works from, rather than sending an administrator to the public home page.
      const landing = landingRouteFor(roles);
      let destination = redirectTarget || landing;
      if (redirectTarget && !getRouteConfig(redirectTarget)) {
        destination = landing;
      }
      
      if (onNavigate) {
        onNavigate(destination);
      } else {
        window.location.hash = `/${destination}`;
      }
    }
  }, [isLoading, isAuthenticated, roles, redirectTarget, onNavigate]);

  return (
    <section className="page login-page">
      <div className="login-card">
        <div className="login-header">
          <div className="login-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <polyline points="10 17 15 12 10 7" />
              <line x1="15" y1="12" x2="3" y2="12" />
            </svg>
          </div>
          <h1>Platform Sign In</h1>
          {redirectTarget ? (
            <div className="redirect-notice" role="status">
              <span className="notice-badge">Auth Required</span>
              <div>
                <strong>Authentication Required</strong>
                <p>
                  You must sign in to access <code>{`#/${redirectTarget}`}</code>. Your destination will load immediately after authentication.
                </p>
              </div>
            </div>
          ) : (
            <p className="login-subhead">
              Sign in with your verified Web3 wallet to access your SMU QC DAO workspaces.
            </p>
          )}
        </div>

        <div className="wallet-signin-section">
          <SignInWithWallet />
        </div>
      </div>
    </section>
  );
}

