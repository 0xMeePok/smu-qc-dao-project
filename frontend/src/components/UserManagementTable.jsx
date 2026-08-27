import { shortenAddress } from "../lib/chain.js";
import { roleLabel } from "../lib/roles.js";

export function UserManagementTable({
  users,
  loading,
  isFetching,
  error,
  search,
  onSearchChange,
  roleFilter,
  onRoleFilterChange,
  orgFilter,
  onOrgFilterChange,
  page,
  totalPages,
  onPageChange,
  totalUsers,
  onChangeRole,
  onToggleSuspend,
  onRefresh,
  currentAdminAddress,
}) {
  const isInitialLoading = loading && users.length === 0;

  return (
    <div className="admin-user-management">
      <div className="table-controls-bar">
        <div className="search-filter-group">
          <div className="search-box">
            <svg
              className="search-icon"
              viewBox="0 0 20 20"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="M12.5 12.5L16.5 16.5" />
            </svg>
            <input
              type="text"
              placeholder="Search by name, address, or org..."
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              aria-label="Search platform users"
            />
            {search && (
              <button
                className="clear-search-btn"
                type="button"
                onClick={() => onSearchChange("")}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          <div className="filter-dropdown">
            <label htmlFor="role-filter-select" className="sr-only">
              Filter by Role
            </label>
            <select
              id="role-filter-select"
              value={roleFilter === null ? "" : String(roleFilter)}
              onChange={(e) => {
                const val = e.target.value;
                onRoleFilterChange(val === "" ? null : parseInt(val, 10));
              }}
            >
              <option value="">All Roles</option>
              <option value="0">Standard Users (0)</option>
              <option value="1">Administrators (1)</option>
            </select>
          </div>

          <div className="filter-input">
            <input
              type="text"
              placeholder="Filter by organisation..."
              value={orgFilter}
              onChange={(e) => onOrgFilterChange(e.target.value)}
              aria-label="Filter by organisation"
            />
          </div>
        </div>

        <div className="controls-right">
          <button className="secondary small refresh-btn" type="button" onClick={onRefresh} title="Refresh User List">
            ↻ Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner" style={{ margin: "1rem 0" }}>
          <strong>Error loading users:</strong> {error}
        </div>
      )}

      <div className="admin-table-container">
        <div className={`table-loading-bar ${isFetching ? "active" : ""}`} />
        <table className="admin-users-table">
          <thead>
            <tr>
              <th>User / Address</th>
              <th>Organisation</th>
              <th>Role</th>
              <th>Status</th>
              <th className="actions-col">Governance Actions</th>
            </tr>
          </thead>
          <tbody className={isFetching ? "admin-table-busy" : ""}>
            {isInitialLoading ? (
              <tr>
                <td colSpan="5" className="table-empty-cell">
                  <div className="loading-spinner-row">Loading platform user directory...</div>
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan="5" className="table-empty-cell">
                  No platform users match the current search / filter criteria.
                </td>
              </tr>
            ) : (
              users.map((u) => {
                const isSelf = currentAdminAddress && u.address.toLowerCase() === currentAdminAddress.toLowerCase();
                const isSuspended = Boolean(u.suspended);

                return (
                  <tr key={u.address} className={isSuspended ? "row-suspended" : ""}>
                    <td className="user-identity-cell">
                      <div className="user-name-row">
                        <strong>{u.fullName || "Unnamed User"}</strong>
                        {isSelf && <span className="self-tag">You</span>}
                      </div>
                      <code className="wallet-code" title={u.address}>
                        {shortenAddress(u.address)}
                      </code>
                    </td>
                    <td>
                      <span className="org-text">{u.organisation || "—"}</span>
                    </td>
                    <td>
                      <span className={`role-chip ${u.role === 1 ? "role-chip-admin" : "role-chip-user"}`}>
                        {roleLabel(u.role)}
                      </span>
                    </td>
                    <td>
                      <span className={`status-badge ${isSuspended ? "status-badge-suspended" : "status-badge-active"}`}>
                        <span className="status-indicator-dot" />
                        {isSuspended ? "Suspended" : "Active"}
                      </span>
                    </td>
                    <td className="actions-col">
                      {isSelf ? (
                        <span className="self-action-placeholder" title="Current signed-in administrator (self-action restricted)">
                          —
                        </span>
                      ) : (
                        <div className="action-buttons-group">
                          <button
                            className="secondary small table-action-btn"
                            type="button"
                            onClick={() => onChangeRole(u)}
                            title="Change role assignment"
                          >
                            Change Role
                          </button>
                          <button
                            className={`small table-action-btn ${isSuspended ? "reinstate-btn" : "suspend-btn"}`}
                            type="button"
                            onClick={() => onToggleSuspend(u)}
                            title={isSuspended ? "Reinstate account access" : "Suspend account access"}
                          >
                            {isSuspended ? "Reinstate" : "Suspend"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="table-pagination">
          <div className="pagination-info">
            Showing {(page - 1) * 20 + 1}–{Math.min(page * 20, totalUsers)} of {totalUsers} users
          </div>
          <div className="pagination-controls">
            <button
              className="secondary small"
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => onPageChange(page - 1)}
            >
              Previous
            </button>
            <span className="page-indicator">
              Page {page} of {totalPages}
            </span>
            <button
              className="secondary small"
              type="button"
              disabled={page >= totalPages || loading}
              onClick={() => onPageChange(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
