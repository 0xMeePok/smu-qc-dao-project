import { useState, useEffect, useCallback } from "react";
import { useSession } from "../context/SessionContext.jsx";
import { isAdmin } from "../lib/roles.js";
import { shortenAddress } from "../lib/chain.js";
import { fetchAdminUsers } from "../lib/admin.js";
import { UserManagementTable } from "../components/UserManagementTable.jsx";
import { RoleChangeModal } from "../components/RoleChangeModal.jsx";
import { SuspendUserModal } from "../components/SuspendUserModal.jsx";
import { AdminAudit } from "../components/RoleViews.jsx";

export default function AdminPage() {
  const { isSignedIn, isChecking, profile, address } = useSession();

  const [activeTab, setActiveTab] = useState("users"); // "users" | "audits"
  const [users, setUsers] = useState([]);
  const [totalUsers, setTotalUsers] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState(null);
  const [orgFilter, setOrgFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState(null);
  const [successBanner, setSuccessBanner] = useState(null);

  // Modals state
  const [roleChangeTarget, setRoleChangeTarget] = useState(null);
  const [suspendTarget, setSuspendTarget] = useState(null);

  const loadUsers = useCallback(async () => {
    if (!isSignedIn || !isAdmin(profile?.role) || profile?.suspended) return;
    setIsFetching(true);
    setError(null);
    try {
      const data = await fetchAdminUsers({
        page,
        pageSize,
        search,
        roleFilter,
        orgFilter,
      });
      setUsers(data.users || []);
      setTotalUsers(data.total || 0);
      setTotalPages(data.totalPages || 1);
    } catch (err) {
      setError(err?.message || "Failed to load platform user directory.");
    } finally {
      setLoading(false);
      setIsFetching(false);
    }
  }, [isSignedIn, profile?.role, profile?.suspended, page, pageSize, search, roleFilter, orgFilter]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleRoleChangeSuccess = ({ address: updatedAddress, newRole }) => {
    setSuccessBanner(
      `Role successfully changed to ${newRole === 1 ? "Administrator (1)" : "User (0)"} for ${shortenAddress(
        updatedAddress,
      )}. Audit entry logged.`,
    );
    loadUsers();
    setTimeout(() => setSuccessBanner(null), 6000);
  };

  const handleSuspendSuccess = ({ address: updatedAddress, suspended }) => {
    setSuccessBanner(
      `Account ${shortenAddress(updatedAddress)} was successfully ${
        suspended ? "suspended" : "reinstated"
      }. Audit entry logged.`,
    );
    loadUsers();
    setTimeout(() => setSuccessBanner(null), 6000);
  };

  if (isChecking) {
    return (
      <section className="page empty">
        <p className="lead">Checking administrator credentials…</p>
      </section>
    );
  }

  if (!isSignedIn || !isAdmin(profile?.role) || profile?.suspended) {
    return (
      <section className="page empty">
        <h1>Access Restricted</h1>
        <p className="lead">
          {profile?.suspended
            ? "Your administrator account has been placed under administrative suspension. Governance capabilities are restricted."
            : "You must be signed in with a verified DAO Administrator wallet to access this section."}
        </p>
      </section>
    );
  }

  return (
    <section className="page dashboard-page admin-governance-page">
      <div className="page-heading">
        <div className="eyebrow-row">
          <span className="role-chip role-chip-admin">DAO Administrator</span>
          <span>SMU Pilot Governance Node</span>
        </div>
        <h1>Platform Administration & User Management</h1>
        <p>
          Oversee platform user accounts, grant administrator roles, manage pilot stakeholder simulated accounts, and inspect the tamper-proof governance audit trail.
        </p>
      </div>

      {successBanner && (
        <div className="success-banner" role="status" style={{ marginBottom: "1.5rem" }}>
          <strong>Action Recorded:</strong> {successBanner}
        </div>
      )}

      <div className="admin-tabs-nav" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "users"}
          className={`admin-tab-btn ${activeTab === "users" ? "active" : ""}`}
          onClick={() => setActiveTab("users")}
        >
          User Directory & Roles ({totalUsers})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "audits"}
          className={`admin-tab-btn ${activeTab === "audits" ? "active" : ""}`}
          onClick={() => setActiveTab("audits")}
        >
          Governance Audit Trail
        </button>
      </div>

      <div className="admin-tab-content">
        {activeTab === "users" ? (
          <UserManagementTable
            users={users}
            loading={loading}
            isFetching={isFetching}
            error={error}
            search={search}
            onSearchChange={setSearch}
            roleFilter={roleFilter}
            onRoleFilterChange={(val) => {
              setRoleFilter(val);
              setPage(1);
            }}
            orgFilter={orgFilter}
            onOrgFilterChange={setOrgFilter}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            totalUsers={totalUsers}
            onChangeRole={(u) => setRoleChangeTarget(u)}
            onToggleSuspend={(u) => setSuspendTarget(u)}
            onRefresh={loadUsers}
            currentAdminAddress={address}
          />
        ) : (
          <AdminAudit />
        )}
      </div>

      {roleChangeTarget && (
        <RoleChangeModal
          targetUser={roleChangeTarget}
          onClose={() => setRoleChangeTarget(null)}
          onSuccess={handleRoleChangeSuccess}
        />
      )}

      {suspendTarget && (
        <SuspendUserModal
          targetUser={suspendTarget}
          onClose={() => setSuspendTarget(null)}
          onSuccess={handleSuspendSuccess}
        />
      )}
    </section>
  );
}
