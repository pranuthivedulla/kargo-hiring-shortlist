import fs from "fs/promises";
import path from "path";
import { HIRES_DIR, JDS_DIR, ROLE_LABEL, type NamedRole } from "./paths";

/**
 * Job descriptions and calibration profiles are read straight off disk on every
 * run, so replacing the files in data/ is all it takes to recalibrate.
 */

async function readDoc(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(doc, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : text;
  }
  if (ext === ".docx") {
    const mammoth = (await import("mammoth")).default;
    return (await mammoth.extractRawText({ buffer: buf })).value;
  }
  return buf.toString("utf8");
}

function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function loadJd(role: NamedRole): Promise<string> {
  const entries = await fs.readdir(JDS_DIR).catch(() => [] as string[]);
  // "Senior Product Manager" also contains "PM" and "Product", so the senior
  // test has to run first and the PM test has to exclude it.
  const isSenior = (f: string) => /senior|spm/i.test(f);
  const match = entries.find((f) =>
    role === "SPM" ? isSenior(f) : !isSenior(f) && /pm|product/i.test(f),
  );
  if (!match) {
    throw new Error(
      `No job description found for ${ROLE_LABEL[role]} in data/jds/. Expected a file named PM.* or SPM.*`,
    );
  }
  return tidy(await readDoc(path.join(JDS_DIR, match)));
}

type Outcome = { cv: string; name: string; role: string; joined: string; rating: string };

/**
 * outcomes.json pairs each past hire's CV with the role, join date and last
 * rating from the case brief. The brief supplies no interview notes, so the
 * calibration signal is "this application led to this outcome" — nothing is
 * invented to fill the gap.
 */
export async function loadHires(): Promise<string> {
  const entries = await fs.readdir(HIRES_DIR).catch(() => [] as string[]);

  let outcomes: Outcome[] = [];
  if (entries.includes("outcomes.json")) {
    const raw = JSON.parse(await fs.readFile(path.join(HIRES_DIR, "outcomes.json"), "utf8")) as {
      hires?: Outcome[];
    };
    outcomes = raw.hires ?? [];
  }

  const parts: string[] = [];

  for (const o of outcomes) {
    let cv = "[CV file not found]";
    try {
      cv = tidy(await readDoc(path.join(HIRES_DIR, o.cv)));
    } catch {
      /* keep the placeholder; a missing CV must not fail the whole run */
    }
    parts.push(
      [
        `--- ${o.name} ---`,
        `Role hired into: ${o.role}`,
        `Joined: ${o.joined}`,
        `Last performance rating: ${o.rating}`,
        "",
        "The application they were hired from:",
        cv,
      ].join("\n"),
    );
  }

  // Anything else in the folder, for corpora that are not CV-plus-outcome.
  const claimed = new Set(outcomes.map((o) => o.cv));
  for (const f of entries.sort()) {
    if (f === "outcomes.json" || claimed.has(f)) continue;
    if (!/\.(json|txt|md|docx|pdf)$/i.test(f)) continue;
    const full = path.join(HIRES_DIR, f);

    if (f.toLowerCase().endsWith(".json")) {
      const o = JSON.parse(await fs.readFile(full, "utf8")) as Record<string, unknown>;
      const line = (k: string, label: string) => (o[k] ? `${label}: ${String(o[k])}` : null);
      parts.push(
        [
          `--- ${o.name ?? f} ---`,
          line("role", "Role hired into"),
          line("joined", "Joined"),
          line("rating", "Last rating"),
          line("stood_out", "What stood out in the application"),
          line("interview", "What the interview revealed"),
          line("outcome", "Outcome note"),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } else {
      parts.push(`--- ${f} ---\n${tidy(await readDoc(full))}`);
    }
  }

  if (parts.length === 0) throw new Error("No calibration profiles found in data/hires/.");
  return parts.join("\n\n");
}

export async function countHires(): Promise<number> {
  const entries = await fs.readdir(HIRES_DIR).catch(() => [] as string[]);
  return entries.filter((f) => /\.(json|txt|md|docx|pdf)$/i.test(f) && f !== "outcomes.json").length;
}
