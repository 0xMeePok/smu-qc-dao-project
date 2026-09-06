import { messageForProposalError } from "../lib/proposalValidation.js";
import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { listProposals } from "../lib/proposals.js";
import { formatInstant } from "../lib/datetime.js";

export function ProposalList({ received = false, onNavigate }) {
  const { user } = useAuth();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    listProposals(received ? "postingOwnerId" : "researcherId", user.id)
      .then((records) => { if (!cancelled) setData(records); })
      .catch((err) => { if (!cancelled) setError(messageForProposalError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [received, user.id]);
  return <div className="card-table"><div className="table-header"><h3>{received ? "Proposals received" : "My proposals"}</h3>{!received && <button className="secondary small" onClick={() => onNavigate("discover")}>Browse opportunities</button>}</div>
    {loading ? <p className="table-empty" role="status">Loading proposals…</p> : error ? <p className="error-banner" role="alert">{error}</p> : !data.length ? <p className="table-empty">{received ? "No proposals received yet." : "No proposals yet. Choose an open opportunity to submit your approach."}</p> : data.map((item) => <div className="table-row" key={item.id}><div><strong>{item.title}</strong><small className="table-row-meta">{item.status} · {item.currency} {Number(item.amount).toLocaleString()} · {formatInstant(item.createdAt)}</small></div><button className="text-button" onClick={() => onNavigate(`proposal/${item.id}`)}>View proposal</button></div>)}
  </div>;
}
