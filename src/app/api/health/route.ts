import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { nodeStats } from "@/lib/ssh/registry";
import { appEnv } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Liveness + readiness. /api/health?probe=live skips dependency checks. */
export async function GET(req: Request) {
  const probe = new URL(req.url).searchParams.get("probe");
  if (probe === "live") return NextResponse.json({ status: "ok", probe: "live" });
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ status: "ok", probe: "ready", env: appEnv(), ...nodeStats(), time: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ status: "degraded", error: err instanceof Error ? err.message : "db unavailable" }, { status: 503 });
  }
}
