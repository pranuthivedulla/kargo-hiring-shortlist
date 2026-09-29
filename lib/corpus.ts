import fs from "fs/promises";
import path from "path";
import { HIRES_DIR, JDS_DIR, ROLE_LABEL, type Role } from "./paths";

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

export async function loadJd(role: Role): Promise<string> {
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

export async function loadHires(): Promise<string> {
  const entries = await fs.readdir(HIRES_DIR).catch(() => [] as string[]);
  const usable = entries.filter((f) => /\.(json|txt|md)$/i.test(f)).sort();
  if (usable.length === 0) {
    throw new Error("No calibration profiles found in data/hires/.");
  }
  const parts: string[] = [];
  for (const f of usable) {
    const raw = await fs.readFile(path.join(HIRES_DIR, f), "utf8");
    if (f.toLowerCase().endsWith(".json")) {
      const o = JSON.parse(raw) as Record<string, unknown>;
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
      parts.push(`--- ${f} ---\n${tidy(raw)}`);
    }
  }
  return parts.join("\n\n");
}

export async function countHires(): Promise<number> {
  const entries = await fs.readdir(HIRES_DIR).catch(() => [] as string[]);
  return entries.filter((f) => /\.(json|txt|md)$/i.test(f)).length;
}
