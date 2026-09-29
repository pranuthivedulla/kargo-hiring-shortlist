import { NextResponse } from "next/server";
import { loadDecision, loadDecisions, loadLatestRun, saveDecision } from "@/lib/store";
import {
  createBookingLink,
  draftMessage,
  emailFromCv,
  subjectFor,
  type BookingOffer,
} from "@/lib/comms";
import { bookingUrl, calendarConfigured, findSlots } from "@/lib/gcal";
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
/**
 * Pre-fills the invitee on booking pages that document support for it.
 *
 * Calendly does. Google Calendar Appointment Schedules do not, and their short
 * calendar.app.google links 302 to the real page, which drops query parameters
 * anyway — so adding them there would put visible, useless junk in a
 * candidate's email. Google's own form asks for name and email instead.
 */
function withInvitee(base: string, name: string, email?: string): string {
  try {
    const u = new URL(base);
    if (!/(^|\.)calendly\.com$/i.test(u.hostname)) return base;
    u.searchParams.set("name", name);
    if (email) u.searchParams.set("email", email);
    return u.toString();
  } catch {
    return base;
  }
}

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

    // Scheduling options, only for someone being advanced. Google Calendar has
    // no API for a booking page, so this offers real openings read from Arjun's
    // calendar and lets the candidate reply with one. A calendar failure is
    // recorded and the email falls back to "reply with some times" — it never
    // blocks the decision from being saved.
    let offer: BookingOffer = { kind: "none" };
    let commsError: string | undefined;
    if (status === "advanced") {
      const fixed = bookingUrl();
      if (fixed) {
        // A booking page the candidate picks from beats a fixed list of times.
        offer = { kind: "link", url: withInvitee(fixed, candidate, email) };
      } else if (calendarConfigured()) {
        const { slots, error } = await findSlots();
        if (slots.length) offer = { kind: "slots", slots: slots.map((s) => s.label) };
        else commsError = `No interview slots offered: ${error ?? "none found"}`;
      } else {
        const link = await createBookingLink(candidate, email);
        if (link.url) offer = { kind: "link", url: link.url };
        else commsError = `No booking link: ${link.error}`;
      }
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
        body: await draftMessage(candidate, role, status, offer),
        bookingUrl: offer.kind === "link" ? offer.url : undefined,
        slots: offer.kind === "slots" ? offer.slots : undefined,
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
