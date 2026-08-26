// Contribution counters and reputation held on every user profile.
//
// These are READ-ONLY from the browser: firebase/firestore.rules freezes the whole
// `stats` map on update, so a user cannot award themselves karma. They are meant to
// be moved by trusted server code (a Cloud Function reacting to writes elsewhere in
// Firestore, or the contract indexer) once those features land.
export const initialStats = {
  comments: 0,
  businessProblems: 0,
  openFunding: 0,
  fundingRequests: 0,
  karma: 0,
  reputation: 0,
};

export const statLabels = {
  comments: "Comments",
  businessProblems: "Business problems",
  openFunding: "Open funding",
  fundingRequests: "Funding requests",
  karma: "Karma",
  reputation: "Reputation",
};

export const statKeys = Object.keys(initialStats);

export function withDefaults(stats) {
  return { ...initialStats, ...(stats ?? {}) };
}
