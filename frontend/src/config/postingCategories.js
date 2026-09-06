/**
 * QCDAO-48 - the technology areas a posting can ask for help in.
 *
 * DOMAIN level, not technique level. A problem owner writing the form knows their
 * business problem, not which algorithm family solves it - asking them to choose
 * between QAOA and VQE puts the burden on the wrong side of the marketplace. Naming
 * the field lets solution developers filter, and leaves the approach to the people
 * proposing one.
 *
 * Notes are deliberately short. They sit inside small selectable cards, and a
 * sentence that wraps to five lines makes a grid of them unreadable.
 *
 * The values are mirrored in firebase/firestore.rules (allowedCategories). Adding
 * one here without adding it there means every posting using it is rejected on
 * write - frontend/test/unit/posting.test.js checks the two lists agree.
 */
export const POSTING_CATEGORIES = [
  { value: "ai", label: "AI & machine learning", note: "Models, prediction, automation." },
  { value: "quantum", label: "Quantum", note: "Gate-based, annealing, quantum-inspired." },
  { value: "web3", label: "Web3 & blockchain", note: "Smart contracts, tokens, on-chain data." },
  { value: "robotics", label: "Robotics", note: "Autonomy, control, manipulation." },
  { value: "iot", label: "IoT & sensors", note: "Connected devices and telemetry." },
  { value: "data", label: "Data & analytics", note: "Pipelines, modelling, reporting." },
  { value: "security", label: "Security & cryptography", note: "Threats, encryption, resilience." },
  { value: "cloud", label: "Cloud & infrastructure", note: "Scale, orchestration, cost." },
  { value: "simulation", label: "Simulation & modelling", note: "Digital twins, physical systems." },
  { value: "optimisation", label: "Optimisation", note: "Scheduling, routing, allocation." },
  { value: "sustainability", label: "Sustainability", note: "Energy, emissions, materials." },
  { value: "other", label: "Other", note: "Outside the areas listed." },
];

export const CATEGORY_VALUES = POSTING_CATEGORIES.map((category) => category.value);

export const MAX_CATEGORIES = 6;

export const CURRENCIES = ["USDT", "USDC", "XSGD"];

/** How long a posting stays open for responses. Written as a concrete expiry date. */
export const EXPIRY_WINDOWS = [
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
  { value: 180, label: "180 days" },
];

export function categoryLabel(value) {
  return POSTING_CATEGORIES.find((category) => category.value === value)?.label ?? value;
}

export function expiryDateFrom(days, now = new Date()) {
  const expiry = new Date(now);
  expiry.setDate(expiry.getDate() + Number(days));
  // Exact to the second. The stored expiry is the instant responses stop being
  // accepted and is shown next to a live countdown, so carrying whatever
  // millisecond the form happened to be submitted on is noise that only makes two
  // postings created together look different.
  expiry.setMilliseconds(0);
  return expiry;
}
