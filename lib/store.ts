import fs from "fs/promises";
import path from "path";
import { DECISIONS_FILE, PARSED_FILE, RUNS_DIR, type Role } from "./paths";
import type { Decision, DecisionsFile, ParsedCandidate, RunFile } from "./types";

/**
 * Everything the app writes at runtime goes through here.
 *
 * Local development uses the JSON files under data/. Vercel's filesystem is
 * read-only apart from /tmp, which is per-invocation and not shared between
 * instances, so a deployed build must use Postgres (Neon) or decisions would
 * silently vanish between requests.
 *
 * The CVs, job descriptions and calibration profiles are NOT in here. They are
 * read-only at runtime and ship inside the repo (see outputFileTracingIncludes
 * in next.config.ts, without which they are missing in production).
 */

export type Backend = "file" | "postgres";

export function backend(): Backend {
  return process.env.DATABASE_URL ? "postgres" : "file";
}

async function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const { neon } = await import("@neondatabase/serverless");
  return neon(url);
}

/* ------------------------------------------------------------------ parsed */

type CandidateRow = {
  id: string;
  name: string;
  role: Role;
  file: string;
  format: string;
  chars: number;
  text: string;
  parse_error: string | null;
};

const toCandidate = (r: CandidateRow): ParsedCandidate => ({
  id: r.id,
  name: r.name,
  role: r.role,
  file: r.file,
  format: r.format as ParsedCandidate["format"],
  chars: r.chars,
  text: r.text,
  ...(r.parse_error ? { parseError: r.parse_error } : {}),
});

export async function saveParsed(items: ParsedCandidate[]): Promise<void> {
  if (backend() === "file") {
    await fs.mkdir(path.dirname(PARSED_FILE), { recursive: true });
    await fs.writeFile(PARSED_FILE, JSON.stringify(items, null, 2), "utf8");
    return;
  }
  const sql = await db();
  // One statement for the whole batch: unnest the column arrays into rows.
  await sql`
    insert into candidates (id, name, role, file, format, chars, text, parse_error, ingested_at)
    select * from unnest(
      ${items.map((c) => c.id)}::text[],
      ${items.map((c) => c.name)}::text[],
      ${items.map((c) => c.role)}::text[],
      ${items.map((c) => c.file)}::text[],
      ${items.map((c) => c.format)}::text[],
      ${items.map((c) => c.chars)}::int[],
      ${items.map((c) => c.text)}::text[],
      ${items.map((c) => c.parseError ?? null)}::text[]
    ) as t(id, name, role, file, format, chars, text, parse_error), now()
    on conflict (id) do update set
      name = excluded.name, role = excluded.role, file = excluded.file,
      format = excluded.format, chars = excluded.chars, text = excluded.text,
      parse_error = excluded.parse_error, ingested_at = now()
  `;
}

export async function loadParsed(): Promise<ParsedCandidate[]> {
  if (backend() === "file") {
    try {
      return JSON.parse(await fs.readFile(PARSED_FILE, "utf8")) as ParsedCandidate[];
    } catch {
      return [];
    }
  }
  const sql = await db();
  const rows = (await sql`select * from candidates order by name`) as CandidateRow[];
  return rows.map(toCandidate);
}

/* -------------------------------------------------------------------- runs */

type RunRow = {
  run_id: string;
  role: Role;
  created_at: string | Date;
  model: string;
  batch_total: number;
  candidate_ids: Record<string, string>;
  shortlist: RunFile["shortlist"];
  not_advancing: RunFile["notAdvancing"];
};

const toRun = (r: RunRow): RunFile => ({
  runId: r.run_id,
  role: r.role,
  createdAt: new Date(r.created_at).toISOString(),
  model: r.model,
  batchTotal: r.batch_total,
  candidateIds: r.candidate_ids,
  shortlist: r.shortlist,
  notAdvancing: r.not_advancing,
});

export async function saveRun(run: RunFile): Promise<void> {
  if (backend() === "file") {
    await fs.mkdir(RUNS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(RUNS_DIR, `${run.runId}.json`),
      JSON.stringify(run, null, 2),
      "utf8",
    );
    return;
  }
  const sql = await db();
  await sql`
    insert into runs (run_id, role, created_at, model, batch_total, candidate_ids, shortlist, not_advancing)
    values (
      ${run.runId}, ${run.role}, ${run.createdAt}, ${run.model}, ${run.batchTotal},
      ${JSON.stringify(run.candidateIds)}::jsonb,
      ${JSON.stringify(run.shortlist)}::jsonb,
      ${JSON.stringify(run.notAdvancing)}::jsonb
    )
    on conflict (run_id) do update set
      model = excluded.model, batch_total = excluded.batch_total,
      candidate_ids = excluded.candidate_ids, shortlist = excluded.shortlist,
      not_advancing = excluded.not_advancing
  `;
}

export async function loadLatestRun(role: Role): Promise<RunFile | null> {
  if (backend() === "file") {
    const files = (await fs.readdir(RUNS_DIR).catch(() => [] as string[]))
      .filter((f) => f.startsWith(`${role}-`) && f.endsWith(".json"))
      .sort();
    const last = files[files.length - 1];
    if (!last) return null;
    return JSON.parse(await fs.readFile(path.join(RUNS_DIR, last), "utf8")) as RunFile;
  }
  const sql = await db();
  const rows = (await sql`
    select * from runs where role = ${role} order by created_at desc limit 1
  `) as RunRow[];
  return rows[0] ? toRun(rows[0]) : null;
}

/* --------------------------------------------------------------- decisions */

type DecisionRow = {
  candidate_id: string;
  candidate: string;
  role: Role;
  run_id: string;
  status: Decision["status"];
  decided_at: string | Date;
  email: string | null;
  comms: Decision["comms"];
};

const toDecision = (r: DecisionRow): Decision => ({
  candidateId: r.candidate_id,
  candidate: r.candidate,
  role: r.role,
  runId: r.run_id,
  status: r.status,
  decidedAt: new Date(r.decided_at).toISOString(),
  email: r.email ?? undefined,
  comms: r.comms,
});

/**
 * File writes are serialised through a promise chain and go via a temp file, so
 * a second click while the first is still writing cannot leave a half-written
 * record. Postgres upserts are atomic per row and need no such guard.
 */
let queue: Promise<unknown> = Promise.resolve();

export async function loadDecisions(): Promise<DecisionsFile> {
  if (backend() === "file") {
    try {
      return JSON.parse(await fs.readFile(DECISIONS_FILE, "utf8")) as DecisionsFile;
    } catch {
      return {};
    }
  }
  const sql = await db();
  const rows = (await sql`select * from decisions`) as DecisionRow[];
  const out: DecisionsFile = {};
  for (const row of rows) out[row.candidate_id] = toDecision(row);
  return out;
}

export async function loadDecision(candidateId: string): Promise<Decision | null> {
  if (backend() === "file") return (await loadDecisions())[candidateId] ?? null;
  const sql = await db();
  const rows = (await sql`
    select * from decisions where candidate_id = ${candidateId} limit 1
  `) as DecisionRow[];
  return rows[0] ? toDecision(rows[0]) : null;
}

export async function saveDecision(decision: Decision): Promise<Decision> {
  if (backend() === "file") {
    const run = queue.then(async () => {
      const current = await loadDecisions();
      const next = { ...current, [decision.candidateId]: decision };
      await fs.mkdir(path.dirname(DECISIONS_FILE), { recursive: true });
      const tmp = `${DECISIONS_FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
      await fs.rename(tmp, DECISIONS_FILE);
      return decision;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  const sql = await db();
  await sql`
    insert into decisions (candidate_id, candidate, role, run_id, status, decided_at, email, comms)
    values (
      ${decision.candidateId}, ${decision.candidate}, ${decision.role}, ${decision.runId},
      ${decision.status}, ${decision.decidedAt}, ${decision.email ?? null},
      ${JSON.stringify(decision.comms)}::jsonb
    )
    on conflict (candidate_id) do update set
      candidate = excluded.candidate, role = excluded.role, run_id = excluded.run_id,
      status = excluded.status, decided_at = excluded.decided_at,
      email = excluded.email, comms = excluded.comms
  `;
  return decision;
}
