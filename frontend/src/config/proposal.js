export const PROPOSAL_CATEGORIES = [
  { value: "gate-model", label: "Gate-based quantum computing" },
  { value: "quantum-inspired", label: "Quantum-inspired approaches" },
  { value: "quantum-annealing", label: "Quantum annealing" },
  { value: "hybrid", label: "Hybrid quantum / classical" },
  { value: "quantum-adjacent", label: "Other quantum-adjacent approach" },
];

export const PROPOSAL_FIELDS = [
  ["title", "Proposal title", 160],
  ["summary", "Approach summary", 4000],
  ["methodology", "Technical methodology", 4000],
  ["suitability", "Why this approach suits the problem", 4000],
  ["expectedOutcomes", "Expected outcomes", 4000],
  ["successCriteria", "Measurable success criteria", 4000],
  ["timeline", "Delivery timeline", 4000],
  ["milestones", "Milestones and deliverables", 4000],
  ["team", "Team and relevant experience", 4000],
];

export const PROBLEM_FRAMING_FIELDS = [
  ["proposedProblem", "Proposed problem statement", 4000],
  ["relevance", "Business or scientific relevance", 4000],
  ["thesisFit", "Why this fits the funder's thesis", 4000],
];
