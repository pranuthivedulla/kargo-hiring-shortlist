/** The production send guard. No real sends: every case must throw or be blocked. */
import { loadEnv } from "./load-env.mjs";
loadEnv();
const { sendEmail } = await import("../lib/comms.ts");

let failures = 0;
const check = (l, c, d = "") => { console.log(`${c ? "  ok  " : "  FAIL"} ${l}${d ? " — " + d : ""}`); if (!c) failures++; };

const KEY = process.env.RESEND_API_KEY;
const want = async (label, env, expect) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  let msg = "(no throw — WOULD HAVE SENT)";
  try { await sendEmail("someone@example.com", "s", "b"); } catch (e) { msg = e.message; }
  Object.keys(process.env).forEach((k) => { if (!(k in saved)) delete process.env[k]; });
  Object.assign(process.env, saved);
  check(label, msg.includes(expect), msg.slice(0, 90));
};

await want(
  "production + key + no override  -> refuses",
  { NODE_ENV: "production", RESEND_API_KEY: KEY, SEND_OVERRIDE_TO: "", ALLOW_REAL_SENDS: "" },
  "will not send to real candidates",
);
await want(
  "production + no key             -> refuses",
  { NODE_ENV: "production", RESEND_API_KEY: "", SEND_OVERRIDE_TO: "" },
  "RESEND_API_KEY is not set",
);
await want(
  "production + override set       -> passes the guard",
  { NODE_ENV: "production", RESEND_API_KEY: "", SEND_OVERRIDE_TO: "test@example.com" },
  "RESEND_API_KEY is not set", // got past the guard, stopped on the missing key
);
await want(
  "production + ALLOW_REAL_SENDS=1 -> passes the guard",
  { NODE_ENV: "production", RESEND_API_KEY: "", SEND_OVERRIDE_TO: "", ALLOW_REAL_SENDS: "1" },
  "RESEND_API_KEY is not set",
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
