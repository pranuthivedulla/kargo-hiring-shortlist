import { NextResponse } from "next/server";
import { parseUpload } from "@/lib/ingest";
import { loadParsed, saveParsed } from "@/lib/store";
import { ROLES, type Role } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Enough for a CV; stops a large file from being parsed at all. */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 30;

/**
 * Accepts CV files from the dashboard and writes their extracted text to the
 * store, so candidates can be added without a developer, a git commit or a
 * redeploy.
 *
 * Only the text is kept. The original file is never read again after parsing —
 * ranking and the email address both come from the text — so there is no need
 * for blob storage, which matters on a platform with a read-only filesystem.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: "Expected a multipart form upload." }, { status: 400 });
    }

    const roleField = form.get("role");
    const role: Role | "AUTO" =
      typeof roleField === "string" && (ROLES as string[]).includes(roleField)
        ? (roleField as Role)
        : "AUTO";

    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return NextResponse.json({ error: "No files were included." }, { status: 400 });
    }
    if (files.length > MAX_FILES) {
      return NextResponse.json(
        { error: `At most ${MAX_FILES} files at a time; ${files.length} were sent.` },
        { status: 400 },
      );
    }

    const existing = await loadParsed();
    const byId = new Map(existing.map((c) => [c.id, c]));

    const accepted: { name: string; role: Role; chars: number; replaced: boolean }[] = [];
    const rejected: { name: string; reason: string }[] = [];

    for (const file of files) {
      if (file.size > MAX_BYTES) {
        rejected.push({ name: file.name, reason: `Larger than ${MAX_BYTES / 1024 / 1024}MB.` });
        continue;
      }
      try {
        const buf = Buffer.from(await file.arrayBuffer());
        const parsed = await parseUpload(file.name, buf, role === "AUTO" ? null : role);
        const replaced = byId.has(parsed.id);
        byId.set(parsed.id, parsed);
        accepted.push({
          name: parsed.name,
          role: parsed.role,
          chars: parsed.chars,
          replaced,
        });
      } catch (err) {
        rejected.push({
          name: file.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (accepted.length) await saveParsed([...byId.values()]);

    return NextResponse.json({
      accepted,
      rejected,
      total: byId.size,
      // Uploading does not rank: ranking is a separate, explicit action, and a
      // full batch exceeds this platform's function limit anyway.
      note: accepted.length
        ? "Stored. Run a batch to rank these candidates."
        : "Nothing was stored.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
