import { useState } from "react";
import { DEMO_USERS, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES } from "../config/roles.js";
import { FEATURES } from "../config/features.js";
import { useAuth } from "../context/AuthContext.jsx";

export function Login({ redirectTarget, onNavigate }) {
  const { login } = useAuth();
  const [selectedRole, setSelectedRole] = useState(ROLES.OWNER);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleLogin = (e) => {
    e.preventDefault();
    login(selectedRole);
    const destination = redirectTarget || "home";
    if (onNavigate) {
      onNavigate(destination);
    } else {
      window.location.hash = `/${destination}`;
    }
  };

  const handleDirectSelect = (roleKey) => {
    login(roleKey);
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
              <legend className="sr-only">Select Platform Role</legend>
              {[ROLES.OWNER, ROLES.RESEARCHER, ROLES.EVALUATOR, ROLES.FUNDER, ROLES.ADMIN].map((roleKey) => {
                const demoUser = DEMO_USERS[roleKey];
                const isSelected = selectedRole === roleKey;
                return (
                  <div
                    key={roleKey}
                    className={`role-option-card ${isSelected ? "selected" : ""}`}
                    onClick={() => setSelectedRole(roleKey)}
                  >
                    <div className="role-option-radio">
                      <input
                        type="radio"
                        id={`role-${roleKey}`}
                        name="selectedRole"
                        value={roleKey}
                        checked={isSelected}
                        onChange={() => setSelectedRole(roleKey)}
                      />
                    </div>
                    <div className="role-option-body">
                      <div className="role-title-row">
                        <label htmlFor={`role-${roleKey}`} className="role-name">
                          {ROLE_LABELS[roleKey]}
                        </label>
                        <span className="user-persona-tag">{demoUser.name}</span>
                      </div>
                      <p className="role-desc">{ROLE_DESCRIPTIONS[roleKey]}</p>
                      <div className="role-meta">
                        <span>{demoUser.org}</span> · <span className="mono">{demoUser.address}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="quick-enter-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDirectSelect(roleKey);
                      }}
                      title={`Sign in as ${ROLE_LABELS[roleKey]}`}
                    >
                      Enter
                    </button>
                  </div>
                );
              })}
            </fieldset>

            <div className="login-actions">
              <button className="primary full-width" type="submit">
                Sign In as {ROLE_LABELS[selectedRole]} {redirectTarget ? `& Continue to ${redirectTarget}` : ""}
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
            <div className="form-field">
              <label htmlFor="authRole">Assigned Platform Role</label>
              <select
                id="authRole"
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
                className="role-select-dropdown"
              >
                <option value={ROLES.OWNER}>Problem Owner</option>
                <option value={ROLES.RESEARCHER}>Researcher</option>
                <option value={ROLES.EVALUATOR}>Evaluator</option>
                <option value={ROLES.FUNDER}>Funder</option>
                <option value={ROLES.ADMIN}>DAO Admin</option>
              </select>
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
