import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getMonitor } from "@/lib/monitor";
import { dbStatus } from "@/lib/resilience";

export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const monitor = getMonitor();
  const status = dbStatus();

  return Response.json(
    {
      ok: dbOk,
      db: dbOk ? "up" : "down",
      dbDetail: status,
      monitor: {
        running: monitor.running,
        lastTickAt: monitor.lastTickAt,
        ticks: monitor.ticks,
        wanMode: monitor.wan.mode,
        source: monitor.source,
      },
      uptimeSeconds: Math.round(process.uptime()),
    },
    { status: dbOk ? 200 : 503 },
  );
}
