import { loadHires, loadJd } from "./corpus";
import { generateText, hasKey, modelLabel } from "./model";
import { ROLE_LABEL, type NamedRole, type Role } from "./paths";
import { saveRun } from "./store";
import type { NotAdvancingEntry, ParsedCandidate, RunFile, ShortlistEntry, Signal } from "./types";

/** One role's full batch, per the brief. */
export const BATCH_CAP = 30;

/**
 * Used verbatim, as specified. Do not paraphrase, reorder, or "tighten" this —
 * the gate/signal vocabulary it defines is what the UI and the run files read.
 */
export const RANKING_SYSTEM_PROMPT = `You are ranking candidates for a single open role at a company. You
will be given: (1) the job description for this role, (2) a set of
past-hire calibration profiles for this company (outcomes are
mixed), and (3) a batch of candidate CVs for this role. Your job is
to Gate, then rank, then explain — never to silently decide.

STEP 1 — GATE (pass/fail, JD baseline only)
Check only the minimum stated requirements in the JD. This is a
floor, not a ranking signal. Output PASS or FAIL per candidate with
the specific JD line that drove a FAIL. A FAIL still appears in the
final output, never silently dropped.

STEP 2 — PRIMARY SIGNAL (heaviest weight)
For every PASSed candidate: does their work history show
ground-level operational exposure to logistics, freight, shipping,
or a similarly ops-heavy domain, before or alongside their
functional career? Evidence-based, not keyword matching. Score
STRONG / PARTIAL / ABSENT with the specific CV line(s) that justify
it.

STEP 3 — SECONDARY SIGNAL
For every PASSed candidate, assess independently: (a) unprompted
self-initiated fixes later institutionalized, (b) a hard call —
including killing/abandoning something — made on data, without
visibly offloading the decision. Score each STRONG / PARTIAL /
ABSENT with evidence.

STEP 4 — RANK
Rank PASSed candidates primarily by Primary Signal, Secondary
Signal as tiebreaker. Do not let JD-adjacent polish (seniority
titles, brand-name employers, years above the floor) move a
candidate up if Primary Signal is ABSENT.

STEP 5 — OUTPUT (strict JSON, two sections, no exceptions)
SECTION A — shortlist (ranked): for every PASSed candidate —
{ candidate, role, gate: "PASS", primary_signal, primary_evidence,
  secondary_signal, secondary_evidence, rank,
  why_ranked_here (1-3 sentences, must cite specific evidence),
  what_to_probe (1-2 concrete interview questions) }
SECTION B — not advancing: every GATE_FAILED candidate and every
PASSed-but-excluded candidate —
{ candidate, role, status: "GATE_FAILED" | "RANKED_BUT_NOT_SHORTLISTED",
  reason (specific enough that Arjun never needs to reopen the CV) }

HARD CONSTRAINTS: never fabricate experience not stated in the CV;
say "insufficient evidence" rather than guess; never auto-reject —
every candidate appears in the output; calibration data is 7-8
profiles with mixed outcomes, treat the Primary Signal pattern as a
strong prior and flag clear exceptions rather than forcing them
down mechanically; never blend scores into one hidden number.`;

/**
 * For CVs that arrived with no role on them. Deliberately a separate prompt:
 * RANKING_SYSTEM_PROMPT above is specified verbatim for "a single open role"
 * and must not be edited. This one keeps the same gate/signal vocabulary so the
 * dashboard reads both kinds of run identically, and adds the role call.
 */
export const TRIAGE_SYSTEM_PROMPT = `You are screening candidates who applied to a company without stating
which of two open roles they want. You will be given: (1) the job descriptions
for BOTH roles, (2) a set of past-hire calibration profiles for this company
(outcomes are mixed), and (3) a batch of candidate CVs. Your job is to decide
which role each person fits, then Gate, then rank, then explain — never to
silently decide.

STEP 0 — ROLE
For each candidate, judge which role their CV is a better fit for, from
evidence in the CV: seniority, scope owned, and years of product experience
against each JD's stated floor. Output PM, SPM, or NEITHER. NEITHER means the
CV fails the minimum stated requirements of BOTH job descriptions. Say in one
sentence what drove the choice. Do not split a candidate across both roles.

STEP 1 — GATE (pass/fail, JD baseline only)
Against the minimum stated requirements of the role you chose in STEP 0. This
is a floor, not a ranking signal. Output PASS or FAIL per candidate with the
specific JD line that drove a FAIL. Anyone scored NEITHER in STEP 0 is a FAIL.
A FAIL still appears in the final output, never silently dropped.

STEP 2 — PRIMARY SIGNAL (heaviest weight)
For every PASSed candidate: does their work history show ground-level
operational exposure to logistics, freight, shipping, or a similarly ops-heavy
domain, before or alongside their functional career? Evidence-based, not
keyword matching. Score STRONG / PARTIAL / ABSENT with the specific CV line(s)
that justify it.

STEP 3 — SECONDARY SIGNAL
For every PASSed candidate, assess independently: (a) unprompted self-initiated
fixes later institutionalized, (b) a hard call — including killing/abandoning
something — made on data, without visibly offloading the decision. Score each
STRONG / PARTIAL / ABSENT with evidence.

STEP 4 — RANK
Rank PASSed candidates primarily by Primary Signal, Secondary Signal as
tiebreaker. Rank them in ONE list across both roles; the recommended role is
recorded per candidate, not used to split the ranking. Do not let JD-adjacent
polish (seniority titles, brand-name employers, years above the floor) move a
candidate up if Primary Signal is ABSENT.

STEP 5 — OUTPUT (strict JSON, two sections, no exceptions)
SECTION A — shortlist (ranked): for every PASSed candidate —
{ candidate, role, recommended_role: "PM" | "SPM", role_rationale,
  gate: "PASS", primary_signal, primary_evidence, secondary_signal,
  secondary_evidence, rank, why_ranked_here (1-3 sentences, must cite specific
  evidence), what_to_probe (1-2 concrete interview questions) }
SECTION B — not advancing: every GATE_FAILED candidate and every
PASSed-but-excluded candidate —
{ candidate, role, recommended_role, status: "GATE_FAILED" |
  "RANKED_BUT_NOT_SHORTLISTED", reason (specific enough that Arjun never needs
  to reopen the CV) }

HARD CONSTRAINTS: never fabricate experience not stated in the CV; say
"insufficient evidence" rather than guess; never auto-reject — every candidate
appears in the output; treat the Primary Signal pattern in the calibration data
as a strong prior and flag clear exceptions rather than forcing them down
mechanically; never blend scores into one hidden number.`;

/** Appended so the response is machine-readable without touching the prompt above. */
const OUTPUT_CONTRACT = `Return ONLY a JSON object, no prose and no code fence, of the shape:
{"section_a_shortlist": [ ... ], "section_b_not_advancing": [ ... ]}
"what_to_probe" is an array of 1-2 question strings. Use each candidate's name
exactly as given in the batch below.`;

const TRIAGE_CONTRACT = `${OUTPUT_CONTRACT}
Every entry in both sections also carries "recommended_role": "PM", "SPM" or
"NEITHER". Shortlist entries additionally carry "role_rationale": one sentence.`;

function renderCvs(batch: ParsedCandidate[]): string {
  return batch
    .map((c, i) => {
      const body = c.text.trim().length
        ? c.text
        : "[No readable text could be extracted from this file.]";
      const note = c.parseError ? `\n[INGESTION NOTE: ${c.parseError}]` : "";
      return `### CANDIDATE ${i + 1}: ${c.name}\n[source file: ${c.file}]${note}\n\n${body}`;
    })
    .join("\n\n---\n\n");
}

function buildUserMessage(
  jd: string,
  hires: string,
  batch: ParsedCandidate[],
  role: NamedRole,
): string {
  return [
    `## (1) JOB DESCRIPTION — ${ROLE_LABEL[role]}\n\n${jd}`,
    `## (2) PAST-HIRE CALIBRATION PROFILES\n\n${hires}`,
    `## (3) CANDIDATE BATCH — ${batch.length} CVs for ${ROLE_LABEL[role]}\n\n${renderCvs(batch)}`,
    `## OUTPUT\n\n${OUTPUT_CONTRACT}`,
  ].join("\n\n");
}

/** Both job descriptions, because these CVs name no role. */
function buildTriageMessage(
  jds: Record<NamedRole, string>,
  hires: string,
  batch: ParsedCandidate[],
): string {
  return [
    `## (1a) JOB DESCRIPTION — ${ROLE_LABEL.PM}\n\n${jds.PM}`,
    `## (1b) JOB DESCRIPTION — ${ROLE_LABEL.SPM}\n\n${jds.SPM}`,
    `## (2) PAST-HIRE CALIBRATION PROFILES\n\n${hires}`,
    `## (3) CANDIDATE BATCH — ${batch.length} CVs, no role stated on any of them\n\n${renderCvs(batch)}`,
    `## OUTPUT\n\n${TRIAGE_CONTRACT}`,
  ].join("\n\n");
}

/** Tolerates a stray code fence or leading prose without loosening the contract. */
function parseJson(text: string): { a: ShortlistEntry[]; b: NotAdvancingEntry[] } {
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1].trim();
  else {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start > 0 || end < body.length - 1) {
      if (start === -1 || end === -1) throw new Error("Model response contained no JSON object.");
      body = body.slice(start, end + 1);
    }
  }

  const parsed = JSON.parse(body) as Record<string, unknown>;
  const a = (parsed.section_a_shortlist ?? parsed.sectionA ?? []) as ShortlistEntry[];
  const b = (parsed.section_b_not_advancing ?? parsed.sectionB ?? []) as NotAdvancingEntry[];
  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new Error("Model response did not contain both sections as arrays.");
  }
  return {
    a: a.map((e) => ({
      ...e,
      what_to_probe: Array.isArray(e.what_to_probe)
        ? e.what_to_probe
        : [String(e.what_to_probe ?? "")].filter(Boolean),
      ...splitSecondary(e),
    })),
    b,
  };
}

const RANKED: Signal[] = ["ABSENT", "PARTIAL", "STRONG"];

/**
 * STEP 3 asks for two assessments — self-initiated fixes, and a hard call —
 * and says to "Score each". So a model may legitimately answer with an object
 * of two scores rather than one string, and the triage run did exactly that
 * while the PM and SPM runs returned a string.
 *
 * Both are kept. The headline is the stronger of the two, because the question
 * is whether the candidate has shown either trait; the breakdown is prepended
 * to the evidence so nothing is hidden behind that single word. No numbers are
 * blended — the grading stays three named levels.
 */
function splitSecondary(e: ShortlistEntry): Partial<ShortlistEntry> {
  const raw = e.secondary_signal as unknown;
  if (typeof raw === "string" || raw == null) return {};
  if (typeof raw !== "object") return { secondary_signal: String(raw) as Signal };

  const parts = Object.entries(raw as Record<string, unknown>)
    .map(([k, v]) => [k.replace(/_/g, " "), String(v).toUpperCase()] as const)
    .filter(([, v]) => RANKED.includes(v as Signal));

  if (parts.length === 0) return { secondary_signal: "ABSENT" };

  const strongest = parts.reduce((best, [, v]) =>
    RANKED.indexOf(v as Signal) > RANKED.indexOf(best) ? (v as Signal) : best,
  "ABSENT" as Signal);

  const breakdown = parts.map(([k, v]) => `${k}: ${v}`).join(" · ");
  return {
    secondary_signal: strongest,
    secondary_evidence: `(${breakdown}) ${e.secondary_evidence ?? ""}`.trim(),
  };
}

export type RunResult = { run: RunFile; missing: string[] };

/**
 * RANK_STUB=1 returns a canned response instead of calling the API, so the
 * plumbing (JSON parsing, the never-drop-a-candidate check, run-file writing,
 * and the whole UI) can be exercised without spending tokens. It deliberately
 * omits one candidate so the missing-candidate path gets exercised too.
 */
function stubResponse(batch: ParsedCandidate[], role: Role): string {
  const label = ROLE_LABEL[role];
  const shortlist = batch.slice(0, Math.max(0, batch.length - 3)).map((c, i) => ({
    candidate: c.name,
    role: label,
    gate: "PASS",
    primary_signal: i === 0 ? "STRONG" : i < 3 ? "PARTIAL" : "ABSENT",
    primary_evidence: `[STUB] line from ${c.file}`,
    secondary_signal: i % 2 === 0 ? "STRONG" : "PARTIAL",
    secondary_evidence: "[STUB] evidence",
    rank: i + 1,
    why_ranked_here: "[STUB] no model call was made for this run.",
    what_to_probe: ["[STUB] probe question one.", "[STUB] probe question two."],
  }));
  const rest = batch.slice(Math.max(0, batch.length - 3));
  const notAdvancing = rest.slice(0, 2).map((c, i) => ({
    candidate: c.name,
    role: label,
    status: i === 0 ? "GATE_FAILED" : "RANKED_BUT_NOT_SHORTLISTED",
    reason: "[STUB] no model call was made for this run.",
  }));
  return JSON.stringify({ section_a_shortlist: shortlist, section_b_not_advancing: notAdvancing });
}

export async function runBatch(role: Role, candidates: ParsedCandidate[]): Promise<RunResult> {
  const stub = process.env.RANK_STUB === "1";
  if (!stub && !hasKey()) {
    throw new Error("No model API key is set (ANTHROPIC_API_KEY or GEMINI_API_KEY).");
  }

  const batch = candidates.filter((c) => c.role === role).slice(0, BATCH_CAP);
  if (batch.length === 0) throw new Error(`No parsed CVs for ${ROLE_LABEL[role]}.`);

  const triage = role === "OPEN";
  const hires = await loadHires();

  let userMessage: string;
  if (triage) {
    const [pm, spm] = await Promise.all([loadJd("PM"), loadJd("SPM")]);
    userMessage = buildTriageMessage({ PM: pm, SPM: spm }, hires, batch);
  } else {
    userMessage = buildUserMessage(await loadJd(role), hires, batch, role);
  }

  const text = stub
    ? stubResponse(batch, role)
    : await generateText({
        system: triage ? TRIAGE_SYSTEM_PROMPT : RANKING_SYSTEM_PROMPT,
        prompt: userMessage,
        // Triage adds a role call and rationale per candidate on top of
        // everything the normal run produces.
        maxTokens: triage ? 24000 : 16000,
        tier: "ranking",
      });

  const { a, b } = parseJson(text);

  // The prompt says no candidate is ever silently dropped. Enforce it here too,
  // rather than trusting the model to have obeyed.
  const named = new Set([...a.map((e) => e.candidate), ...b.map((e) => e.candidate)].map(norm));
  const missing = batch.filter((c) => !named.has(norm(c.name))).map((c) => c.name);

  const notAdvancing: NotAdvancingEntry[] = [
    ...b,
    ...missing.map<NotAdvancingEntry>((name) => ({
      candidate: name,
      role: ROLE_LABEL[role],
      status: "RANKED_BUT_NOT_SHORTLISTED",
      reason:
        "Not returned by the ranking run — no assessment was produced for this CV. Review it manually before deciding.",
    })),
  ];

  const shortlist = [...a]
    .sort((x, y) => (x.rank ?? 999) - (y.rank ?? 999))
    .map((e, i) => ({ ...e, rank: i + 1 }));

  const candidateIds: Record<string, string> = {};
  for (const c of batch) candidateIds[norm(c.name)] = c.id;

  const run: RunFile = {
    runId: `${role}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    role,
    createdAt: new Date().toISOString(),
    model: stub ? "STUB — no model call" : modelLabel("ranking"),
    batchTotal: batch.length,
    candidateIds,
    shortlist,
    notAdvancing,
  };

  await saveRun(run);

  return { run, missing };
}

export function norm(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}
