import path from "path";

// DATA_DIR lets the test suite point at data/_fixtures instead of the real
// data/ folder. Without it, running the tests would ingest real candidates'
// CVs and, with DATABASE_URL set, write them to the production database.
export const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR ?? "data");
export const APPLICATIONS_DIR = path.join(DATA_DIR, "applications");
export const HIRES_DIR = path.join(DATA_DIR, "hires");
export const JDS_DIR = path.join(DATA_DIR, "jds");
export const RUNS_DIR = path.join(DATA_DIR, "runs");
export const DECISIONS_FILE = path.join(DATA_DIR, "decisions.json");
export const PARSED_FILE = path.join(DATA_DIR, "parsed-applications.json");

/**
 * OPEN is for CVs that arrived with no role on them. They are gated against
 * both job descriptions and carry a recommended role, rather than being
 * guessed into one pool where a wrong guess is invisible.
 */
export type Role = "PM" | "SPM" | "OPEN";
export const ROLES: Role[] = ["PM", "SPM", "OPEN"];

/** The two roles that have a job description of their own. */
export type NamedRole = "PM" | "SPM";
export const NAMED_ROLES: NamedRole[] = ["PM", "SPM"];

export const ROLE_LABEL: Record<Role, string> = {
  PM: "Product Manager",
  SPM: "Senior Product Manager",
  OPEN: "Role not stated",
};
