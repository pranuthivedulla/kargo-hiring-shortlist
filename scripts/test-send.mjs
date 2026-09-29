/**
 * End-to-end check of the communication path, exactly as the dashboard runs it:
 * draft -> confirm -> send. Uses a FIXTURE candidate, never a real CV, and
 * SEND_OVERRIDE_TO forces the recipient regardless.
 *
 *   npx tsx scripts/test-send.mjs            # rejection email
 *   npx tsx scripts/test-send.mjs advanced   # acceptance email
 */
import "./use-fixtures.mjs"; // must precede every ../lib/ import
import { loadEnv } from "./load-env.mjs";

loadEnv();

const status = process.argv[2] === "advanced" ? "advanced" : "rejected";

const { sendOverride, draftMessage, subjectFor, createBookingLink, sendEmail, emailFromCv } =
  await import("../lib/comms.ts");

const override = sendOverride();
if (!override) {
  console.error("SEND_OVERRIDE_TO is not set. Refusing to send without it.");
  process.exit(1);
}

const candidate = "Ananya Rao"; // a fixture person, invented
const role = "PM";

console.log(`status    : ${status}`);
console.log(`candidate : ${candidate} (fixture, invented)`);
console.log(`override  : ${override}`);
console.log(`from      : ${process.env.RESEND_FROM}`);

// Prove the override really does bypass CV extraction.
const resolved = await emailFromCv("pm-ananya-rao-pm");
console.log(`address the app would use: ${resolved}`);
if (resolved !== override) {
  console.error("Override not applied — refusing to continue.");
  process.exit(1);
}

let bookingUrl = null;
if (status === "advanced") {
  const link = await createBookingLink(candidate, override);
  bookingUrl = link.url;
  console.log(`calendly  : ${link.url ?? "none — " + link.error}`);
}

console.log("\ndrafting…");
const subject = subjectFor(status, role);
const body = await draftMessage(candidate, role, status, bookingUrl);

console.log(`\nSubject: ${subject}\n${"-".repeat(60)}\n${body}\n${"-".repeat(60)}`);

// Guard: an internal assessment must never appear in a candidate's inbox.
const banned = /STRONG|PARTIAL|ABSENT|primary signal|secondary signal|rank(ed)? #?\d|shortlist|gate/i;
const hit = body.match(banned);
console.log(hit ? `\n!! LEAK: draft mentions "${hit[0]}"` : "\nno signal/rank language in the draft: ok");

console.log("\nsending…");
try {
  const id = await sendEmail(override, subject, body);
  console.log(`SENT. Resend message id: ${id}`);
} catch (err) {
  console.error(`SEND FAILED: ${err.message}`);
  process.exit(1);
}
