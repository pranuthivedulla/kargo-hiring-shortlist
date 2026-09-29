import { loadHires, countHires, loadJd } from "../lib/corpus.ts";
const h = await loadHires();
console.log(`hire CVs: ${await countHires()} | corpus: ${h.length} chars`);
for (const r of ["PM", "SPM"]) console.log(`${r} JD: ${(await loadJd(r)).length} chars`);
console.log("\nratings found:", [...h.matchAll(/Last performance rating: (.+)/g)].map(m => m[1]).join(" | "));
console.log("\n--- first profile, first 700 chars ---\n" + h.slice(0, 700));
