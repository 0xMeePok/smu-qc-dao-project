export const ROLES = {
  GUEST: "guest",
  OWNER: "owner",
  RESEARCHER: "researcher",
  EVALUATOR: "evaluator",
  FUNDER: "funder",
  ADMIN: "admin",
};

export const ROLE_LABELS = {
  [ROLES.GUEST]: "Guest",
  [ROLES.OWNER]: "Problem Owner",
  [ROLES.RESEARCHER]: "Researcher",
  [ROLES.EVALUATOR]: "Evaluator",
  [ROLES.FUNDER]: "Funder",
  [ROLES.ADMIN]: "DAO Admin",
};

export const ROLE_DESCRIPTIONS = {
  [ROLES.GUEST]: "Public visitor exploring opportunities and open calls.",
  [ROLES.OWNER]: "Enterprise / problem owner defining challenges and reviewing proposals.",
  [ROLES.RESEARCHER]: "Academic / scientific lead preparing and submitting proposals.",
  [ROLES.EVALUATOR]: "Technical reviewer conducting double-blind evaluations and scoring.",
  [ROLES.FUNDER]: "Capital allocator funding vetted quantum research initiatives.",
  [ROLES.ADMIN]: "Platform governor overseeing system registries and on-chain audit trails.",
};

export const DEMO_USERS = {
  // Unified Platform Member possessing all 4 standard stakeholder roles
  member: {
    id: "usr_member_01",
    name: "Dr. Marcus Vance",
    org: "Quantum Innovation Network",
    roles: [ROLES.OWNER, ROLES.RESEARCHER, ROLES.EVALUATOR, ROLES.FUNDER],
    address: "0x3F8...4A1e",
  },
  // Dedicated Governance Administrator
  admin: {
    id: "usr_admin_05",
    name: "DAO Operations",
    org: "SMU QC DAO Core",
    roles: [ROLES.ADMIN],
    address: "0x000...Ad01",
  },
};
