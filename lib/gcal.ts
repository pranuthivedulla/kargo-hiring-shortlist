/**
 * Google Calendar: read Arjun's real availability and turn it into interview
 * slots the acceptance email can offer.
 *
 * Google Calendar has no API for a self-serve booking page — Appointment
 * Schedules can only be made by hand in the UI. So this reads free/busy and
 * offers genuinely open slots that the candidate replies to choose from. It
 * never books anything: nothing is written to the calendar, and no candidate
 * receives an invite they did not ask for.
 *
 * Auth is a stored refresh token (see scripts/google-auth.mjs), so there is no
 * consent flow at request time. Plain fetch against the REST API rather than
 * the googleapis SDK, which is large and pulls in far more than this needs.
 */

// Shared with the email text so the two can never disagree about the length.
import { INTERVIEW_MINUTES as SLOT_MINUTES } from "./comms";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

/** Kargo is in Mumbai; slots are offered in the candidate's local time too. */
const TIMEZONE = process.env.INTERVIEW_TIMEZONE ?? "Asia/Kolkata";
const DAY_START_HOUR = Number(process.env.INTERVIEW_DAY_START ?? 10);
const DAY_END_HOUR = Number(process.env.INTERVIEW_DAY_END ?? 18);
const LOOKAHEAD_DAYS = Number(process.env.INTERVIEW_LOOKAHEAD_DAYS ?? 10);
const MAX_SLOTS = Number(process.env.INTERVIEW_MAX_SLOTS ?? 6);
/** Never offer something tomorrow morning that was booked tonight. */
const MIN_NOTICE_HOURS = Number(process.env.INTERVIEW_MIN_NOTICE_HOURS ?? 24);

/**
 * A Google Calendar Appointment Schedule's public booking page, or any other
 * fixed scheduling URL.
 *
 * Appointment Schedules are a Workspace feature and give exactly what a
 * candidate wants — real availability, they pick, it books into the calendar.
 * There is no API to create or read them, so the URL is made by hand once and
 * pasted here. It is one link for everyone rather than one per candidate.
 *
 * Preferred over slot-listing when set: letting someone choose from live
 * availability beats a fixed list that may go stale between drafting and
 * reading the email.
 */
export function bookingUrl(): string | undefined {
  const v = process.env.BOOKING_URL?.trim();
  return v ? v : undefined;
}

export function calendarConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN
  );
}

/** Exchanges the stored refresh token for a short-lived access token. */
async function accessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN ?? "",
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `Google token refresh failed (${res.status}). ${detail}` +
        (res.status === 400
          ? " A 400 here usually means the refresh token was revoked or expired — re-run scripts/google-auth.mjs."
          : ""),
    );
  }

  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Google returned no access_token.");
  return json.access_token;
}

type Busy = { start: string; end: string };

async function busyPeriods(token: string, from: Date, to: Date): Promise<Busy[]> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID ?? "primary";
  const res = await fetch(FREEBUSY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      timeZone: TIMEZONE,
      items: [{ id: calendarId }],
    }),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Google freeBusy failed (${res.status}). ${detail}`);
  }

  const json = (await res.json()) as {
    calendars?: Record<string, { busy?: Busy[]; errors?: { reason: string }[] }>;
  };
  const cal = json.calendars?.[calendarId];
  if (cal?.errors?.length) {
    throw new Error(`Google freeBusy error for "${calendarId}": ${cal.errors[0].reason}`);
  }
  return cal?.busy ?? [];
}

/** What hour is it in TIMEZONE at this instant, and on which weekday. */
function zoned(d: Date): { year: number; month: number; day: number; hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    weekday: weekdays.indexOf(String(parts.weekday)),
  };
}

export type Slot = { start: Date; end: Date; label: string };

function label(start: Date, end: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(start);
  const t = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIMEZONE,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .format(d)
      .replace(/\s/g, "")
      .toLowerCase();
  return `${day}, ${t(start)}–${t(end)} IST`;
}

/**
 * Open slots in working hours, at most one or two per day so the options span
 * the week rather than clustering on the first free morning.
 */
export async function findSlots(): Promise<{ slots: Slot[]; error?: string }> {
  if (!calendarConfigured()) {
    return { slots: [], error: "Google Calendar is not configured (see .env.example)." };
  }

  try {
    const token = await accessToken();
    const now = new Date();
    const from = new Date(now.getTime() + MIN_NOTICE_HOURS * 3600_000);
    const to = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 3600_000);

    const busy = (await busyPeriods(token, from, to)).map((b) => ({
      start: new Date(b.start).getTime(),
      end: new Date(b.end).getTime(),
    }));

    const slotMs = SLOT_MINUTES * 60_000;
    const slots: Slot[] = [];
    const perDay = new Map<string, number>();

    // Walk the window in slot-sized steps, aligned to the hour.
    const cursor = new Date(from);
    cursor.setMinutes(0, 0, 0);
    cursor.setTime(cursor.getTime() + 3600_000);

    while (cursor < to && slots.length < MAX_SLOTS) {
      const z = zoned(cursor);
      const isWeekday = z.weekday >= 1 && z.weekday <= 5;
      const inHours = z.hour >= DAY_START_HOUR && z.hour < DAY_END_HOUR;
      const key = `${z.year}-${z.month}-${z.day}`;

      if (isWeekday && inHours && (perDay.get(key) ?? 0) < 2) {
        const start = cursor.getTime();
        const end = start + slotMs;
        const clashes = busy.some((b) => start < b.end && end > b.start);
        if (!clashes) {
          slots.push({ start: new Date(start), end: new Date(end), label: label(new Date(start), new Date(end)) });
          perDay.set(key, (perDay.get(key) ?? 0) + 1);
          // Skip ahead so the two slots offered on one day are not adjacent.
          cursor.setTime(cursor.getTime() + 3 * 3600_000);
          continue;
        }
      }
      cursor.setTime(cursor.getTime() + 3600_000);
    }

    if (slots.length === 0) {
      return { slots: [], error: "No free interview slots found in the lookahead window." };
    }
    return { slots };
  } catch (err) {
    // Never block a decision on a calendar problem.
    return { slots: [], error: err instanceof Error ? err.message : String(err) };
  }
}
