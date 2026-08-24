export const opportunities = [
  {
    id: "calibration-drift",
    type: "Business problem",
    status: "Accepting proposals",
    title: "Reduce calibration drift in topological qubit arrays",
    summary: "Develop a reproducible protocol that detects device-level drift before benchmark runs.",
    owner: "Aster Quantum Systems",
    amount: "Up to $120,000",
    deadline: "30 September 2026",
    benefits: "Faster and more comparable experimental cycles across partner laboratories.",
    outcomes: "An independently reproducible calibration method and reference implementation.",
    deliverables: "Protocol, evaluation dataset, implementation notes and a final report.",
  },
  {
    id: "compiler-verification",
    type: "Open funding",
    status: "Seeking a researcher",
    title: "Formal verification for hybrid quantum compilers",
    summary: "Support for a researcher who can validate optimisation passes used in hybrid workloads.",
    owner: "Northstar Applied Research",
    amount: "$80,000",
    deadline: "Open until matched",
    benefits: "Safer compiler releases with clearer failure boundaries.",
    outcomes: "A machine-checkable proof suite covering the agreed compiler core.",
    deliverables: "Threat model, proof artefacts, CI integration and knowledge-transfer sessions.",
  },
  {
    id: "photonics-benchmark",
    type: "Funding request",
    status: "Looking for a funder",
    title: "Open benchmark suite for photonic error models",
    summary: "A researcher-led plan to publish comparable datasets and open evaluation tooling.",
    owner: "Dr. Mira Chen",
    amount: "$45,000 requested",
    deadline: "Open until matched",
    benefits: "Shared reference points for teams comparing photonic hardware assumptions.",
    outcomes: "A peer-review-ready benchmark paper and maintained public toolkit.",
    deliverables: "Curated datasets, reproducible notebooks, paper draft and release documentation.",
  },
];

export const opportunityTypes = [
  {
    value: "business-problem",
    label: "Business problem",
    note: "Invite research proposals around a clearly defined challenge.",
  },
  {
    value: "open-funding",
    label: "Open funding",
    note: "Offer funding and select one suitable researcher.",
  },
  {
    value: "funding-request",
    label: "Funding request",
    note: "Share researcher-led work and find a funding partner.",
  },
];
