import { type NextRequest, NextResponse } from "next/server";

const EXPECTED_HOST = "127.0.0.1:3210";
const EXPECTED_ORIGIN = `http://${EXPECTED_HOST}`;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function proxy(request: NextRequest) {
  const host = request.headers.get("host")?.toLowerCase();
  if (host !== EXPECTED_HOST) {
    return new NextResponse("Invalid Host", { status: 403 });
  }

  if (request.nextUrl.pathname.startsWith("/api/") && MUTATING_METHODS.has(request.method)) {
    const origin = request.headers.get("origin");
    // Browser form navigations can omit Origin or send the opaque value "null".
    // Sec-Fetch-Site is a forbidden browser header, so it is the reliable
    // same-origin fallback for those cases.
    const isSameOrigin = origin && origin !== "null"
      ? origin === EXPECTED_ORIGIN
      : request.headers.get("sec-fetch-site") === "same-origin";
    if (!isSameOrigin) {
      return new NextResponse("Invalid Origin", { status: 403 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
