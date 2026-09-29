import { useState } from "react";
import { StatusBadge } from "../components/StatusBadge.jsx";
import { WORKFLOW_STATUS } from "../config/workflowStatus.js";

const ROLES = [
  { key: "owner", name: "Problem owner", text: "Publishes a problem with a budget and a deadline." },
  { key: "researcher", name: "Researcher", text: "Proposes an approach and delivers the work in stages." },
  { key: "evaluator", name: "Evaluator", text: "Reviews proposals and confirms each milestone." },
  { key: "funder", name: "Funder", text: "Backs proposals. Funds release only as outcomes are met." },
];

const STEPS = [
  ["Publish.", "Describe the problem, set a budget and a deadline. It goes on-chain so everyone sees the same brief."],
  ["Propose.", "Researchers submit approaches. Funders back the ones they believe in until they are fully funded."],
  ["Match.", "Pick one fully funded proposal. It is a one-to-one match, and every other funder is refunded."],
  ["Deliver.", "Funds release milestone by milestone as evaluators confirm each outcome."],
];

const MILESTONES = [
  ["Scheduling model on historical data", true],
  ["Pilot across two sites", true],
  ["Rollout plan and final report", false],
];

function daysLeft(expiresAt) {
  const end = expiresAt?.toDate ? expiresAt.toDate() : expiresAt ? new Date(expiresAt) : null;
  if (!end || Number.isNaN(end.getTime())) return "";
  const days = Math.max(0, Math.floor((end.getTime() - Date.now()) / 864e5));
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

export default function HomePage({ postings = [], loading = false, isAuthenticated = false, onNavigate, onOpenWorkspaces }) {
  const [step, setStep] = useState(3);
  const featured = postings.slice(0, 8);
  const open = (item) => onNavigate(`${item.route ?? "posting"}/${item.id}`);

  return (
    <div className="desk">
      <section className="desk-hero">
        <span className="desk-rule" aria-hidden="true" />
        <h1>Fund problems<br />with clear outcomes.</h1>
        <p>Publish the problems that matter, match with one fully funded proposal, and release funds as outcomes land.</p>
        <div className="desk-actions">
          <button type="button" className="primary" onClick={() => onNavigate("create")}>Publish a brief</button>
          <button type="button" className="desk-link" onClick={() => onNavigate("discover")}>Explore opportunities</button>
        </div>

        <div className="desk-example" aria-hidden="true">
          <div className="desk-example-title">
            <span>Example brief · 001</span>
            <strong>Route optimisation for cold-chain delivery</strong>
          </div>
          <StatusBadge interactive={false} status={WORKFLOW_STATUS.DECISION_RECORDED} />
          <p>Variational circuits for route planning</p>
          <dl>
            <div><dt>Budget</dt><dd>60,000 USDT</dd></div>
            <div><dt>Timeline</dt><dd>50 days left</dd></div>
            <div><dt>Proposals</dt><dd>3</dd></div>
          </dl>
        </div>
      </section>

      <section className="desk-section desk-reveal" style={{ "--enter": "1.1s" }}>
        <h2>Four roles.<br />One clear path.</h2>
        <p className="desk-lede">Everyone sees the same brief, the same proposals and the same milestones.</p>
        <ol className="desk-roles">
          {ROLES.map((role) => (
            <li key={role.key}>
              <strong>{role.name}</strong>
              <span>{role.text}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="desk-how desk-reveal" style={{ "--enter": "1.3s" }} aria-label="From brief to delivery">
        <p className="desk-kicker">Workflow</p>
        <div className="desk-how-grid">
          <ol>
            {STEPS.map(([title, text], index) => (
              <li key={title}>
                <button type="button" className={index === step ? "is-on" : ""} aria-current={index === step ? "step" : undefined} onClick={() => setStep(index)}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {title}
                </button>
                {index === step && <p>{text}</p>}
              </li>
            ))}
          </ol>
          {step === 3 && (
            <div className="desk-milestones">
              <p className="desk-kicker">Current milestones</p>
              <ul>
                {MILESTONES.map(([label, done]) => (
                  <li key={label}>
                    <span>{label}</span>
                    <StatusBadge interactive={false} status={done ? WORKFLOW_STATUS.DECISION_RECORDED : WORKFLOW_STATUS.AWAITING_EVALUATOR_FEEDBACK} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <section className="desk-pair desk-reveal" style={{ "--enter": "1.5s" }}>
        <div>
          <h2>Discover</h2>
          <p>Every open problem and funding call, in one place.</p>
          <ul className="desk-lines">
            {featured.slice(0, 2).map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => open(item)}>{item.title}</button>
                <span>{item.owner}</span>
              </li>
            ))}
            {featured.length === 0 && (
              <li><span>{isAuthenticated ? (loading ? "Loading opportunities…" : "Nothing open yet.") : "Sign in to see what’s open."}</span></li>
            )}
          </ul>
          <button type="button" className="desk-link" onClick={() => onNavigate("discover")}>Browse ledger</button>
        </div>
        <div>
          <h2>Workspaces</h2>
          <p>Every brief, proposal and milestone you’re part of, by role.</p>
          <ul className="desk-lines">
            {ROLES.map((role) => (
              <li key={role.key}>
                <strong>{role.name}</strong>
                <span>{role.text}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="desk-link" onClick={onOpenWorkspaces}>Open workspaces</button>
        </div>
      </section>

      <section id="open" className="desk-section desk-reveal" style={{ "--enter": "1.7s" }}>
        <h2>Open now.</h2>
        <p className="desk-lede">Business problems and open funding calls.</p>
        {featured.length > 0 ? (
          <ul className="desk-open">
            {featured.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => open(item)}>
                  <strong>{item.title}</strong>
                  <span>{item.owner}</span>
                </button>
                <span>{item.amount}</span>
                <span>{daysLeft(item.expiresAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="desk-empty" role="status">
            {!isAuthenticated ? "Sign in to see opportunities posted by other organisations."
              : loading ? "Loading opportunities…" : "No open opportunities yet. Publish the first one."}
          </p>
        )}
      </section>

      <section className="desk-close desk-reveal" style={{ "--enter": "1.9s" }}>
        <h2>Have a problem<br />worth solving?</h2>
        <p className="desk-lede">Write a brief in four steps. Researchers can start proposing as soon as it’s on-chain.</p>
        <div className="desk-actions">
          <button type="button" className="primary" onClick={() => onNavigate("create")}>Publish a brief</button>
          <button type="button" className="desk-link" onClick={() => onNavigate("discover")}>Explore opportunities</button>
        </div>
      </section>
    </div>
  );
}
