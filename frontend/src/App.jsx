import { useEffect, useMemo, useState } from "react";
import { opportunities, opportunityTypes } from "./data.js";
import { go, parseRoute } from "./lib/router.js";
import { useSession } from "./context/SessionContext.jsx";
import { shortenAddress } from "./lib/chain.js";
import { isAdmin } from "./lib/roles.js";
import { SignInWithWallet } from "./components/SignInWithWallet.jsx";
import { OnboardingModal } from "./components/OnboardingModal.jsx";
import { NetworkBanner } from "./components/NetworkBanner.jsx";
import AdminPage from "./pages/AdminPage.jsx";

const routes = [
  ["home", "Home"],
  ["discover", "Discover"],
  ["create", "Create"],
];

function useRoute() {
  const [route, setRoute] = useState(parseRoute);

  useEffect(() => {
    const updateRoute = () => {
      setRoute(parseRoute());
      window.scrollTo({ top: 0, behavior: "instant" });
    };

    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

  return route;
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" />
    </svg>
  );
}

function Logo() {
  return (
    <button className="brand" type="button" onClick={() => go("home")} aria-label="QC DAO home">
      <span aria-hidden="true">Q</span>
      QC DAO
    </button>
  );
}

function AccountControls() {
  const { isSignedIn, profile, address, signOut } = useSession();

  if (!isSignedIn) {
    return (
      <div className="account-controls">
        <SignInWithWallet />
      </div>
    );
  }

  const admin = isAdmin(profile?.role);

  return (
    <div className="account-controls">
      {admin ? (
        <button className="secondary" type="button" onClick={() => go("admin")}>
          Admin
        </button>
      ) : null}
      <span className="account-status" aria-label="Your account">
        <strong>{profile?.fullName ?? "Your account"}</strong>
        <small>
          {shortenAddress(address)}
          {admin ? " · Administrator" : ""}
        </small>
      </span>
      <button className="secondary" type="button" onClick={() => signOut()}>
        Sign out
      </button>
    </div>
  );
}

function Shell({ route, children }) {
  return (
    <>
      <header className="topbar">
        <Logo />
        <nav aria-label="Primary navigation">
          {routes.map(([key, label]) => (
            <button
              key={key}
              className={route === key ? "active" : ""}
              type="button"
              onClick={() => go(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <AccountControls />
      </header>
      <main>{children}</main>
      <footer>
        <Logo />
        <p>Clear opportunities. Accountable delivery. Transparent outcomes.</p>
        <div className="footer-links">
          <button type="button" onClick={() => go("discover")}>Discover</button>
          <button type="button" onClick={() => go("create")}>Create</button>
        </div>
      </footer>
    </>
  );
}

function OpportunityIcon({ type }) {
  if (type === "Business problem") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7.5 3.5h7L19 8v12.5H7.5z" />
        <path d="M14.5 3.5V8H19M10.5 12h5M10.5 15.5h5" />
      </svg>
    );
  }

  if (type === "Open funding") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 8.5h16v11H4zM7 8.5V5h10v3.5M8 12h8M8 16h5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 12h7M12 8.5v7" />
    </svg>
  );
}

function StakeholderIcon({ type }) {
  if (type === "owner") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3.75h6.25L17 7.5v12.75H7z" />
        <path d="M13.25 3.75V7.5H17M9.5 11h5M9.5 14h5M9.5 17h3.5" />
      </svg>
    );
  }

  if (type === "evaluator") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.25" />
        <path d="m8.25 12.1 2.45 2.45 5.25-5.35" />
      </svg>
    );
  }

  if (type === "researcher") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 3.75h6M10.25 3.75v5.4L6.1 17.2a2.1 2.1 0 0 0 1.86 3.05h8.08a2.1 2.1 0 0 0 1.86-3.05l-4.15-8.05v-5.4" />
        <path d="M8.45 15h7.1" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m4 9 8-5 8 5M5 9h14M7 10.5v6M10.33 10.5v6M13.67 10.5v6M17 10.5v6M4.5 18h15M3.5 20.25h17" />
    </svg>
  );
}

function ResearchNetwork() {
  const stakeholders = [
    ["owner", "Problem owners"],
    ["evaluator", "Evaluators"],
    ["researcher", "Researchers"],
    ["funder", "Funders"],
  ];

  return (
    <div className="research-network" aria-label="Stakeholders collaborate through QC DAO">
      <svg className="network-lines" viewBox="0 0 520 300" aria-hidden="true">
        <path d="M110 72 260 150 412 62M112 235 260 150 414 232M110 72 414 232M112 235 412 62" />
        <circle cx="110" cy="72" r="3" />
        <circle cx="412" cy="62" r="3" />
        <circle cx="112" cy="235" r="3" />
        <circle cx="414" cy="232" r="3" />
      </svg>
      <span className="network-core" aria-hidden="true">Q</span>
      {stakeholders.map(([type, label]) => (
        <span className={`network-node ${type}`} key={type}>
          <span className="network-icon"><StakeholderIcon type={type} /></span>
          <small>{label}</small>
        </span>
      ))}
    </div>
  );
}

function OpportunityCard({ item }) {
  return (
    <button
      className="opportunity-card"
      type="button"
      onClick={() => go(`opportunity/${item.id}`)}
      aria-label={`Open ${item.title}`}
    >
      <span className="opportunity-mark"><OpportunityIcon type={item.type} /></span>
      <span className="opportunity-summary">
        <strong>{item.title}</strong>
        <small>{item.type} · {item.owner}</small>
      </span>
      <span className="status-dot">{item.status}</span>
      <strong className="opportunity-amount">{item.amount}</strong>
      <span className="opportunity-deadline">{item.deadline}</span>
      <span className="row-arrow"><ArrowIcon /></span>
    </button>
  );
}

function OpportunityList({ items }) {
  return (
    <div className="opportunity-list">
      <div className="opportunity-list-head" aria-hidden="true">
        <span>Opportunity</span>
        <span>Status</span>
        <span>Budget</span>
        <span>Timing</span>
        <span />
      </div>
      {items.map((item) => <OpportunityCard item={item} key={item.id} />)}
    </div>
  );
}

function Home() {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>Fund research<br /><span>with clear outcomes.</span></h1>
          <p>Publish important problems, compare thoughtful proposals and support work through clear delivery stages.</p>
          <div className="actions">
            <button className="primary" type="button" onClick={() => go("discover")}>Explore opportunities</button>
            <button className="secondary" type="button" onClick={() => go("create")}>Publish a brief</button>
          </div>
        </div>
        <ResearchNetwork />
      </section>

      <section className="marketplace-section">
        <div className="section-heading">
          <div>
            <h2>Open opportunities</h2>
            <p>Competitive problems and one-to-one research relationships.</p>
          </div>
          <button className="text-button" type="button" onClick={() => go("discover")}>Browse all <ArrowIcon /></button>
        </div>
        <OpportunityList items={opportunities} />
      </section>

      <section className="how">
        <div className="steps">
          <article><b aria-hidden="true">01</b><div><h3>Accountable by design</h3><p>Define outcomes and deliverables before work begins.</p></div></article>
          <article><b aria-hidden="true">02</b><div><h3>Evidence over hype</h3><p>Compare opportunities on methods, feasibility and impact.</p></div></article>
          <article><b aria-hidden="true">03</b><div><h3>Fund with confidence</h3><p>Keep a transparent record from publication onward.</p></div></article>
        </div>
      </section>
    </>
  );
}

function Discover() {
  const [filter, setFilter] = useState("All");
  const filters = ["All", ...opportunityTypes.map(({ label }) => label)];
  const visibleOpportunities = filter === "All"
    ? opportunities
    : opportunities.filter((item) => item.type === filter);

  return (
    <section className="page">
      <div className="page-heading">
        <h1>Explore research opportunities</h1>
        <p>Review open challenges, funding offers and researcher-led requests.</p>
      </div>
      <div className="filters" aria-label="Filter opportunities">
        {filters.map((item) => (
          <button
            className={filter === item ? "selected" : ""}
            key={item}
            type="button"
            onClick={() => setFilter(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <OpportunityList items={visibleOpportunities} />
    </section>
  );
}

function OpportunityDetail({ id }) {
  const item = opportunities.find((candidate) => candidate.id === id);
  if (!item) return <NotFound />;

  return (
    <section className="page detail-page">
      <button className="back" type="button" onClick={() => go("discover")}>Back to opportunities</button>
      <div className="detail-layout">
        <article className="detail-main">
          <div className="card-top">
            <span className="eyebrow">{item.type}</span>
            <span className="status-dot">{item.status}</span>
          </div>
          <h1>{item.title}</h1>
          <p className="lead">{item.summary}</p>
          <div className="detail-section"><h2>Why this work matters</h2><p>{item.benefits}</p></div>
          <div className="detail-section"><h2>Expected outcomes</h2><p>{item.outcomes}</p></div>
          <div className="detail-section"><h2>Deliverables</h2><p>{item.deliverables}</p></div>
        </article>
        <aside className="context-panel">
          <span className="eyebrow">Funding overview</span>
          <strong>{item.amount}</strong>
          <dl>
            <div><dt>Published by</dt><dd>{item.owner}</dd></div>
            <div><dt>Timing</dt><dd>{item.deadline}</dd></div>
            <div><dt>Current stage</dt><dd>{item.status}</dd></div>
          </dl>
          <button className="primary" type="button" onClick={() => go("create")}>Create a similar brief</button>
        </aside>
      </div>
    </section>
  );
}

const initialForm = {
  opportunityType: "business-problem",
  title: "",
  summary: "",
  outcomes: "",
  amount: "",
};

function CreateOpportunity() {
  const [form, setForm] = useState(initialForm);
  const [submitted, setSubmitted] = useState(false);
  const selectedType = useMemo(
    () => opportunityTypes.find((type) => type.value === form.opportunityType),
    [form.opportunityType],
  );

  const update = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setSubmitted(false);
  };

  const submit = (event) => {
    event.preventDefault();
    setSubmitted(true);
  };

  return (
    <section className="page create-page">
      <div className="page-heading">
        <h1>Create a funding opportunity</h1>
        <p>Choose the relationship that best fits the work, then add the details researchers and funders need.</p>
      </div>
      {submitted ? (
        <div className="submission-success" role="status">
          <span aria-hidden="true">✓</span>
          <div>
            <h2>Brief preview created</h2>
            <p>Your brief is ready to review. Changes remain available for this session.</p>
          </div>
          <button className="secondary" type="button" onClick={() => setSubmitted(false)}>Continue editing</button>
        </div>
      ) : null}
      <form onSubmit={submit}>
        <fieldset className="workflow-picker">
          <legend>Opportunity type</legend>
          {opportunityTypes.map((option) => (
            <label className={form.opportunityType === option.value ? "chosen" : ""} key={option.value}>
              <input
                type="radio"
                name="opportunityType"
                value={option.value}
                checked={form.opportunityType === option.value}
                onChange={update}
              />
              <strong>{option.label}</strong>
              <span>{option.note}</span>
            </label>
          ))}
        </fieldset>

        <div className="form-section">
          <div><span className="form-step">01</span><h2>Opportunity overview</h2></div>
          <label>
            Title
            <input required minLength="6" name="title" value={form.title} onChange={update} placeholder={`${selectedType.label} title`} />
          </label>
          <label>
            Summary
            <textarea required minLength="20" name="summary" value={form.summary} onChange={update} placeholder="Explain the need or research direction in plain language." />
          </label>
        </div>

        <div className="form-section">
          <div><span className="form-step">02</span><h2>Expected result</h2></div>
          <label>
            Outcomes
            <textarea required minLength="10" name="outcomes" value={form.outcomes} onChange={update} placeholder="What should be demonstrably true when the work is complete?" />
          </label>
          <label>
            Indicative budget
            <input required min="1" type="number" name="amount" value={form.amount} onChange={update} placeholder="Amount in USD" />
          </label>
        </div>

        <div className="form-actions">
          <p>Review your information before creating the preview.</p>
          <button className="primary" type="submit">Preview brief</button>
        </div>
      </form>
    </section>
  );
}

function NotFound() {
  return (
    <section className="page empty">
      <h1>This research opportunity is not available.</h1>
      <button className="primary" type="button" onClick={() => go("discover")}>Browse opportunities</button>
    </section>
  );
}

export default function App() {
  const route = useRoute();
  const [section, id] = route.split("/");

  let content = <NotFound />;
  if (section === "home") content = <Home />;
  if (section === "discover") content = <Discover />;
  if (section === "create") content = <CreateOpportunity />;
  if (section === "opportunity") content = <OpportunityDetail id={id} />;
  if (section === "admin") content = <AdminPage />;

  return (
    <>
      <NetworkBanner />
      <Shell route={section}>{content}</Shell>
      <OnboardingModal />
    </>
  );
}
