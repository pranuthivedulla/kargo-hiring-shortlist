import { ingestApplications } from "../lib/ingest.ts";
import { runBatch } from "../lib/rank.ts";
import { saveParsed, loadLatestRun, backend } from "../lib/store.ts";
import { loadJd, loadHires } from "../lib/corpus.ts";

// Force the file backend. This test writes STUB runs; if it reached the real
// database the deployed site would show "[STUB] no model call was made".
delete process.env.DATABASE_URL;

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// --- corpus loading (no model call) ---
const pmJd = await loadJd("PM");
const spmJd = await loadJd("SPM");
const hires = await loadHires();

check("PM JD loaded", pmJd.length > 500, `${pmJd.length} chars`);
check("SPM JD loaded", spmJd.length > 500, `${spmJd.length} chars`);
check("PM JD is not the SPM JD", !/Senior Product Manager\s*$/m.test(pmJd.slice(0, 200)));
check("PM JD states the 2-4 year floor", /2\s*[–-]\s*4\s*years/.test(pmJd));
check("SPM JD states the 5-8 year floor", /5\s*[–-]\s*8\s*years/.test(spmJd));
check("hires corpus loaded", hires.length > 1000, `${hires.length} chars`);
check("hires include a Below Expectations outcome", /Below Expectations/.test(hires));
check("hires include a Meets Expectations outcome", /Meets Expectations/.test(hires));

// --- stubbed batch run ---
process.env.RANK_STUB = "1";
console.log(`
storage backend: ${backend()}`);
const parsed = await ingestApplications();
await saveParsed(parsed);

for (const role of ["PM", "SPM"]) {
  const inBatch = parsed.filter((p) => p.role === role);
  const { run, missing } = await runBatch(role, parsed);

  console.log(`\n--- ${role} (${inBatch.length} CVs) ---`);
  check("run stored and re-readable", (await loadLatestRun(role))?.runId === run.runId);
  check("batchTotal matches the CVs for this role", run.batchTotal === inBatch.length);
  check("run is marked as a stub", run.model.includes("STUB"));

  const named = new Set([
    ...run.shortlist.map((e) => e.candidate),
    ...run.notAdvancing.map((e) => e.candidate),
  ]);
  check(
    "every candidate appears somewhere in the output",
    inBatch.every((c) => named.has(c.name)),
    `${named.size} named / ${inBatch.length} in batch`,
  );
  check(
    "the candidate the stub omitted was recovered into not-advancing",
    missing.length === 1 && run.notAdvancing.some((e) => e.candidate === missing[0]),
    `recovered: ${missing.join(", ") || "none"}`,
  );
  check(
    "ranks are contiguous from 1",
    run.shortlist.every((e, i) => e.rank === i + 1),
  );
  check(
    "what_to_probe is always an array",
    run.shortlist.every((e) => Array.isArray(e.what_to_probe) && e.what_to_probe.length > 0),
  );
  check(
    "candidateIds maps every shortlisted name to a parsed CV",
    run.shortlist.every((e) => !!run.candidateIds[e.candidate.toLowerCase().trim()]),
  );
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
