import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPlatformStatus, probeBrowserRpc, probeFirebaseFromBrowser } from "../lib/platformStatus.js";
import { OVERALL_LABELS, HEALTH_LABELS, scrubError, summarizeStatus, worstStatus } from "../lib/platformStatusRules.js";
import { formatInstant } from "../lib/datetime.js";
import { shortenAddress } from "../lib/chain.js";

const PROVIDER_LABELS = {
  alchemy: "Alchemy",
  custom: "Custom RPC",
  "public-default": "Public Arbitrum endpoint (not configured)",
  invalid: "Invalid URL",
};

const ANCHORING_LABELS = [
  ["pending", "Pending"],
  ["confirmed", "Confirmed"],
  ["failed", "Failed"],
  ["waiting-wallet", "Waiting for wallet"],
];

const MAX_REASONS = 3;

function StatusPill({ status }) {
  const value = HEALTH_LABELS[status] ? status : "unknown";
  return <span className={`status-pill status-pill-${value}`}>{HEALTH_LABELS[value]}</span>;
}

function Facts({ rows }) {
  const visible = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!visible.length) return null;
  return (
    <dl className="status-facts">
      {visible.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Messages({ check }) {
  const issues = check?.issues ?? [];
  const notes = check?.notes ?? [];
  if (!issues.length && !notes.length) return null;
  return (
    <ul className="status-messages">
      {issues.map((text) => <li key={`issue:${text}`} className="status-issue">{text}</li>)}
      {notes.map((text) => <li key={`note:${text}`} className="status-note">{text}</li>)}
    </ul>
  );
}

function StatusCard({ title, status, headingId, children }) {
  return (
    <article className="status-card" aria-labelledby={headingId}>
      <div className="card-top">
        <h4 id={headingId}>{title}</h4>
        {status ? <StatusPill status={status} /> : <span className="status-pill status-pill-checking">Checking…</span>}
      </div>
      {children}
    </article>
  );
}

function ms(value) {
  return Number.isFinite(value) ? `${value} ms` : null;
}

function RpcCard({ id, title, description, check }) {
  return (
    <StatusCard title={title} status={check?.status} headingId={id}>
      <p className="status-card-lead">{description}</p>
      {check && (
        <>
          <Facts rows={[
            ["Provider", PROVIDER_LABELS[check.endpoint?.provider] ?? check.endpoint?.provider],
            ["Host", check.endpoint?.host ? <code>{check.endpoint.host}</code> : null],
            ["Chain ID", check.chainId],
            ["Latest block", check.blockNumber ? Number(check.blockNumber).toLocaleString("en-US") : null],
            ["Block age", Number.isFinite(check.blockAgeSeconds) ? `${check.blockAgeSeconds}s` : null],
            ["Latency", ms(check.latencyMs)],
          ]} />
          <Messages check={check} />
        </>
      )}
    </StatusCard>
  );
}

function ContractCard({ contract, index }) {
  const deployment = contract.deployment;
  const yesNo = (value) => (value === true ? "Yes" : value === false ? "No" : "Not checked");
  return (
    <StatusCard title={`${contract.name || "Contract"} (active)`} status={contract.status} headingId={`status-contract-${index}`}>
      <Facts rows={[
        ["Address", contract.address ? <code title={contract.address}>{shortenAddress(contract.address)}</code> : null],
        ["Deploy block", deployment?.blockNumber ? Number(deployment.blockNumber).toLocaleString("en-US") : null],
        ["Deployed", deployment?.deployedAt ? formatInstant(deployment.deployedAt) : null],
        ["Bytecode present", yesNo(contract.bytecodePresent)],
        ["ABI responds", yesNo(contract.abiResponds)],
      ]} />
      {contract.address && (
        <p className="status-card-links">
          <a href={deployment?.verificationUrl || contract.explorerUrl} target="_blank" rel="noopener noreferrer">
            View on Arbiscan<span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </p>
      )}
      <Messages check={contract} />
    </StatusCard>
  );
}

function AnchoringCard({ anchoring, onOpenAuditTrail }) {
  const counts = anchoring?.counts;
  return (
    <StatusCard title="Anchoring queue" status={anchoring?.status} headingId="status-anchoring">
      <p className="status-card-lead">
        Proposal verification jobs updated in the last {anchoring?.windowDays ?? 7} days.
      </p>
      {counts && (
        <dl className="status-counts">
          {ANCHORING_LABELS.map(([key, label]) => (
            <div key={key} className={key === "failed" && counts[key] > 0 ? "status-count-alert" : undefined}>
              <dt>{label}</dt>
              <dd>{counts[key] ?? 0}</dd>
            </div>
          ))}
        </dl>
      )}
      <Messages check={anchoring} />
      {counts?.failed > 0 && onOpenAuditTrail && (
        <button type="button" className="secondary small" onClick={onOpenAuditTrail}>Open proposal audit trail</button>
      )}
    </StatusCard>
  );
}

function AlchemyCard({ alchemy }) {
  return (
    <StatusCard title="Alchemy service" status={alchemy?.status} headingId="status-alchemy">
      <p className="status-card-lead">Alchemy&apos;s own reported health.</p>
      {alchemy && (
        <>
          <Facts rows={[
            ["Overall", alchemy.overall?.description || null],
            ...(alchemy.components ?? []).map((component) => [
              component.name,
              component.rawStatus ? component.rawStatus.replace(/_/g, " ") : "Not reported",
            ]),
          ]} />
          <Messages check={alchemy} />
          <p className="status-card-links">
            <a href={alchemy.pageUrl || "https://status.alchemy.com"} target="_blank" rel="noopener noreferrer">
              status.alchemy.com<span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </p>
        </>
      )}
    </StatusCard>
  );
}

function FirebaseCard({ server, serverError, client, loading }) {
  const firestore = server?.firebase?.firestore;
  const functionsStatus = serverError ? "down" : server?.firebase?.functions?.status;
  const rows = [
    ["Cloud Functions", functionsStatus ? HEALTH_LABELS[functionsStatus] : null],
    ["Firestore", firestore ? `${HEALTH_LABELS[firestore.status]}${Number.isFinite(firestore.latencyMs) ? ` · ${firestore.latencyMs} ms` : ""}` : null],
    ["Auth", client ? `${HEALTH_LABELS[client.status]}${Number.isFinite(client.latencyMs) ? ` · ${client.latencyMs} ms` : ""}` : null],
  ];
  const complete = Boolean(client) && Boolean(server || serverError);
  const combined = complete || !loading
    ? worstStatus([functionsStatus, firestore?.status, client?.status].filter(Boolean))
    : null;
  const config = client?.config;
  return (
    <StatusCard title="Firebase" status={combined} headingId="status-firebase">
      <Facts rows={rows} />
      {config && (
        <ul className="status-chips" aria-label="Firebase configuration">
          <li className={config.appCheckConfigured ? "on" : "off"}>App Check {config.appCheckConfigured ? "configured" : "not configured"}</li>
          <li className={config.storageConfigured ? "on" : "off"}>Storage {config.storageConfigured ? "configured" : "not configured"}</li>
          {config.usingEmulators && <li className="emulator">Emulator mode</li>}
        </ul>
      )}
      {serverError && <Messages check={{ issues: [`Cloud Functions: ${serverError}`] }} />}
      <Messages check={firestore} />
      <Messages check={client} />
    </StatusCard>
  );
}

/**
 * Admin pre-demo health view. Loads once when the tab opens and again on
 * "Re-check"; there is deliberately no background polling.
 */
export function PlatformStatusPanel({ onOpenAuditTrail }) {
  const [server, setServer] = useState(null);
  const [serverError, setServerError] = useState("");
  const [browserRpc, setBrowserRpc] = useState(null);
  const [firebaseClient, setFirebaseClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState(null);
  const generation = useRef(0);

  const runChecks = useCallback(async () => {
    const run = ++generation.current;
    const current = () => run === generation.current;
    setLoading(true);
    setServer(null);
    setServerError("");
    setBrowserRpc(null);
    setFirebaseClient(null);
    const serverCheck = fetchPlatformStatus()
      .then((data) => { if (current()) setServer(data); })
      .catch((error) => { if (current()) setServerError(scrubError(error) || "The status check could not be completed."); });
    const rpcCheck = probeBrowserRpc()
      .then((result) => { if (current()) setBrowserRpc(result); })
      .catch((error) => { if (current()) setBrowserRpc({ status: "down", issues: [scrubError(error)] }); });
    const firebaseCheck = probeFirebaseFromBrowser()
      .then((result) => { if (current()) setFirebaseClient(result); })
      .catch((error) => { if (current()) setFirebaseClient({ status: "down", issues: [scrubError(error)] }); });
    await Promise.allSettled([serverCheck, rpcCheck, firebaseCheck]);
    if (current()) {
      setLoading(false);
      setCheckedAt(new Date().toISOString());
    }
  }, []);

  useEffect(() => {
    void runChecks();
    return () => { ++generation.current; };
  }, [runChecks]);

  const summary = loading ? null : summarizeStatus({ server, serverError, browserRpc, firebaseClient });
  const overall = summary?.overall ?? "checking";
  const bannerClass = overall === "ready" ? "status-banner-ready"
    : overall === "not-ready" ? "status-banner-not-ready"
      : overall === "degraded" ? "status-banner-degraded" : "status-banner-checking";

  return (
    <section className="platform-status" aria-labelledby="platform-status-heading">
      <div className="page-heading">
        <span className="eyebrow">Pre-demo check</span>
        <h2 id="platform-status-heading">Platform status</h2>
        <p>
          A live snapshot of the blockchain connection, the active AuditRegistry, the anchoring pipeline and Firebase.
          It runs when this tab opens and when you re-check; nothing polls in the background.
        </p>
      </div>

      <div className={`status-banner ${bannerClass}`} role="status" aria-live="polite" aria-busy={loading}>
        <div>
          <strong>{OVERALL_LABELS[overall]}</strong>
          {summary?.reasons?.length ? (
            <ul>
              {summary.reasons.slice(0, MAX_REASONS).map((text, index) => <li key={`${index}:${text}`}>{text}</li>)}
              {summary.reasons.length > MAX_REASONS && <li>{summary.reasons.length - MAX_REASONS} more below.</li>}
            </ul>
          ) : summary ? <p>Every check passed.</p> : <p>Running checks…</p>}
        </div>
        <div className="status-banner-actions">
          {checkedAt && <span className="table-row-meta">Last checked {formatInstant(checkedAt)}</span>}
          <button type="button" className="secondary small" onClick={() => runChecks()} disabled={loading}>
            {loading ? "Checking…" : "Re-check"}
          </button>
        </div>
      </div>

      <h3 className="status-section-heading">Blockchain connection</h3>
      <div className="status-grid">
        <RpcCard
          id="status-server-rpc"
          title="Server RPC"
          description="Used by Cloud Functions to verify anchoring transactions."
          check={server?.serverRpc ?? (serverError ? { status: "unknown", issues: ["Not checked: the status function did not respond."] } : null)}
        />
        <RpcCard
          id="status-browser-rpc"
          title="Browser RPC"
          description="Used by this app in your browser for on-chain reads. Checked from this machine."
          check={browserRpc}
        />
        <AlchemyCard alchemy={server?.alchemy ?? (serverError ? { status: "unknown", issues: ["Not checked: the status function did not respond."], components: [] } : null)} />
      </div>

      <h3 className="status-section-heading">Contracts and anchoring</h3>
      <div className="status-grid">
        {server?.contracts?.length
          ? server.contracts.map((contract, index) => <ContractCard key={contract.address || index} contract={contract} index={index} />)
          : (
            <StatusCard title="AuditRegistry (active)" status={serverError ? "unknown" : null} headingId="status-contract-0">
              {serverError && <Messages check={{ issues: ["Not checked: the status function did not respond."] }} />}
            </StatusCard>
          )}
        <AnchoringCard
          anchoring={server?.anchoring ?? (serverError ? { status: "unknown", issues: ["Not checked: the status function did not respond."] } : null)}
          onOpenAuditTrail={onOpenAuditTrail}
        />
      </div>

      <h3 className="status-section-heading">Firebase</h3>
      <div className="status-grid">
        <FirebaseCard server={server} serverError={serverError} client={firebaseClient} loading={loading} />
      </div>
    </section>
  );
}
