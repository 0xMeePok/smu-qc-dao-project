import { useState } from "react";
import { saveBlobAs } from "../lib/attachments.js";
import { exportSelectedProposals } from "../lib/proposalExport.js";
import { EXPORT_NOTICE } from "../../../firebase/functions/proposalExportNotice.js";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function fileName(input, extension) {
  if (input.postingId) return `qcdao-selected-proposals-${input.postingId}.${extension}`;
  return `qcdao-selected-proposals-${input.startDate}_${input.endDate}.${extension}`;
}

/** QCDAO-107. One action writes the audit record and hands back both files. */
export function ProposalExportPanel() {
  const [mode, setMode] = useState("posting");
  const [postingId, setPostingId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const onSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setResult(null);
    const input = mode === "posting"
      ? { postingId: postingId.trim() }
      : { startDate, endDate };
    if (mode === "posting" && !ID.test(input.postingId)) {
      setError("Enter the posting id. It is the last part of the posting address.");
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
          <label><input type="radio" name="export-mode" value="posting" checked={mode === "posting"} onChange={() => setMode("posting")} /> One accepted posting</label>
          <label><input type="radio" name="export-mode" value="range" checked={mode === "range"} onChange={() => setMode("range")} /> Accepted postings in a date range</label>
        </div>
      </fieldset>
      {mode === "posting" ? (
        <div className="field">
          <label htmlFor="export-posting-id">Posting id</label>
          <input id="export-posting-id" value={postingId} autoComplete="off" spellCheck="false" onChange={(event) => setPostingId(event.target.value)} />
          <p className="field-hint">Use the id of a posting whose proposal has been accepted.</p>
        </div>
      ) : (
        <div className="proposal-export-dates">
          <div className="field">
            <label htmlFor="export-start">Start date</label>
            <input id="export-start" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="export-end">End date</label>
            <input id="export-end" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </div>
          <p className="field-hint">Dates are UTC calendar days. A posting is included when its accepted proposal falls in the range.</p>
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
