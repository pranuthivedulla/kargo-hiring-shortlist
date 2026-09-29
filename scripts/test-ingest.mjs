import { ingestApplications } from "../lib/ingest.ts";
import { saveParsed } from "../lib/store.ts";

const items = await ingestApplications();
await saveParsed(items);

console.log(`parsed ${items.length} files\n`);
for (const i of items) {
  const flag = i.parseError ? "  !! " + i.parseError : "";
  console.log(`${i.role.padEnd(4)} ${i.format.padEnd(5)} ${String(i.chars).padStart(5)}  ${i.name}${flag}`);
}
const bad = items.filter((i) => i.parseError);
console.log(`\nclean: ${items.length - bad.length} / ${items.length}`);
console.log("\n--- sample text (Ananya Rao) ---");
console.log(items.find((i) => i.name === "Ananya Rao")?.text.slice(0, 600));
console.log("\n--- sample text (Aditya Kulkarni, docx) ---");
console.log(items.find((i) => i.name === "Aditya Kulkarni")?.text.slice(0, 400));
