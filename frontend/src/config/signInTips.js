/**
 * Shown one at a time while a new sign-in finishes (SignInProgress). Each tip
 * describes something the app really does; keep them accurate when features
 * change, and short enough to read in the six seconds each is shown.
 */
export const SIGN_IN_TIPS = Object.freeze([
  { title: "Find a problem to solve", text: "Discover lists every open problem. Search and filter it to find ones that match your skills." },
  { title: "Post a problem", text: "Create Brief walks you through a problem step by step. Save a draft at any point and publish when it is ready." },
  { title: "Respond with a proposal", text: "Open any problem and choose Submit a proposal. Supporting PDFs are optional." },
  { title: "Two sides to every deal", text: "You cannot propose on a problem you posted yourself: the escrow needs a different poster and proposer." },
  { title: "Tamper-evident records", text: "Every published problem and proposal is anchored on Arbitrum Sepolia, so anyone can check it has not been changed." },
  { title: "No ETH needed", text: "QC DAO pays the network fee for your transactions, so a brand-new wallet can take part straight away." },
  { title: "You approve every transaction", text: "Privy shows an approval screen before each transaction. Nothing is sent until you approve it." },
  { title: "One email, one wallet", text: "Your wallet comes from your email sign-in. The same email reaches the same wallet on any device." },
  { title: "Never miss a step", text: "Action Needed gathers everything waiting on you: reviews, approvals and payment releases." },
  { title: "Track your proposals", text: "My Proposals shows each proposal's status, feedback and funding in one place." },
  { title: "Paid in milestones", text: "Escrow holds the funding and releases it in tranches as both sides approve each milestone." },
  { title: "Expert reviews", text: "Evaluators review proposals in the Evaluation Queue and leave recommendations for the problem owner." },
  { title: "Follow your funding", text: "Funders can follow every commitment and release in the Funding Portfolio." },
  { title: "Introduce yourself", text: "Complete your profile so posters and researchers know who they are working with." },
  { title: "Stay signed in safely", text: "For your security, QC DAO signs you out after one hour without activity." },
]);
