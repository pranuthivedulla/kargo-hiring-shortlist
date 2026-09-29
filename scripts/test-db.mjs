/**
 * Exercises the Postgres backend end to end against the real database.
 * No model calls (RANK_STUB=1), no emails. Cleans up after itself.
 *
 *   npx tsx scripts/test-db.mjs
 */
import { loadEnv } from "./load-env.mjs";
loadEnv();
process.env.RANK_STUB = "1";

const { ingestApplications } = await import("../lib/ingest.ts");
const { runBatch } = await import("../lib/rank.ts");
const store = await import("../lib/store.ts");

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

console.log(`backend: ${store.backend()}\n`);
if (store.backend() !== "postgres") {
  console.error("DATABASE_URL is not set — this test needs the real database.");
  process.exit(1);
}

// --- candidates round-trip -------------------------------------------------
const parsed = await ingestApplications();
await store.saveParsed(parsed);
const reloaded = await store.loadParsed();

check("every parsed CV persisted", reloaded.length === parsed.length, `${reloaded.length}/${parsed.length}`);
const ananya = reloaded.find((c) => c.name === "Ananya Rao");
check("CV text survived the round trip", !!ananya && ananya.text.includes("Jeena & Company"));
check("role survived", ananya?.role === "PM");
const scan = reloaded.find((c) => c.name === "Imran Qureshi");
check("parseError survived", !!scan?.parseError, scan?.parseError?.slice(0, 40));

// Re-saving must update, not duplicate.
await store.saveParsed(parsed);
check("re-ingest upserts rather than duplicating", (await store.loadParsed()).length === parsed.length);

// --- runs round-trip -------------------------------------------------------
const { run } = await runBatch("PM", parsed);
const latest = await store.loadLatestRun("PM");
check("run persisted and is newest", latest?.runId === run.runId);
check("shortlist survived as JSON", latest?.shortlist.length === run.shortlist.length);
check("nested evidence survived", typeof latest?.shortlist[0]?.primary_evidence === "string");
check("what_to_probe stayed an array", Array.isArray(latest?.shortlist[0]?.what_to_probe));
check("candidateIds map survived", Object.keys(latest?.candidateIds ?? {}).length > 0);
check("notAdvancing survived", latest?.notAdvancing.length === run.notAdvancing.length);

const spmBefore = await store.loadLatestRun("SPM");
check("roles are isolated (no SPM run yet)", spmBefore === null);

// --- decisions round-trip --------------------------------------------------
const target = run.shortlist[0].candidate;
const id = run.candidateIds[target.toLowerCase().trim()];
const decision = {
  candidateId: id,
  candidate: target,
  role: "PM",
  runId: run.runId,
  status: "advanced",
  decidedAt: new Date().toISOString(),
  email: "test@example.com",
  comms: { state: "pending", subject: "S", body: "B", bookingUrl: "https://example.com/x" },
};
await store.saveDecision(decision);

const one = await store.loadDecision(id);
check("decision persisted", one?.candidate === target);
check("comms jsonb survived", one?.comms.bookingUrl === "https://example.com/x");
check("decision appears in the map", !!(await store.loadDecisions())[id]);

// The send step upserts the same row; it must not create a second one.
await store.saveDecision({ ...decision, comms: { ...decision.comms, state: "sent" } });
const after = await store.loadDecisions();
check("send updates in place, no duplicate row", Object.keys(after).length === 1);
check("state advanced to sent", after[id].comms.state === "sent");

// --- cleanup ---------------------------------------------------------------
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);
await sql`delete from decisions`;
await sql`delete from runs`;
await sql`delete from candidates`;
const [{ n }] = await sql`select (select count(*) from decisions) + (select count(*) from runs) + (select count(*) from candidates) as n`;
check("test data cleaned up", Number(n) === 0);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
