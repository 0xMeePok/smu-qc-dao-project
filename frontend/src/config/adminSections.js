export const ADMIN_SECTION_GROUPS = [
  {
    label: "Workspace",
    sections: [
      { key: "overview", label: "Overview", description: "Live platform activity and the work that needs your attention." },
      { key: "status", label: "Service health", description: "Check platform services, blockchain connections, and verification queues." },
    ],
  },
  {
    label: "Manage",
    sections: [
      { key: "escrows", label: "Escrows & refunds", description: "Inspect proposal funding and cancel eligible unpaid escrows with a recorded reason." },
      { key: "moderation", label: "Content reports", description: "Review flagged content and record moderation decisions." },
      { key: "users", label: "Users & access", description: "Find accounts, assign roles, and manage account suspensions." },
      { key: "exports", label: "Proposal export", description: "Download a proposal and its comments, accepted or not, for grading outside the platform." },
    ],
  },
  {
    label: "Audit records",
    sections: [
      { key: "proposals", label: "Proposal verification", description: "Check proposal records and resolve failed on-chain verification." },
      { key: "postings", label: "Problem statements", description: "Review submitted problem statements and their verification records." },
      { key: "funding", label: "Funding calls", description: "Review open funding submissions and their verification records." },
      { key: "audits", label: "Governance history", description: "Trace platform activity, administrator decisions, and expiry actions." },
    ],
  },
];

export function getAdminSection(key) {
  for (const group of ADMIN_SECTION_GROUPS) {
    const section = group.sections.find(item => item.key === key);
    if (section) return { ...section, group: group.label };
  }
  return null;
}
