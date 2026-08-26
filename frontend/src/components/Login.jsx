import { useState } from "react";
import { SignInWithWallet } from "./SignInWithWallet.jsx";

export function Login({ redirectTarget, onNavigate }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleInstitutionalLogin = (e) => {
    e.preventDefault();
    const destination = redirectTarget || "home";
    if (onNavigate) {
      onNavigate(destination);
    } else {
      window.location.hash = `/${destination}`;
    }
  };

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
              Sign in with your Web3 wallet or organization credentials to enter QC DAO.
            </p>
          )}
        </div>

        <div className="wallet-signin-section">
          <SignInWithWallet />
        </div>

        <div className="login-divider">
          <span>or continue with email</span>
        </div>

        <form onSubmit={handleInstitutionalLogin} className="standard-login-form">
          <div className="form-field">
            <label htmlFor="email">Institutional Email</label>
            <input
              id="email"
              type="email"
              required
              placeholder="name@institution.edu"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div className="login-actions">
            <button className="secondary full-width" type="submit">
              Sign In {redirectTarget ? `& Continue to ${redirectTarget}` : ""}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
