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
    if (origin !== EXPECTED_ORIGIN) {
      return new NextResponse("Invalid Origin", { status: 403 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
