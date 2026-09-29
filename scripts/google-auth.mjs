/**
 * One-time Google authorisation. Run once; the refresh token it prints goes
 * into .env.local and the app never asks for consent again.
 *
 *   npx tsx scripts/google-auth.mjs
 *
 * Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local, from a
 * "Desktop app" OAuth client. Desktop clients allow a loopback redirect, which
 * is what lets this run without a deployed URL.
 *
 * Scope is calendar.readonly: this app reads free/busy and never writes to the
 * calendar, so it should not hold permission to.
 */
import http from "http";
import crypto from "crypto";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be in .env.local first.\n" +
      "Create them at console.cloud.google.com/apis/credentials as an OAuth client of type 'Desktop app'.",
  );
  process.exit(1);
}

const PORT = Number(process.env.GOOGLE_AUTH_PORT ?? 53682);
const redirectUri = `http://localhost:${PORT}`;
const state = crypto.randomBytes(16).toString("hex");

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    // Required to be issued a refresh token at all.
    access_type: "offline",
    // Forces the consent screen so a refresh token is returned even if this
    // account has authorised before; without it a re-run yields none.
    prompt: "consent",
    state,
  }).toString();

console.log("\nOpen this URL, sign in as the account whose calendar should be read,");
console.log("and approve:\n");
console.log(authUrl);
console.log(`\nWaiting for the redirect on ${redirectUri} …\n`);

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, redirectUri);
    const got = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    const gotState = url.searchParams.get("state");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (err) {
      res.end(`<p>Authorisation failed: ${err}. You can close this tab.</p>`);
      server.close();
      return reject(new Error(err));
    }
    if (gotState !== state) {
      res.end("<p>State mismatch. You can close this tab.</p>");
      server.close();
      return reject(new Error("state mismatch — possible interference, not retrying"));
    }
    res.end("<p>Authorised. You can close this tab and go back to the terminal.</p>");
    server.close();
    resolve(got);
  });
  server.listen(PORT);
  setTimeout(() => {
    server.close();
    reject(new Error("timed out after 5 minutes"));
  }, 300_000);
});

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }),
});

const json = await res.json();
if (!res.ok || !json.refresh_token) {
  console.error("\nToken exchange failed:", JSON.stringify(json, null, 2));
  if (res.ok && !json.refresh_token) {
    console.error(
      "\nGoogle returned no refresh_token. That happens when this account has\n" +
        "already authorised and prompt=consent was not honoured. Revoke access at\n" +
        "myaccount.google.com/permissions and run this again.",
    );
  }
  process.exit(1);
}

console.log("\nDone. Add this line to .env.local:\n");
console.log(`GOOGLE_REFRESH_TOKEN=${json.refresh_token}`);
console.log("\n(Treat it like a password — it grants read access to that calendar.)");
