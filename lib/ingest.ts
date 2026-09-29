import fs from "fs/promises";
import path from "path";
import { APPLICATIONS_DIR, type Role } from "./paths";
import type { ParsedCandidate } from "./types";

const SUPPORTED = new Set([".pdf", ".docx", ".txt", ".md"]);

/** Collapse the whitespace PDF extraction leaves behind, without losing line structure. */
function normalize(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdf(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(doc, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

async function extractDocx(buf: Buffer): Promise<string> {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value;
}

const SEPARATORS = /[\\/]/;

/**
 * Role comes from the directory a CV sits in (data/applications/PM/...), falling
 * back to a PM/SPM token in the filename. Anything else is left unresolved so it
 * surfaces as a parse problem rather than being silently filed under one role.
 */
function detectRole(relPath: string): Role | null {
  const segments = relPath.split(SEPARATORS);
  const dir = segments.slice(0, -1).map((s) => s.toUpperCase().replace(/[_ ]+/g, "-"));
  if (dir.includes("SPM") || dir.includes("SENIOR-PRODUCT-MANAGER")) return "SPM";
  if (dir.includes("PM") || dir.includes("PRODUCT-MANAGER")) return "PM";
  // An explicit "no role stated" pile, gated against both JDs later.
  if (dir.includes("OPEN") || dir.includes("UNASSIGNED")) return "OPEN";

  const base = segments[segments.length - 1].toUpperCase();
  if (/(^|[^A-Z])(SPM|SENIOR[_ -]?PRODUCT)/.test(base)) return "SPM";
  if (/(^|[^A-Z])(PM|PRODUCT[_ -]?MANAGER)/.test(base)) return "PM";
  return null;
}

/** Candidate name from the filename, with the role tag and separators stripped. */
function nameFromFile(relPath: string): string {
  const base = path.basename(relPath, path.extname(relPath));
  const cleaned = base
    // Separators first: a word boundary does not fire between "_" and a letter,
    // so "Ananya_Rao_PM" would otherwise keep its role tag.
    .replace(/[_\-.]+/g, " ")
    .replace(/\b(SPM|PM|CV|Resume|Senior Product Manager|Product Manager)\b/gi, " ")
    // Course filenames carry an index: "pm_01_priya_krishnan", "29_rohan_basu".
    // Without this, every candidate is listed as "01 Priya Krishnan".
    .replace(/^\s*\d{1,3}\b\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    // Filenames are lower case; these are shown as names in the dashboard.
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return cleaned || base;
}

function slugId(relPath: string): string {
  return relPath
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

async function walk(dir: string, base = dir): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else if (SUPPORTED.has(path.extname(e.name).toLowerCase())) {
      out.push(path.relative(base, full));
    }
  }
  return out.sort();
}

export async function ingestApplications(): Promise<ParsedCandidate[]> {
  const files = await walk(APPLICATIONS_DIR);
  const parsed: ParsedCandidate[] = [];

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase().slice(1) as ParsedCandidate["format"];
    const role = detectRole(rel);
    const entry: ParsedCandidate = {
      id: slugId(rel),
      name: nameFromFile(rel),
      role: role ?? "OPEN",
      file: rel,
      format: ext,
      chars: 0,
      text: "",
    };
    if (!role) {
      entry.role = "OPEN";
      entry.parseError =
        "No role could be determined from the folder or filename; treated as role-not-stated.";
    }

    try {
      const buf = await fs.readFile(path.join(APPLICATIONS_DIR, rel));
      let raw: string;
      if (ext === "pdf") raw = await extractPdf(buf);
      else if (ext === "docx") raw = await extractDocx(buf);
      else raw = buf.toString("utf8");

      entry.text = normalize(raw);
      entry.chars = entry.text.length;
      if (entry.chars < 200) {
        entry.parseError = `Only ${entry.chars} characters extracted — likely a scanned or image-only file.`;
      }
    } catch (err) {
      entry.parseError = `Extraction failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    parsed.push(entry);
  }

  return parsed;
}
