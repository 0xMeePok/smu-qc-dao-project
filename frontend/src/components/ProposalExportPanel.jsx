import { useEffect, useState } from "react";
import { saveBlobAs } from "../lib/attachments.js";
import { exportSelectedProposals, listExportableProposals } from "../lib/proposalExport.js";
import { EXPORT_NOTICE, latestCurrentDate } from "../../../firebase/functions/proposalExportNotice.js";
import { workflowStatusLabel } from "../config/workflowStatus.js";

function optionLabel(proposal) {
  const status = proposal.workflowLabel || workflowStatusLabel(proposal.workflowStatus) || proposal.status;
  const posting = proposal.problemTitle ? ` · ${proposal.problemTitle}` : "";
  return `${proposal.title} — ${status}${posting}`;
}

function fileName(input, extension) {
  if (input.proposalId) return `qcdao-proposals-${input.proposalId}.${extension}`;
  return `qcdao-proposals-${input.startDate}_${input.endDate}.${extension}`;
}

/** QCDAO-107. One action writes the audit record and hands back both files. */
export function ProposalExportPanel() {
  const [mode, setMode] = useState("proposal");
  const [acceptance, setAcceptance] = useState("accepted");
  const [proposals, setProposals] = useState([]);
  const [proposalId, setProposalId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const latest = latestCurrentDate();
  const listed = acceptance === "accepted" ? proposals.filter((proposal) => proposal.accepted) : proposals;

  useEffect(() => {
    let active = true;
    listExportableProposals()
      .then((data) => { if (active) setProposals(data.proposals || []); })
      .catch((listError) => { if (active) setError(listError?.message || "The proposal list could not be loaded."); })
      .finally(() => { if (active) setLoadingList(false); });
    return () => { active = false; };
  }, []);

  const onSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setResult(null);
    const input = mode === "proposal"
      ? { proposalId, acceptance }
      : { startDate, endDate, acceptance };
    if (mode === "proposal" && !proposalId) {
      setError("Choose a proposal.");
      return;
    }
    if (mode === "range" && (!startDate || !endDate)) {
      setError("Choose both a start date and an end date.");
      return;
    }
    if (mode === "range" && startDate > endDate) {
      setError("The start date is after the end date.");
      return;
    }
    if (mode === "range" && endDate > latest) {
      setError(`The end date cannot be after ${latest}, the latest current date (UTC+14).`);
      return;
    }
    setBusy(true);
    try {
      const exported = await exportSelectedProposals(input);
      const json = `${JSON.stringify(exported.document, null, 2)}\n`;
      saveBlobAs(new Blob([json], { type: "application/json" }), fileName(input, "json"));
      saveBlobAs(new Blob([exported.csv], { type: "text/csv;charset=utf-8" }), fileName(input, "csv"));
      setResult(exported);
    } catch (exportError) {
      setError(exportError?.message || "The export could not be created. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="proposal-export" onSubmit={onSubmit}>
      <div className="notice">
        <strong>Grading happens outside QC DAO</strong>
        <p>{EXPORT_NOTICE}</p>
      </div>
      <fieldset className="field-group">
        <legend>What to export</legend>
        <div className="proposal-export-modes">
          <label><input type="radio" name="export-mode" value="proposal" checked={mode === "proposal"} onChange={() => setMode("proposal")} /> One proposal</label>
          <label><input type="radio" name="export-mode" value="range" checked={mode === "range"} onChange={() => setMode("range")} /> Proposals in a date range</label>
        </div>
      </fieldset>
      <fieldset className="field-group">
        <legend>Which proposals</legend>
        <div className="proposal-export-modes">
          <label><input type="radio" name="export-acceptance" value="accepted" checked={acceptance === "accepted"} onChange={() => { setAcceptance("accepted"); setProposalId(""); }} /> Accepted only</label>
          <label><input type="radio" name="export-acceptance" value="all" checked={acceptance === "all"} onChange={() => setAcceptance("all")} /> Accepted and not accepted</label>
        </div>
      </fieldset>
      {mode === "proposal" ? (
        <div className="field">
          <label htmlFor="export-proposal">Proposal</label>
          <select id="export-proposal" value={proposalId} disabled={loadingList} onChange={(event) => setProposalId(event.target.value)}>
            <option value="">{loadingList ? "Loading proposals…" : "Choose a proposal"}</option>
            {listed.map((proposal) => (
              <option key={proposal.id} value={proposal.id}>{optionLabel(proposal)}</option>
            ))}
          </select>
          <p className="field-hint">{acceptance === "accepted"
            ? "Only accepted proposals are listed. Drafts are left out."
            : "Accepted and not-yet-accepted proposals are listed. Drafts are left out."}</p>
        </div>
      ) : (
        <div className="proposal-export-dates">
          <div className="field">
            <label htmlFor="export-start">Start date</label>
            <input id="export-start" type="date" max={latest} value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="export-end">End date</label>
            <input id="export-end" type="date" max={latest} value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </div>
          <p className="field-hint">Dates are UTC calendar days. The end date cannot be later than today in UTC+14, the latest timezone. {acceptance === "accepted"
            ? "Only accepted proposals created in the range are included."
            : "Accepted and not-yet-accepted proposals created in the range are included."}</p>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="proposal-export-actions">
        <button className="primary" type="submit" disabled={busy}>{busy ? "Preparing the files…" : "Download JSON and CSV"}</button>
      </div>
      {result && (
        <p className="field-hint" role="status">
          Downloaded {result.postingCount} {result.postingCount === 1 ? "posting" : "postings"}, {result.proposalCount} {result.proposalCount === 1 ? "proposal" : "proposals"} and {result.commentCount} {result.commentCount === 1 ? "comment" : "comments"}. The export was recorded in the audit trail.
        </p>
      )}
    </form>
  );
}
