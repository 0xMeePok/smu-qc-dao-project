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
  [ROLES.OWNER]: {
    id: "usr_owner_01",
    name: "Dr. Elena Rostova",
    org: "Aster Quantum Systems",
    role: ROLES.OWNER,
    address: "0x71C...9B2a",
  },
  [ROLES.RESEARCHER]: {
    id: "usr_res_02",
    name: "Dr. Marcus Vance",
    org: "Centre for Quantum Technologies",
    role: ROLES.RESEARCHER,
    address: "0x3F8...4A1e",
  },
  [ROLES.EVALUATOR]: {
    id: "usr_eval_03",
    name: "Prof. Sophia Wei",
    org: "Quantum Advisory Panel",
    role: ROLES.EVALUATOR,
    address: "0x98A...51C0",
  },
  [ROLES.FUNDER]: {
    id: "usr_fund_04",
    name: "David Sterling",
    org: "DeepTech Innovation Fund",
    role: ROLES.FUNDER,
    address: "0x12D...88e4",
  },
  [ROLES.ADMIN]: {
    id: "usr_admin_05",
    name: "DAO Operations",
    org: "SMU QC DAO Core",
    role: ROLES.ADMIN,
    address: "0x000...Ad01",
  },
};
