import { NextResponse } from "next/server";
import fs from "fs/promises";
import { APPLICATIONS_DIR, HIRES_DIR, JDS_DIR } from "@/lib/paths";
import { loadJd } from "@/lib/corpus";
import { activeProvider, hasKey, modelName } from "@/lib/model";
import { sendOverride } from "@/lib/comms";
import { backend } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only deployment check. No model calls, no writes, no secrets returned.
 *
 * It exists because the two ways this app breaks in production are both
 * invisible from the dashboard: the data files missing from the serverless
 * bundle (they are read through `fs`, so Next's tracer cannot see them without
 * outputFileTracingIncludes), and writes failing against a read-only
 * filesystem. Both look like "nothing happens" in the UI.
 */
async function countFiles(dir: string): Promise<number> {
  async function walk(d: string): Promise<number> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return 0;
    }
    let n = 0;
    for (const e of entries) {
      n += e.isDirectory() ? await walk(`${d}/${e.name}`) : 1;
    }
    return n;
  }
  return walk(dir);
}

export async function GET() {
  const [applications, jds, hires] = await Promise.all([
    countFiles(APPLICATIONS_DIR),
    countFiles(JDS_DIR),
    countFiles(HIRES_DIR),
  ]);

  // Prove the JDs are not just present but readable and correctly matched.
  const jdCheck: Record<string, string> = {};
  for (const role of ["PM", "SPM"] as const) {
    try {
      jdCheck[role] = `ok, ${(await loadJd(role)).length} chars`;
    } catch (err) {
      jdCheck[role] = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Can this deployment persist anything? On Vercel the answer must come from
  // DATABASE_URL; the filesystem is read-only.
  let writable: string;
  if (backend() === "postgres") {
    writable = "postgres (DATABASE_URL set)";
  } else {
    try {
      const probe = `${process.cwd()}/data/.write-probe`;
      await fs.writeFile(probe, "x");
      await fs.unlink(probe);
      writable = "local filesystem";
    } catch (err) {
      writable = `NOTHING — filesystem is read-only and DATABASE_URL is not set (${
        err instanceof Error ? err.message.split(",")[0] : "error"
      }). Decisions will be lost.`;
    }
  }

  const provider = activeProvider();
  return NextResponse.json({
    ok: applications > 0 && jds > 0 && hires > 0 && !jdCheck.PM.startsWith("FAILED"),
    files: { applications, jds, hires },
    jds: jdCheck,
    model: { provider, model: modelName("ranking", provider), keyPresent: hasKey(provider) },
    storage: { backend: backend(), writable },
    email: {
      resendConfigured: !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM,
      // A deployment that can send is a deployment a stranger can send from.
      sendOverrideTo: sendOverride() ?? null,
    },
  });
}
