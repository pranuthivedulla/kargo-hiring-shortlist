import { ingestApplications } from "../lib/ingest.ts";
const items = await ingestApplications();
const by = (r) => items.filter((i) => i.role === r);
console.log(`total ${items.length}  |  PM ${by("PM").length}  SPM ${by("SPM").length}  OPEN ${by("OPEN").length}`);
for (const r of ["PM", "SPM", "OPEN"]) {
  console.log(`\n--- ${r} (first 4 of ${by(r).length}) ---`);
  for (const i of by(r).slice(0, 4)) console.log(`  ${String(i.chars).padStart(6)}  ${i.name}`);
}
const bad = items.filter((i) => i.parseError);
console.log(`\nparse problems: ${bad.length}`);
for (const b of bad) console.log(`  ${b.file} — ${b.parseError}`);
