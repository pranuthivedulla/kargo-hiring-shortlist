/**
 * A shared-password gate over the whole app.
 *
 * The deployed site holds candidate assessments, so it should not be readable
 * by anyone who happens on the URL. This is not per-person authentication —
 * one password is shared with whoever needs access. It stops strangers, not a
 * determined insider, and the README says so.
 *
 * The cookie is an HMAC-signed expiry, not a copy of the password: a stolen
 * cookie cannot be turned back into the password, and it stops working on its
 * own. Web Crypto rather than node:crypto so the same code runs in middleware,
 * which executes on the Edge runtime.
 */

const COOKIE = "kargo_session";
const DAYS = Number(process.env.AUTH_SESSION_DAYS ?? 7);

export const SESSION_COOKIE = COOKIE;
export const SESSION_MAX_AGE = DAYS * 24 * 60 * 60;

function secret(): string {
  // Falls back to the password so a deployment that sets only APP_PASSWORD
  // still gets signed cookies rather than silently unsigned ones.
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || "";
}

export function passwordConfigured(): boolean {
  return !!process.env.APP_PASSWORD;
}

/**
 * With no password set: open in development, closed in production. Forgetting
 * to configure it on the deployment must not silently publish the dashboard.
 */
export function gateMode(): "open" | "password" | "locked" {
  if (passwordConfigured()) return "password";
  return process.env.NODE_ENV === "production" ? "locked" : "open";
}

const enc = new TextEncoder();

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Buffer.from(new Uint8Array(sig)).toString("base64url");
}

/** Constant-time, so a wrong password cannot be found a character at a time. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function passwordMatches(given: string): boolean {
  const expected = process.env.APP_PASSWORD ?? "";
  if (!expected) return false;
  return sameString(given, expected);
}

export async function createSession(): Promise<string> {
  const expires = String(Date.now() + SESSION_MAX_AGE * 1000);
  return `${expires}.${await hmac(expires)}`;
}

export async function sessionValid(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;

  const expires = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(expires)) return false;
  if (Number(expires) < Date.now()) return false;

  return sameString(sig, await hmac(expires));
}
