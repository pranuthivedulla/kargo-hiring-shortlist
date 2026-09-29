import { NextResponse } from "next/server";
import { loadDecision, saveDecision } from "@/lib/store";
import { sendEmail, sendOverride } from "@/lib/comms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The confirm step. Reached only from the dialog Arjun sees after deciding, and
 * only for a decision already recorded. `send: false` records that he handled
 * the candidate another way, so nobody is left with no record.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      candidateId?: unknown;
      send?: unknown;
      email?: unknown;
      subject?: unknown;
      body?: unknown;
    };

    if (typeof body.candidateId !== "string") {
      return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
    }

    const decision = await loadDecision(body.candidateId);
    if (!decision) {
      return NextResponse.json(
        { error: "No decision has been recorded for this candidate. Decide first." },
        { status: 404 },
      );
    }
    if (decision.comms.state === "sent") {
      return NextResponse.json(
        { error: `A message has already been sent to ${decision.candidate}.` },
        { status: 409 },
      );
    }

    // The override wins over anything the dialog posted. Editing the recipient
    // field must not be a way round it.
    const override = sendOverride();
    const to = override ?? (typeof body.email === "string" ? body.email.trim() : (decision.email ?? ""));
    const subject = typeof body.subject === "string" ? body.subject : (decision.comms.subject ?? "");
    const text = typeof body.body === "string" ? body.body : (decision.comms.body ?? "");

    if (body.send !== true) {
      const updated = await saveDecision({
        ...decision,
        email: to || undefined,
        comms: { ...decision.comms, state: "skipped", subject, body: text, error: undefined },
      });
      return NextResponse.json({ decision: updated, sent: false });
    }

    if (!to) return NextResponse.json({ error: "No email address to send to." }, { status: 400 });

    try {
      const id = await sendEmail(to, subject, text);
      const updated = await saveDecision({
        ...decision,
        email: to,
        comms: {
          ...decision.comms,
          state: "sent",
          sentAt: new Date().toISOString(),
          subject,
          body: text,
          error: undefined,
        },
      });
      return NextResponse.json({ decision: updated, sent: true, messageId: id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The decision stays recorded; only the send is marked failed, so it can
      // be retried from the same dialog without re-deciding.
      await saveDecision({
        ...decision,
        email: to,
        comms: { ...decision.comms, state: "failed", subject, body: text, error: message },
      });
      return NextResponse.json({ error: message }, { status: 502 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
