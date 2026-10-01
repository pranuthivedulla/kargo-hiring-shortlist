/** Upload path end to end, against the real store. Cleans up after itself. */
import { loadEnv } from "./load-env.mjs";
loadEnv();
const { parseUpload } = await import("../lib/ingest.ts");
const { loadParsed, saveParsed, allCandidates, backend } = await import("../lib/store.ts");
const fs = await import("fs/promises");

let failures = 0;
const check = (l, c, d = "") => { console.log(`${c ? "  ok  " : "  FAIL"} ${l}${d ? " — " + d : ""}`); if (!c) failures++; };

console.log(`backend: ${backend()}\n`);
const before = await loadParsed();

// A real PDF, parsed the same way an upload would be.
const buf = await fs.readFile("data/applications/PM/pm_01_priya_krishnan.pdf");

const asSpm = await parseUpload("test_upload_person.pdf", buf, "SPM");
check("parsed an uploaded PDF", asSpm.chars > 500, `${asSpm.chars} chars`);
check("explicit role wins", asSpm.role === "SPM");
check("name cleaned from filename", asSpm.name === "Test Upload Person", asSpm.name);
check("marked as uploaded", asSpm.file.startsWith("uploaded/"), asSpm.file);
check("no control characters", !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(asSpm.text));

const auto = await parseUpload("spm_99_someone.pdf", buf, null);
check("role read from filename when none given", auto.role === "SPM", auto.role);
const noRole = await parseUpload("just_a_name.pdf", buf, null);
check("falls back to OPEN", noRole.role === "OPEN");
check("and says why", !!noRole.parseError);

try { await parseUpload("notes.xlsx", buf, "PM"); check("rejects unsupported type", false); }
catch (e) { check("rejects unsupported type", /Unsupported/.test(e.message)); }

// Persist, then confirm ranking would actually see it.
await saveParsed([...before, asSpm]);
const merged = await allCandidates(before);
check("upload survives a round trip", merged.some((c) => c.id === asSpm.id));
check("ranking would include it", merged.filter((c) => c.role === "SPM").some((c) => c.id === asSpm.id));
check("existing candidates untouched", merged.length === before.length + 1, `${merged.length} vs ${before.length}`);

// Cleanup
if (backend() === "postgres") {
  const { neon } = await import("@neondatabase/serverless");
  await neon(process.env.DATABASE_URL)`delete from candidates where id = ${asSpm.id}`;
} else {
  await saveParsed(before);
}
check("cleaned up", !(await loadParsed()).some((c) => c.id === asSpm.id));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
