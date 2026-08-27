import { useSession } from "../context/SessionContext.jsx";

export function SuspensionBanner() {
  const { isSignedIn, isSuspended } = useSession();

  if (!isSignedIn || !isSuspended) return null;

  return (
    <div className="suspension-warning-banner" role="alert">
      <div className="suspension-banner-content">
        <span className="suspension-banner-icon">⚠️</span>
        <div>
          <strong>Account Suspended:</strong> Your wallet account has been placed under administrative suspension. Active governance capabilities and submissions are restricted. Please contact an SMU DAO administrator.
        </div>
      </div>
    </div>
  );
}
