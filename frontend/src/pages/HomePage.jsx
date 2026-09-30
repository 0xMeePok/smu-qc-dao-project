import { useEffect, useRef, useState } from "react";
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

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

function StepPanel({ index }) {
  if (index === 0) {
    return <>
      <p className="desk-panel-kicker">New brief · Business problem</p>
      <div className="desk-field"><small>Title</small><span>Route optimisation for cold-chain delivery under demand spikes</span></div>
      <div className="desk-field-row">
        <div className="desk-field"><small>Budget</small><span>USDT 60,000</span></div>
        <div className="desk-field"><small>Open for</small><span>90 days</span></div>
      </div>
      <div className="desk-chips"><span>Optimisation</span><span>Data &amp; analytics</span></div>
    </>;
  }
  if (index === 1) {
    const rows = [["Variational circuits for route planning", 100], ["Hybrid annealing for delivery windows", 100], ["Tensor network baseline", 62]];
    return <>
      <p className="desk-panel-kicker">Proposals · 3 received</p>
      {rows.map(([title, pct]) => (
        <div className="desk-field" key={title}>
          <div className="desk-progress-head"><span>{title}</span><span>{pct}%</span></div>
          <div className="desk-progress"><span style={{ width: `${pct}%` }} /></div>
        </div>
      ))}
    </>;
  }
  if (index === 2) {
    const choices = [
      ["Variational circuits for route planning", "Fully funded · Recommended by 2", true],
      ["Hybrid annealing for delivery windows", "Fully funded · No recommendation", false],
      ["Tensor network baseline", "62% funded · Not eligible", false],
    ];
    return <>
      <p className="desk-panel-kicker">Select one fully funded proposal</p>
      {choices.map(([title, note, selected]) => (
        <div className={`desk-choice${selected ? " is-on" : ""}`} key={title}>
          <strong>{title}</strong>
          <small>{note}</small>
        </div>
      ))}
    </>;
  }
  return <>
    <p className="desk-panel-kicker">Delivery · Milestones</p>
    <ul className="desk-milestones">
      {MILESTONES.map(([label, done]) => (
        <li key={label}>
          <span>{label}</span>
          <StatusBadge interactive={false} status={done ? WORKFLOW_STATUS.DECISION_RECORDED : WORKFLOW_STATUS.AWAITING_EVALUATOR_FEEDBACK} />
        </li>
      ))}
    </ul>
  </>;
}

function daysLeft(expiresAt) {
  const end = expiresAt?.toDate ? expiresAt.toDate() : expiresAt ? new Date(expiresAt) : null;
  if (!end || Number.isNaN(end.getTime())) return "";
  const days = Math.max(0, Math.floor((end.getTime() - Date.now()) / 864e5));
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

export default function HomePage({ postings = [], loading = false, isAuthenticated = false, onNavigate, onOpenWorkspaces }) {
  const stepsRef = useRef(null);
  const progressRef = useRef(null);
  const [step, setStep] = useState(0);
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && (window.innerWidth < 960 || window.innerHeight < 640 || prefersReducedMotion()));
  const featured = postings.slice(0, 8);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const isCompact = window.innerWidth < 960 || window.innerHeight < 640 || prefersReducedMotion();
      setCompact(isCompact);
      const steps = stepsRef.current;
      if (!steps || isCompact) return;
      const box = steps.getBoundingClientRect();
      const progress = Math.min(1, Math.max(0, -box.top / Math.max(1, box.height - window.innerHeight)));
      const next = Math.min(STEPS.length - 1, Math.floor(progress * STEPS.length));
      setStep((current) => (current === next ? current : next));
      if (progressRef.current) progressRef.current.style.transform = `scaleX(${progress})`;
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const scrollToStep = (index) => {
    const steps = stepsRef.current;
    if (!steps || compact) {
      setStep(index);
      return;
    }
    const total = steps.offsetHeight - window.innerHeight;
    window.scrollBy({ top: steps.getBoundingClientRect().top + ((index + 0.5) / STEPS.length) * total, behavior: "smooth" });
  };
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

      <section id="how" className={`desk-how${compact ? "" : " is-scrub"}`} aria-label="From brief to delivery" ref={stepsRef}>
        <div className="desk-how-stage">
          <div className="desk-how-grid">
            <div>
              <p className="desk-kicker">From brief to delivery</p>
              <ol>
                {STEPS.map(([title, text], index) => (
                  <li key={title}>
                    <button type="button" className={index === step ? "is-on" : ""} aria-current={!compact && index === step ? "step" : undefined} onClick={() => scrollToStep(index)}>
                      {title}
                    </button>
                    {(compact || index === step) && <p>{text}</p>}
                  </li>
                ))}
              </ol>
              {!compact && <div className="desk-step-progress" aria-hidden="true"><span ref={progressRef} /></div>}
            </div>
            <div className="desk-panel" aria-live="polite">
              {(compact ? [0, 1, 2, 3] : [step]).map((index) => (
                <div key={index}>
                  {compact && <p className="desk-panel-step">{STEPS[index][0]}</p>}
                  <StepPanel index={index} />
                </div>
              ))}
            </div>
          </div>
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
