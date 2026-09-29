import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  createSession,
  passwordConfigured,
  passwordMatches,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Small delay on a wrong password, so the gate cannot be brute-forced quickly. */
const WRONG_PASSWORD_DELAY_MS = 600;

export async function POST(req: Request) {
  if (!passwordConfigured()) {
    return NextResponse.json(
      { error: "No APP_PASSWORD is set on this deployment." },
      { status: 503 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { password?: unknown };
  const given = typeof body.password === "string" ? body.password : "";

  if (!passwordMatches(given)) {
    await new Promise((r) => setTimeout(r, WRONG_PASSWORD_DELAY_MS));
    return NextResponse.json({ error: "That password is not right." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSession(), {
    httpOnly: true, // not readable from JavaScript
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
