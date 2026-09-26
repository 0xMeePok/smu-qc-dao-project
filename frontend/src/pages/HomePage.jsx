import { useEffect, useRef, useState } from "react";

/**
 * Landing page - "QC DAO Home - Liquid Glass".
 *
 * Dark and light bands alternate; the floating header reads the band beneath it
 * (data-tone) and switches between light and dark glass. The walkthrough panels
 * and hero cards are illustrations of the product, labelled as examples - the
 * only live data here is the published postings passed in.
 */

const ICONS = {
  owner: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8M16 13H8M16 17H8" /></>,
  researcher: <><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" /><path d="M8.5 2h7M7 16h10" /></>,
  evaluator: <><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></>,
  funder: <><circle cx="12" cy="12" r="10" /><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 18V6" /></>,
};

function Icon({ name, size = 24 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

function Chevron({ left = false }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={left ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

function Blobs({ set }) {
  return (
    <div className="lg-blobs" aria-hidden="true">
      {set.map((className) => <span key={className} className={`lg-blob ${className}`} />)}
    </div>
  );
}

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

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

function daysLeft(expiresAt) {
  const end = expiresAt?.toDate ? expiresAt.toDate() : expiresAt ? new Date(expiresAt) : null;
  if (!end || Number.isNaN(end.getTime())) return "";
  const days = Math.max(0, Math.floor((end.getTime() - Date.now()) / 864e5));
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

// One illustrative panel per walkthrough step. Example content, not live data.
function StepPanel({ index }) {
  if (index === 0) {
    return <>
      <div className="lg-panel-kicker">New brief · Business problem</div>
      <div className="lg-panel-stack">
        <div className="lg-field"><small>Title</small><span>Route optimisation for cold-chain delivery under demand spikes</span></div>
        <div className="lg-field-row">
          <div className="lg-field"><small>Budget</small><span>USDT 60,000</span></div>
          <div className="lg-field"><small>Open for</small><span>90 days</span></div>
        </div>
        <div className="lg-chips"><span>Optimisation</span><span>Data &amp; analytics</span></div>
      </div>
      <div className="lg-panel-action"><span>Submit brief</span></div>
    </>;
  }
  if (index === 1) {
    const rows = [["Variational circuits for route planning", 100], ["Hybrid annealing for delivery windows", 100], ["Tensor network baseline", 62]];
    return <>
      <div className="lg-panel-kicker">Proposals · 3 received</div>
      <div className="lg-panel-stack">
        {rows.map(([title, pct]) => (
          <div className="lg-field" key={title}>
            <div className="lg-progress-head"><span>{title}</span><span>{pct}% funded</span></div>
            <div className="lg-progress"><span style={{ width: `${pct}%` }} className={pct === 100 ? "is-full" : ""} /></div>
          </div>
        ))}
      </div>
    </>;
  }
  if (index === 2) {
    return <>
      <div className="lg-panel-kicker">Select one fully funded proposal</div>
      <div className="lg-panel-stack">
        <div className="lg-choice is-selected"><span className="lg-radio is-on" /><span><strong>Variational circuits for route planning</strong><small>Fully funded · Recommended by 2</small></span></div>
        <div className="lg-choice"><span className="lg-radio" /><span><strong>Hybrid annealing for delivery windows</strong><small>Fully funded · No recommendation</small></span></div>
        <div className="lg-choice is-disabled"><span className="lg-radio" /><span><strong>Tensor network baseline</strong><small>62% funded · Not eligible</small></span></div>
      </div>
      <div className="lg-panel-action"><span>Confirm match</span></div>
    </>;
  }
  return <>
    <div className="lg-panel-kicker">Delivery · Milestones</div>
    <div className="lg-panel-figure">2 of 3</div>
    <div className="lg-panel-sub">milestones released</div>
    <div className="lg-panel-stack">
      {[["Scheduling model on historical data", true], ["Pilot across two sites", true], ["Rollout plan and final report", false]].map(([label, done]) => (
        <div className="lg-milestone" key={label}>
          <span className={`lg-check${done ? " is-done" : ""}`}>{done && <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}</span>
          <span>{label}</span>
          <small>{done ? "Released" : "In review"}</small>
        </div>
      ))}
    </div>
  </>;
}

export default function HomePage({ postings = [], loading = false, isAuthenticated = false, onNavigate, onOpenWorkspaces }) {
  const rootRef = useRef(null);
  const stepsRef = useRef(null);
  const progressRef = useRef(null);
  const heroCardsRef = useRef(null);
  const railRef = useRef(null);
  const [step, setStep] = useState(0);
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && (window.innerWidth < 960 || window.innerHeight < 640));

  // Header tone, walkthrough progress and the hero parallax all follow scroll.
  useEffect(() => {
    const reduced = prefersReducedMotion();
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      frame = 0;
      const page = rootRef.current;
      if (!page) return;
      let tone = "light";
      for (const band of page.querySelectorAll("[data-tone]")) {
        const box = band.getBoundingClientRect();
        if (box.top <= 40 && box.bottom > 40) { tone = band.getAttribute("data-tone"); break; }
      }
      root.dataset.navTone = tone;
      const isCompact = window.innerWidth < 960 || window.innerHeight < 640;
      setCompact(isCompact);
      const steps = stepsRef.current;
      if (steps && !isCompact) {
        const box = steps.getBoundingClientRect();
        const progress = Math.min(1, Math.max(0, -box.top / Math.max(1, box.height - window.innerHeight)));
        setStep(Math.min(3, Math.floor(progress * 4)));
        if (progressRef.current) progressRef.current.style.transform = `scaleX(${progress})`;
      }
      const cards = heroCardsRef.current;
      if (cards && !reduced) {
        const y = Math.max(0, window.scrollY);
        cards.style.transform = `translate3d(0, ${(y * -0.14).toFixed(1)}px, 0) scale(${(1 - Math.min(y / 4000, 0.05)).toFixed(4)})`;
      }
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      delete root.dataset.navTone;
    };
  }, []);

  // Sections below the fold rise in once as they arrive.
  useEffect(() => {
    if (prefersReducedMotion() || !("IntersectionObserver" in window) || !rootRef.current) return undefined;
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add("is-revealed"); observer.unobserve(entry.target); }
    }), { threshold: 0.12 });
    rootRef.current.querySelectorAll("[data-reveal]").forEach((element) => {
      if (element.getBoundingClientRect().top < window.innerHeight) return;
      element.classList.add("is-hidden");
      observer.observe(element);
    });
    return () => observer.disconnect();
  }, []);

  const scrollToStep = (index) => {
    const steps = stepsRef.current;
    if (!steps) return;
    const total = steps.offsetHeight - window.innerHeight;
    window.scrollBy({ top: steps.getBoundingClientRect().top + ((index + 0.5) / 4) * total, behavior: "smooth" });
  };
  const scrollRail = (direction) => railRef.current?.scrollBy({ left: direction * 358, behavior: "smooth" });
  const open = (item) => onNavigate(`${item.route ?? "posting"}/${item.id}`);
  const featured = postings.slice(0, 8);

  return (
    <div className="lg-home" ref={rootRef}>
      <section className="lg-hero" data-tone="dark">
        <Blobs set={["h1", "h2", "h3", "h4"]} />
        <div className="lg-hero-inner">
          <h1>Fund problems<br />with clear outcomes.</h1>
          <p>Publish the problems that matter, match with one fully funded proposal, and release funds as outcomes land.</p>
          <div className="lg-hero-actions">
            <button type="button" className="lg-btn-light" onClick={() => onNavigate("discover")}>Explore opportunities</button>
            <button type="button" className="lg-btn-glass" onClick={() => onNavigate("create")}>Publish a brief</button>
          </div>

          <div className="lg-hero-cards" aria-hidden="true">
            <div ref={heroCardsRef} className="lg-hero-cards-inner">
              <div className="lg-glass-dark lg-hero-card">
                <div className="lg-hero-card-head"><span className="lg-avatar">SMU</span>Example brief · Business problem</div>
                <div className="lg-hero-card-title">Route optimisation for cold-chain delivery under demand spikes</div>
                <div className="lg-stat-row">
                  <div><strong>60,000</strong><small>USDT budget</small></div>
                  <div><strong>50 days</strong><small>left to propose</small></div>
                  <div><strong>3</strong><small>proposals</small></div>
                </div>
                <div className="lg-stages"><span className="is-on" /><span /><span /><span /><span /></div>
                <div className="lg-stages-label"><span>Open</span><span>Complete</span></div>
              </div>
              <div className="lg-glass-dark lg-float lg-float-top">
                <span className="lg-float-check"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg></span>
                <span><strong>Proposal matched</strong><small>Variational circuits for route planning</small></span>
              </div>
              <div className="lg-glass-dark lg-float lg-float-bottom">
                <small>Milestone 2 of 3 released</small>
                <strong>USDT 40,000</strong>
                <div className="lg-progress"><span className="is-full" style={{ width: "66%" }} /></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lg-roles" data-tone="light">
        <Blobs set={["r1", "r2", "r3"]} />
        <div className="lg-wrap">
          <div className="lg-center" data-reveal>
            <h2>Four roles.<br />One clear path.</h2>
            <p className="lg-lede">Everyone sees the same brief, the same proposals and the same milestones.</p>
          </div>
          <div className="lg-role-grid" data-reveal>
            {ROLES.map((role) => (
              <article className="lg-glass-light lg-role" key={role.key}>
                <span className={`lg-role-icon ${role.key}`}><Icon name={role.key} /></span>
                <span className="lg-spacer" />
                <h3>{role.name}</h3>
                <p>{role.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="how" className={`lg-how${compact ? " is-compact" : ""}`} data-tone="dark" ref={stepsRef}>
        <div className="lg-how-stage">
          <Blobs set={[`s${step}a`, `s${step}b`, `s${step}c`]} />
          <div className="lg-how-grid">
            {!compact && (
              <div>
                <div className="lg-how-eyebrow">From brief to delivery</div>
                <div className="lg-step-list">
                  {STEPS.map(([title, text], index) => (
                    <button type="button" key={title} className={index === step ? "is-active" : ""} aria-current={index === step ? "step" : undefined} onClick={() => scrollToStep(index)}>
                      <span className="lg-step-title">{title}</span>
                      {index === step && <span className="lg-step-text">{text}</span>}
                    </button>
                  ))}
                </div>
                <div className="lg-step-progress"><span ref={progressRef} /></div>
              </div>
            )}
            {compact && <div className="lg-how-eyebrow">From brief to delivery</div>}
            {(compact ? [0, 1, 2, 3] : [step]).map((index) => (
              <div key={index} className="lg-step-block">
                {compact && (
                  <div className="lg-step-head">
                    <div className="lg-step-title">{STEPS[index][0]}</div>
                    <div className="lg-step-text">{STEPS[index][1]}</div>
                  </div>
                )}
                <div className="lg-glass-dark lg-step-panel" aria-label={`Example: ${STEPS[index][0]}`}>
                  <StepPanel index={index} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lg-tiles" data-tone="light">
        <div className="lg-tile lg-tile-light" data-reveal>
          <Blobs set={["t1", "t2"]} />
          <div className="lg-tile-inner">
            <h3>Discover</h3>
            <p>Every open problem and funding call, in one place.</p>
            <div className="lg-tile-links">
              <button type="button" onClick={() => onNavigate("discover")}>Browse all ›</button>
              <button type="button" onClick={() => document.getElementById("open")?.scrollIntoView({ behavior: "smooth" })}>See what’s open ›</button>
            </div>
            <div className="lg-glass-light lg-tile-mock">
              <div className="lg-mock-search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>Search</div>
              {featured.length > 0 ? featured.slice(0, 3).map((item) => (
                <button type="button" className="lg-mock-row" key={item.id} onClick={() => open(item)}>
                  <span><strong>{item.title}</strong><small>{item.owner}</small></span>
                  <span className="lg-mock-amount">{item.amount}</span>
                </button>
              )) : (
                <div className="lg-mock-empty">{isAuthenticated ? (loading ? "Loading opportunities…" : "Nothing open yet.") : "Sign in to see what’s open."}</div>
              )}
            </div>
          </div>
        </div>

        <div className="lg-tile lg-tile-dark" data-reveal>
          <Blobs set={["t3", "t4"]} />
          <div className="lg-tile-inner">
            <h3>Workspaces</h3>
            <p>Every brief, proposal and milestone you’re part of, by role.</p>
            <div className="lg-tile-links"><button type="button" onClick={onOpenWorkspaces}>Open workspaces ›</button></div>
            <div className="lg-glass-dark lg-tile-mock">
              <div className="lg-role-mini">
                {ROLES.map((role) => (
                  <div key={role.key}><Icon name={role.key} size={20} /><span>{role.name}</span></div>
                ))}
              </div>
              <div className="lg-field lg-mock-work">
                <strong>Your briefs and proposals</strong>
                <small>Track each one from open to complete.</small>
                <div className="lg-stages"><span className="is-on" /><span className="is-on" /><span /><span /><span /></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="open" className="lg-open" data-tone="light">
        <Blobs set={["o1", "o2", "o3"]} />
        <div className="lg-wrap lg-open-head">
          <div data-reveal>
            <h2>Open now.</h2>
            <p className="lg-lede">Business problems and open funding calls.</p>
          </div>
          {featured.length > 1 && (
            <div className="lg-rail-controls">
              <button type="button" aria-label="Previous opportunities" onClick={() => scrollRail(-1)}><Chevron left /></button>
              <button type="button" aria-label="Next opportunities" onClick={() => scrollRail(1)}><Chevron /></button>
            </div>
          )}
        </div>
        {featured.length > 0 ? (
          <div className="lg-rail" ref={railRef}>
            {featured.map((item) => (
              <button type="button" className="lg-glass-light lg-rail-card" key={item.id} onClick={() => open(item)}>
                <small>{item.type}</small>
                <strong>{item.title}</strong>
                <span className="lg-rail-org">{item.owner}</span>
                <span className="lg-spacer" />
                <span className="lg-rail-foot"><span>{item.amount}</span><small>{daysLeft(item.expiresAt)}</small></span>
              </button>
            ))}
          </div>
        ) : (
          <div className="lg-wrap">
            <p className="lg-glass-light lg-rail-empty" role="status">
              {!isAuthenticated ? "Sign in to see opportunities posted by other organisations."
                : loading ? "Loading opportunities…" : "No open opportunities yet. Publish the first one."}
            </p>
          </div>
        )}
      </section>

      <section className="lg-closing" data-tone="light">
        <div data-reveal>
          <h2>Have a problem<br />worth solving?</h2>
          <p className="lg-lede">Write a brief in four steps. Researchers can start proposing as soon as it’s on-chain.</p>
          <div className="lg-hero-actions">
            <button type="button" className="primary large" onClick={() => onNavigate("create")}>Publish a brief</button>
            <button type="button" className="secondary large lg-outline" onClick={() => onNavigate("discover")}>Explore opportunities</button>
          </div>
        </div>
      </section>
    </div>
  );
}
