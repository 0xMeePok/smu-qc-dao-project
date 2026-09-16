import {
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_WINDOW_DAYS,
  MAX_EXPIRY_DAYS,
  MIN_EXPIRY_DAYS,
  expiryFrom,
  extendExpiry,
  isExpiryWindow,
} from "../../../firebase/functions/opportunityExpiry.js";

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

/** Response windows come from the shared expiry helper, so the rule is defined once. */
export const EXPIRY_WINDOWS = EXPIRY_WINDOW_DAYS.map((value) => ({ value, label: `${value} days` }));

export { DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS, MIN_EXPIRY_DAYS, isExpiryWindow };
export const expiryDateFrom = expiryFrom;
export const extendExpiryDate = extendExpiry;

export function categoryLabel(value) {
  return POSTING_CATEGORIES.find((category) => category.value === value)?.label ?? value;
}
