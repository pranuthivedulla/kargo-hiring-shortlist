import path from "path";

export const DATA_DIR = path.join(process.cwd(), "data");
export const APPLICATIONS_DIR = path.join(DATA_DIR, "applications");
export const HIRES_DIR = path.join(DATA_DIR, "hires");
export const JDS_DIR = path.join(DATA_DIR, "jds");
export const RUNS_DIR = path.join(DATA_DIR, "runs");
export const DECISIONS_FILE = path.join(DATA_DIR, "decisions.json");
export const PARSED_FILE = path.join(DATA_DIR, "parsed-applications.json");

export type Role = "PM" | "SPM";
export const ROLES: Role[] = ["PM", "SPM"];

export const ROLE_LABEL: Record<Role, string> = {
  PM: "Product Manager",
  SPM: "Senior Product Manager",
};
