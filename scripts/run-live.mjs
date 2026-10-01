/**
 * Run the real batches against the live model, writing to whatever storage
 * DATABASE_URL points at. Run from a laptop: a full-size batch takes minutes
 * and would exceed any serverless function limit.
 *
 *   npx tsx scripts/run-live.mjs            # PM, SPM, OPEN
 *   npx tsx scripts/run-live.mjs PM SPM     # only those
 */
import { loadEnv } from "./load-env.mjs";

loadEnv();

const { ingestApplications } = await import("../lib/ingest.ts");
const { saveParsed, allCandidates, backend } = await import("../lib/store.ts");
const { runBatch, BATCH_CAP } = await import("../lib/rank.ts");

const roles = process.argv.slice(2).length ? process.argv.slice(2) : ["PM", "SPM", "OPEN"];

console.log(`storage: ${backend()}`);
console.log(`roles  : ${roles.join(", ")}\n`);

const fromDisk = await ingestApplications();
await saveParsed(fromDisk);
// Include anything uploaded through the dashboard, not just files on disk.
const parsed = await allCandidates(fromDisk);
const uploaded = parsed.length - fromDisk.length;
console.log(
  `ingested ${fromDisk.length} CVs from disk` +
    (uploaded > 0 ? `, plus ${uploaded} uploaded\n` : "\n"),
);

const timings = [];

for (const role of roles) {
  const inBatch = parsed.filter((p) => p.role === role);
  if (!inBatch.length) {
    console.log(`--- ${role}: no CVs, skipping ---\n`);
    continue;
  }

  process.stdout.write(`${role}: ${inBatch.length} CVs → calling model… `);
  const t0 = Date.now();
  let run, missing;
  try {
    ({ run, missing } = await runBatch(role, parsed));
  } catch (err) {
    console.log(`FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.error(`  ${err.message}\n`);
    continue;
  }
  const secs = (Date.now() - t0) / 1000;
  timings.push({ role, cvs: inBatch.length, secs });
  console.log(`${secs.toFixed(1)}s`);

  const truncated = inBatch.length > BATCH_CAP ? ` (CAPPED at ${BATCH_CAP})` : "";
  console.log(
    `  shortlist ${run.shortlist.length} | not advancing ${run.notAdvancing.length} | ` +
      `accounted for ${run.shortlist.length + run.notAdvancing.length}/${inBatch.length}${truncated}`,
  );
  if (missing.length) console.log(`  RECOVERED (model omitted): ${missing.join(", ")}`);

  for (const e of run.shortlist) {
    const rec = e.recommended_role ? ` [${e.recommended_role}]` : "";
    console.log(
      `   ${String(e.rank).padStart(2)}. ${e.candidate.padEnd(22)} P:${String(e.primary_signal).padEnd(7)} S:${String(e.secondary_signal).padEnd(7)}${rec}`,
    );
  }
  for (const e of run.notAdvancing) {
    const rec = e.recommended_role ? ` [${e.recommended_role}]` : "";
    console.log(`    -  ${e.candidate.padEnd(22)} ${e.status}${rec}`);
  }
  console.log();
}

console.log("=== timings ===");
for (const t of timings) {
  console.log(`  ${t.role.padEnd(5)} ${String(t.cvs).padStart(2)} CVs  ${t.secs.toFixed(1)}s  (${(t.secs / t.cvs).toFixed(1)}s per CV)`);
}
const worst = Math.max(0, ...timings.map((t) => t.secs));
console.log(`\nlongest batch: ${worst.toFixed(1)}s`);
console.log(
  worst > 60
    ? "  -> exceeds Vercel Hobby's 60s function limit. Batches must run from the CLI."
    : "  -> within Vercel Hobby's 60s limit.",
);
