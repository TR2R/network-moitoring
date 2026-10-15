import { ensureMonitorRunning, getMonitor } from "@/lib/monitor";
import { dbStatus, getActivityLog, pendingSampleCount, setDbKillSwitch } from "@/lib/resilience";
import { isDbKillSwitchEnabled } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const monitor = getMonitor();
  return Response.json({
    db: dbStatus(),
    killSwitch: isDbKillSwitchEnabled(),
    pendingSamples: pendingSampleCount(),
    wan: monitor.wan,
    activity: getActivityLog(),
  });
}

/** محاكاة انقطاع قاعدة البيانات أو استعادتها (اختبار الاتصال الاحتياطي) */
export async function POST(request: Request) {
  await ensureMonitorRunning();
  const body = (await request.json()) as { action?: "db-outage" | "db-restore"; enabled?: boolean };
  const enabled = body.action ? body.action === "db-outage" : Boolean(body.enabled);
  setDbKillSwitch(enabled);

  const monitor = getMonitor();
  const report = await monitor.tick();
  return Response.json({ ok: true, killSwitch: isDbKillSwitchEnabled(), report });
}
