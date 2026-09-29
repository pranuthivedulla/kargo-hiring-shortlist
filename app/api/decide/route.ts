import { NextResponse } from "next/server";
import { loadDecision, loadDecisions, loadLatestRun, saveDecision } from "@/lib/store";
import { createBookingLink, draftMessage, emailFromCv, subjectFor } from "@/lib/comms";
import { ROLES, type Role } from "@/lib/paths";
import type { Decision, DecisionStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as string[]).includes(v);
const isStatus = (v: unknown): v is DecisionStatus => v === "advanced" || v === "rejected";

export async function GET() {
  return NextResponse.json(await loadDecisions());
}

/**
 * Arjun's click. This is the ONLY thing that changes a candidate's status, and
 * the only thing that produces a draft or a booking link. It does not send.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      candidateId?: unknown;
      candidate?: unknown;
      role?: unknown;
      status?: unknown;
    };

    if (typeof body.candidateId !== "string" || !body.candidateId.trim()) {
      return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
    }
    if (typeof body.candidate !== "string" || !body.candidate.trim()) {
      return NextResponse.json({ error: "candidate is required" }, { status: 400 });
    }
    if (!isRole(body.role)) return NextResponse.json({ error: "role must be PM or SPM" }, { status: 400 });
    if (!isStatus(body.status)) {
      return NextResponse.json({ error: "status must be advanced or rejected" }, { status: 400 });
    }

    const { candidateId, candidate, role, status } = body;

    const existing = await loadDecision(candidateId);
    if (existing && existing.comms.state === "sent") {
      return NextResponse.json(
        { error: `${candidate} was already ${existing.status} and the message has been sent.` },
        { status: 409 },
      );
    }

    const email = await emailFromCv(candidateId);

    let bookingUrl: string | null = null;
    let commsError: string | undefined;
    if (status === "advanced") {
      const link = await createBookingLink(candidate, email);
      bookingUrl = link.url;
      if (link.error) commsError = `No booking link: ${link.error}`;
    }

    const runId = (await loadLatestRun(role))?.runId ?? "unknown";
    const decision: Decision = {
      candidateId,
      candidate,
      role,
      runId,
      status,
      decidedAt: new Date().toISOString(),
      email,
      comms: {
        state: "pending",
        draftedAt: new Date().toISOString(),
        subject: subjectFor(status, role),
        body: await draftMessage(candidate, role, status, bookingUrl),
        bookingUrl: bookingUrl ?? undefined,
        error: commsError,
      },
    };

    await saveDecision(decision);

    return NextResponse.json({ decision });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
