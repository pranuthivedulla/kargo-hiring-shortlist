/**
 * One-off repair: runs stored before splitSecondary() existed hold
 * secondary_signal as an object, which renders as "[object Object]".
 * The breakdown is already in the data, so no model call is needed.
 */
import { loadEnv } from "./load-env.mjs";
loadEnv();
const { loadLatestRun, saveRun } = await import("../lib/store.ts");

const RANKED = ["ABSENT", "PARTIAL", "STRONG"];

for (const role of ["PM", "SPM", "OPEN"]) {
  const run = await loadLatestRun(role);
  if (!run) { console.log(`${role}: no run`); continue; }

  let fixed = 0;
  run.shortlist = run.shortlist.map((e) => {
    if (typeof e.secondary_signal !== "object" || e.secondary_signal === null) return e;
    const parts = Object.entries(e.secondary_signal)
      .map(([k, v]) => [k.replace(/_/g, " "), String(v).toUpperCase()])
      .filter(([, v]) => RANKED.includes(v));
    const strongest = parts.reduce(
      (best, [, v]) => (RANKED.indexOf(v) > RANKED.indexOf(best) ? v : best),
      "ABSENT",
    );
    fixed++;
    return {
      ...e,
      secondary_signal: strongest,
      secondary_evidence: `(${parts.map(([k, v]) => `${k}: ${v}`).join(" · ")}) ${e.secondary_evidence ?? ""}`.trim(),
    };
  });

  if (fixed) { await saveRun(run); console.log(`${role}: repaired ${fixed} entries`); }
  else console.log(`${role}: nothing to fix`);
}
