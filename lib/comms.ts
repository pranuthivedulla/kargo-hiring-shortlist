import { generateText, hasKey } from "./model";
import { ROLE_LABEL, type Role } from "./paths";
import { loadParsed } from "./store";
import type { DecisionStatus } from "./types";

/**
 * The drafting call is told what happened, never why. Signals, evidence and rank
 * are deliberately not passed in, so there is no route by which an internal
 * assessment can leak into a candidate's inbox.
 */
const DRAFT_SYSTEM = `You write short hiring emails on behalf of Arjun Mehta, founder of Kargo, a
Series A logistics software company in Mumbai. Kargo has no HR function; Arjun
writes to candidates himself.

Rules, without exception:
- Never mention scores, rankings, signals, assessments, or any specific
  weakness, gap or strength of the candidate.
- Never invent a detail about the candidate, the process, or the company.
- Plain, warm, direct. No corporate filler, no flattery, no exclamation marks.
- Sign off as Arjun Mehta, Founder, Kargo.
- Return ONLY the email body as plain text. No subject line, no preamble, no
  markdown.`;

function declinePrompt(name: string, role: Role): string {
  return `Write a polite decline to ${name}, who applied for the ${ROLE_LABEL[role]} role.
Four to six sentences. Thank them for applying, say Kargo is not taking their
application forward for this role, and that the decision does not close the door
on future roles. Do not give any reason specific to them.`;
}

function advancePrompt(name: string, role: Role, bookingUrl: string | null): string {
  return `Write a message to ${name} inviting them to the first interview round for the
${ROLE_LABEL[role]} role at Kargo: a 45-minute conversation with Arjun.
Four to six sentences. Say you would like to speak with them, name the round, and
${
    bookingUrl
      ? `ask them to pick a time using this link, included on its own line exactly as written: ${bookingUrl}`
      : "ask them to reply with two or three times that suit them this week (no scheduling link is available)."
  }
Do not mention why they were selected.`;
}

export function subjectFor(status: DecisionStatus, role: Role): string {
  return status === "advanced"
    ? `Congratulations — Next steps for ${ROLE_LABEL[role]} at Kargo`
    : `Update on your application — ${ROLE_LABEL[role]} at Kargo`;
}

/** Best-effort address lifted from the CV text; Arjun confirms it before sending. */
export async function emailFromCv(candidateId: string): Promise<string | undefined> {
  const parsed = await loadParsed();
  const cv = parsed.find((p) => p.id === candidateId);
  const match = cv?.text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return match?.[0];
}

export async function draftMessage(
  name: string,
  role: Role,
  status: DecisionStatus,
  bookingUrl: string | null,
): Promise<string> {
  if (!hasKey()) return fallbackBody(name, role, status, bookingUrl);

  try {
    const text = (
      await generateText({
        system: DRAFT_SYSTEM,
        prompt:
          status === "advanced"
            ? advancePrompt(name, role, bookingUrl)
            : declinePrompt(name, role),
        maxTokens: 700,
        tier: "drafting",
      })
    ).trim();
    return text || fallbackBody(name, role, status, bookingUrl);
  } catch {
    // A drafting failure must never block the decision from being recorded.
    return fallbackBody(name, role, status, bookingUrl);
  }
}

/** Used when no key is configured or the drafting call fails. Arjun can edit it. */
export function fallbackBody(
  name: string,
  role: Role,
  status: DecisionStatus,
  bookingUrl: string | null,
): string {
  const first = name.split(" ")[0];
  if (status === "advanced") {
    return [
      `Hi ${first},`,
      "",
      `Thank you for applying for the ${ROLE_LABEL[role]} role at Kargo. I would like to take this forward and speak with you properly — a 45-minute first conversation with me.`,
      "",
      bookingUrl
        ? `You can pick a time that works for you here:\n${bookingUrl}`
        : "Could you reply with two or three times that suit you this week?",
      "",
      "Looking forward to it.",
      "",
      "Arjun Mehta",
      "Founder, Kargo",
    ].join("\n");
  }
  return [
    `Hi ${first},`,
    "",
    `Thank you for applying for the ${ROLE_LABEL[role]} role at Kargo, and for the time you put into your application.`,
    "",
    "We are not taking your application forward for this role. I know a wait followed by a no is not what you were hoping for, and I am sorry it took as long as it did.",
    "",
    "We are hiring steadily as we grow, and I would be glad to hear from you again for a future role.",
    "",
    "Arjun Mehta",
    "Founder, Kargo",
  ].join("\n");
}

/**
 * A single-use Calendly scheduling link for the one shared Event Type, with the
 * invitee's details prefilled. Returns null (never throws) so a Calendly outage
 * degrades to "reply with some times" instead of blocking the decision.
 */
export async function createBookingLink(
  name: string,
  email: string | undefined,
): Promise<{ url: string | null; error?: string }> {
  const token = process.env.CALENDLY_API_KEY;
  const eventType = process.env.CALENDLY_EVENT_TYPE_URI;
  if (!token || !eventType) {
    return { url: null, error: "CALENDLY_API_KEY or CALENDLY_EVENT_TYPE_URI is not set." };
  }

  try {
    const res = await fetch("https://api.calendly.com/scheduling_links", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        max_event_count: 1,
        owner: eventType,
        owner_type: "EventType",
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { url: null, error: `Calendly returned ${res.status}. ${detail.slice(0, 300)}` };
    }

    const json = (await res.json()) as { resource?: { booking_url?: string } };
    const base = json.resource?.booking_url;
    if (!base) return { url: null, error: "Calendly response contained no booking_url." };

    const url = new URL(base);
    url.searchParams.set("name", name);
    if (email) url.searchParams.set("email", email);
    return { url: url.toString() };
  } catch (err) {
    return { url: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Sends through Resend. Only ever called from the explicit confirm step. */
export async function sendEmail(to: string, subject: string, body: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set.");
  const from = process.env.RESEND_FROM;
  if (!from) {
    throw new Error("RESEND_FROM is not set (e.g. \"Arjun Mehta <arjun@yourdomain.com>\").");
  }

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to: [to],
    subject,
    text: body,
    replyTo: process.env.RESEND_REPLY_TO,
  });
  if (error) throw new Error(`${error.name}: ${error.message}`);
  return data?.id;
}
