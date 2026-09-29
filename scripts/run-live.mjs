import { loadEnv } from "./load-env.mjs";
loadEnv();
const { ingestApplications } = await import("../lib/ingest.ts");
const { saveParsed } = await import("../lib/store.ts");
const { runBatch } = await import("../lib/rank.ts");

const parsed = await ingestApplications();
await saveParsed(parsed);

for (const role of ["PM", "SPM"]) {
  const t0 = Date.now();
  const { run, missing } = await runBatch(role, parsed);
  const inBatch = parsed.filter((p) => p.role === role).length;
  console.log(`\n===== ${role} — ${run.model} — ${((Date.now() - t0) / 1000).toFixed(1)}s =====`);
  console.log(`batch ${run.batchTotal} | shortlist ${run.shortlist.length} | not advancing ${run.notAdvancing.length} | total ${run.shortlist.length + run.notAdvancing.length} of ${inBatch}`);
  if (missing.length) console.log(`RECOVERED (model omitted): ${missing.join(", ")}`);
  for (const e of run.shortlist) {
    console.log(`  ${String(e.rank).padStart(2)}. ${e.candidate.padEnd(18)} P:${String(e.primary_signal).padEnd(7)} S:${e.secondary_signal}`);
  }
  for (const e of run.notAdvancing) {
    console.log(`   -  ${e.candidate.padEnd(18)} ${e.status}`);
  }
}
