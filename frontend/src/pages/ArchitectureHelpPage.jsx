import { OnChainOffChainLegend } from "../components/OnChainOffChainLegend.jsx";
import { useSession } from "../context/SessionContext.jsx";
import { isAdmin } from "../lib/roles.js";

/**
 * Public architecture help screen. Explains the hybrid split for a non-technical
 * evaluator and surfaces the same legend used on admin audit tabs.
 */
export default function ArchitectureHelpPage({ onNavigate }) {
  const { profile } = useSession();
  const showAuditTrail = isAdmin(profile?.role) && !profile?.suspended;

  return (
    <section className="page architecture-page">
      <div className="page-heading">
        <span className="eyebrow">Verification layer</span>
        <h1>What the blockchain records here</h1>
        <p>
          The working record lives in the platform database. When a posting or
          proposal is published, a hash of that version is written to a smart
          contract on Arbitrum Sepolia. Independent parties can check that the
          current record still matches the hash without putting the text itself
          on-chain.
        </p>
      </div>

      <OnChainOffChainLegend />

      <div className="detail-section">
        <h2>How to read a verification chip</h2>
        <p>
          Verified, pending, failed, and not anchored describe that hash check.
          They are not scores, roles, or workflow states such as Open or Draft.
        </p>
      </div>

      {showAuditTrail ? (
        <div className="architecture-actions">
          <button className="secondary" type="button" onClick={() => onNavigate("admin")}>
            Open the admin audit trail
          </button>
        </div>
      ) : null}
    </section>
  );
}
