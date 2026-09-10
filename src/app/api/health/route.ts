import { NextResponse } from "next/server";
import { getHealthStatus } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await getHealthStatus();
    return NextResponse.json(health, {
      headers: { "Cache-Control": "no-store" },
      status: health.status === "ok" ? 200 : 503,
    });
  } catch {
    return NextResponse.json(
      {
        status: "error",
        appVersion: "0.2.0",
        schemaCompatible: false,
        databaseReadable: false,
        generationReady: false,
      },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
}
