import { useEffect, useState } from "react";
import { findPosting } from "../lib/postings.js";
import { messageForFirebaseError } from "../lib/errors.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import CreatePostingPage from "./CreatePostingPage.jsx";
import CreateFundingOpportunityPage from "./CreateFundingOpportunityPage.jsx";

export default function OpportunityEditPage({ postingId, onNavigate }) {
  const [kind, setKind] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    findPosting(postingId)
      .then((posting) => {
        if (cancelled) return;
        if (!posting) {
          setError("This posting could not be found or you do not have access.");
          return;
        }
        setKind(posting.opportunityType === OPEN_FUNDING_TYPE ? "funding" : "posting");
      })
      .catch((err) => { if (!cancelled) setError(messageForFirebaseError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [postingId]);

  if (loading) return <section className="page empty" role="status">Loading posting…</section>;
  if (error || !kind) {
    return (
      <section className="page empty">
        <h1>Posting unavailable</h1>
        <p role="alert">{error || "This posting could not be found or you do not have access."}</p>
        <button className="secondary" type="button" onClick={() => onNavigate("my-problems")}>My problems</button>
      </section>
    );
  }

  return kind === "funding"
    ? <CreateFundingOpportunityPage editOpportunityId={postingId} onNavigate={onNavigate} />
    : <CreatePostingPage editPostingId={postingId} onNavigate={onNavigate} />;
}
