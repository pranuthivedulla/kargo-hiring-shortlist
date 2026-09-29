import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, gateMode, sessionValid } from "@/lib/auth";

/**
 * Everything is behind the gate. Nothing about a candidate — not a name, not a
 * ranking, not a batch summary — should be readable without the password.
 *
 * The login page and the endpoint that checks the password are the only
 * exceptions, plus Next's own static assets.
 */
const PUBLIC = ["/login", "/api/auth/login", "/api/auth/logout"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const mode = gateMode();
  if (mode === "open") return NextResponse.next();

  if (mode === "locked") {
    // Deployed with no APP_PASSWORD. Fail closed rather than publish the
    // dashboard because a variable was forgotten.
    //
    // Reports which expected variables the running server can actually see -
    // names and presence only, never a value. Without this, a variable saved
    // to the wrong environment or with a typo in its name is indistinguishable
    // from one that was never added.
    const expected = [
      "APP_PASSWORD",
      "AUTH_SECRET",
      "GEMINI_API_KEY",
      "MODEL_PROVIDER",
      "DATABASE_URL",
      "BOOKING_URL",
      "RESEND_API_KEY",
    ];
    const seen: Record<string, boolean> = {};
    for (const k of expected) seen[k] = !!process.env[k];

    // Names only, and only ones this app defines. Listing everything the
    // platform injected would hand a stranger a map of the infrastructure.
    return NextResponse.json(
      {
        error:
          "This deployment has no APP_PASSWORD set, so it is locked. Set APP_PASSWORD in the environment (Production) and redeploy.",
        expectedVariables: seen,
      },
      { status: 503 },
    );
  }

  if (await sessionValid(req.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  // An API caller wants a status code, not a redirect to an HTML page.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's internals and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
