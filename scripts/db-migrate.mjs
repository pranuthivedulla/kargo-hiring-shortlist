/**
 * Apply db/schema.sql to DATABASE_URL, then report what exists.
 * Safe to re-run: every statement is CREATE ... IF NOT EXISTS or OR REPLACE.
 *
 *   npx tsx scripts/db-migrate.mjs
 */
import fs from "fs";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add it to .env.local.");
  process.exit(1);
}

const { neon } = await import("@neondatabase/serverless");
const sql = neon(url);

const source = fs.readFileSync("db/schema.sql", "utf8");

// Split on semicolons that end a statement, but keep $$-quoted function bodies
// (the touch_updated_at trigger function) in one piece.
const statements = [];
let buffer = "";
let inDollar = false;
for (const line of source.split(/\r?\n/)) {
  if (/\$\$/.test(line)) {
    const marks = (line.match(/\$\$/g) || []).length;
    if (marks % 2 === 1) inDollar = !inDollar;
  }
  buffer += line + "\n";
  if (!inDollar && /;\s*$/.test(line)) {
    if (hasSql(buffer)) statements.push(buffer.trim());
    buffer = "";
  }
}
if (hasSql(buffer)) statements.push(buffer.trim());

/**
 * Every statement in schema.sql is preceded by a comment banner, so testing
 * whether the buffer *starts* with "--" would discard all of them. Strip the
 * comment lines and see whether anything is left.
 */
function hasSql(chunk) {
  return chunk
    .split(/\r?\n/)
    .filter((l) => !/^\s*--/.test(l) && l.trim() !== "")
    .join("")
    .trim().length > 0;
}

console.log(`applying ${statements.length} statements from db/schema.sql\n`);
for (const stmt of statements) {
  const label = stmt.replace(/\s+/g, " ").slice(0, 70);
  try {
    await sql.query(stmt);
    console.log(`  ok   ${label}`);
  } catch (err) {
    console.error(`  FAIL ${label}\n       ${err.message}`);
    process.exit(1);
  }
}

console.log("\n--- tables now present ---");
const tables = await sql`
  select table_name from information_schema.tables
  where table_schema = 'public' order by table_name
`;
for (const t of tables) {
  const [{ n }] = await sql.query(`select count(*)::int as n from ${t.table_name}`);
  console.log(`  ${t.table_name.padEnd(14)} ${n} rows`);
}
