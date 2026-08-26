import { useState } from "react";
import { DEMO_USERS } from "../config/roles.js";
import { FEATURES } from "../config/features.js";
import { useAuth } from "../context/AuthContext.jsx";

export function Login({ redirectTarget, onNavigate }) {
  const { login } = useAuth();
  const [selectedProfile, setSelectedProfile] = useState("member");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleLogin = (e) => {
    e.preventDefault();
    login(selectedProfile);
    const destination = redirectTarget || "home";
    if (onNavigate) {
      onNavigate(destination);
    } else {
      window.location.hash = `/${destination}`;
    }
  };

  const handleDirectSelect = (profileKey) => {
    login(profileKey);
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
              Sign in with your organization credentials to enter QC DAO.
            </p>
          )}
        </div>

        {FEATURES.DEMO_ROLE_SWITCHER ? (
          <form onSubmit={handleLogin} className="role-selection-form">
            <fieldset className="role-cards-grid">
              <legend className="sr-only">Select Account Profile</legend>

              {/* Multi-Role Member Card */}
              <div
                className={`role-option-card ${selectedProfile === "member" ? "selected" : ""}`}
                onClick={() => setSelectedProfile("member")}
              >
                <div className="role-option-radio">
                  <input
                    type="radio"
                    id="profile-member"
                    name="selectedProfile"
                    value="member"
                    checked={selectedProfile === "member"}
                    onChange={() => setSelectedProfile("member")}
                  />
                </div>
                <div className="role-option-body">
                  <div className="role-title-row">
                    <label htmlFor="profile-member" className="role-name">
                      Platform Member
                    </label>
                    <span className="user-persona-tag">{DEMO_USERS.member.name}</span>
                  </div>
                  <p className="role-desc">
                    Unified account with full access to Problem Owner, Researcher, Evaluator, and Funder workspaces.
                  </p>
                  <div className="role-meta">
                    <span>{DEMO_USERS.member.org}</span> · <span className="mono">{DEMO_USERS.member.address}</span>
                  </div>
                  <div className="capabilities-badges">
                    <span className="mini-badge">Problem Owner</span>
                    <span className="mini-badge">Researcher</span>
                    <span className="mini-badge">Evaluator</span>
                    <span className="mini-badge">Funder</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="quick-enter-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDirectSelect("member");
                  }}
                  title="Sign in as Platform Member"
                >
                  Enter
                </button>
              </div>

              {/* Standalone DAO Admin Card */}
              <div
                className={`role-option-card ${selectedProfile === "admin" ? "selected" : ""}`}
                onClick={() => setSelectedProfile("admin")}
              >
                <div className="role-option-radio">
                  <input
                    type="radio"
                    id="profile-admin"
                    name="selectedProfile"
                    value="admin"
                    checked={selectedProfile === "admin"}
                    onChange={() => setSelectedProfile("admin")}
                  />
                </div>
                <div className="role-option-body">
                  <div className="role-title-row">
                    <label htmlFor="profile-admin" className="role-name">
                      DAO Administrator
                    </label>
                    <span className="user-persona-tag">{DEMO_USERS.admin.name}</span>
                  </div>
                  <p className="role-desc">
                    Governance administration for system registries, audit verification, and protocol oversight.
                  </p>
                  <div className="role-meta">
                    <span>{DEMO_USERS.admin.org}</span> · <span className="mono">{DEMO_USERS.admin.address}</span>
                  </div>
                  <div className="capabilities-badges">
                    <span className="mini-badge admin-badge">DAO Admin</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="quick-enter-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDirectSelect("admin");
                  }}
                  title="Sign in as DAO Admin"
                >
                  Enter
                </button>
              </div>
            </fieldset>

            <div className="login-actions">
              <button className="primary full-width" type="submit">
                Sign In as {selectedProfile === "admin" ? "DAO Admin" : "Platform Member"} {redirectTarget ? `& Continue to ${redirectTarget}` : ""}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleLogin} className="standard-login-form">
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
              <button className="primary full-width" type="submit">
                Sign In {redirectTarget ? `& Continue to ${redirectTarget}` : ""}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
