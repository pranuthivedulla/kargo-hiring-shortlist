import type { Role } from "./paths";

export type Signal = "STRONG" | "PARTIAL" | "ABSENT";

/** One CV, parsed to plain text. The original file is never modified. */
export type ParsedCandidate = {
  id: string;
  name: string;
  role: Role;
  file: string;          // path relative to data/applications
  format: "pdf" | "docx" | "txt" | "md";
  chars: number;
  text: string;
  parseError?: string;   // set when extraction failed; candidate is still listed
};

export type ShortlistEntry = {
  candidate: string;
  role: string;
  gate: "PASS";
  primary_signal: Signal;
  primary_evidence: string;
  secondary_signal: Signal;
  secondary_evidence: string;
  rank: number;
  why_ranked_here: string;
  what_to_probe: string[];
};

export type NotAdvancingEntry = {
  candidate: string;
  role: string;
  status: "GATE_FAILED" | "RANKED_BUT_NOT_SHORTLISTED";
  reason: string;
};

export type RunFile = {
  runId: string;
  role: Role;
  createdAt: string;
  model: string;
  batchTotal: number;
  candidateIds: Record<string, string>;   // candidate name -> parsed candidate id
  shortlist: ShortlistEntry[];
  notAdvancing: NotAdvancingEntry[];
};

export type DecisionStatus = "advanced" | "rejected";

export type Decision = {
  candidateId: string;
  candidate: string;
  role: Role;
  runId: string;
  status: DecisionStatus;
  decidedAt: string;
  email?: string;
  /** Communication is a separate, explicitly confirmed step. */
  comms: {
    state: "pending" | "sent" | "failed" | "skipped";
    draftedAt?: string;
    sentAt?: string;
    subject?: string;
    body?: string;
    bookingUrl?: string;
    error?: string;
  };
};

export type DecisionsFile = Record<string, Decision>;  // keyed by candidateId
