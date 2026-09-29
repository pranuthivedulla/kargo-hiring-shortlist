import { NextResponse } from "next/server";
import { ingestApplications } from "@/lib/ingest";
import { BATCH_CAP, runBatch } from "@/lib/rank";
import { loadDecisions, loadLatestRun, loadParsed, saveParsed } from "@/lib/store";
import { ROLES, type Role } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as string[]).includes(v);
}

/** Read the stored run for a role — never triggers a model call. */
export async function GET(req: Request) {
  const role = new URL(req.url).searchParams.get("role");
  if (!isRole(role)) return NextResponse.json({ error: "role must be PM or SPM" }, { status: 400 });

  const [run, decisions, parsed] = await Promise.all([
    loadLatestRun(role),
    loadDecisions(),
    loadParsed(),
  ]);
  return NextResponse.json({
    run,
    decisions,
    available: parsed.filter((p) => p.role === role).length,
    batchCap: BATCH_CAP,
  });
}

/** Run a batch. Only ever fires from Arjun's "Run batch" click. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { role?: unknown };
    if (!isRole(body.role)) {
      return NextResponse.json({ error: "role must be PM or SPM" }, { status: 400 });
    }

    // Re-ingest first so a CV dropped into data/applications since the last run
    // is included without a separate step.
    const parsed = await ingestApplications();
    await saveParsed(parsed);

    const { run, missing } = await runBatch(body.role, parsed);
    return NextResponse.json({ run, missing });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
