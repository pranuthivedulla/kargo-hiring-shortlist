import { NextResponse } from "next/server";
import { ingestApplications } from "@/lib/ingest";
import { loadParsed, saveParsed } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function summarize(items: Awaited<ReturnType<typeof loadParsed>>) {
  return {
    total: items.length,
    byRole: {
      PM: items.filter((i) => i.role === "PM").length,
      SPM: items.filter((i) => i.role === "SPM").length,
    },
    problems: items
      .filter((i) => i.parseError)
      .map((i) => ({ name: i.name, file: i.file, error: i.parseError })),
    candidates: items.map(({ id, name, role, file, format, chars, parseError }) => ({
      id,
      name,
      role,
      file,
      format,
      chars,
      parseError,
    })),
  };
}

export async function GET() {
  return NextResponse.json(summarize(await loadParsed()));
}

export async function POST() {
  try {
    const items = await ingestApplications();
    await saveParsed(items);
    return NextResponse.json(summarize(items));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
