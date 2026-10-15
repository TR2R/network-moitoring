import { ensureMonitorRunning, getMonitor } from "@/lib/monitor";

export const dynamic = "force-dynamic";

export async function GET() {
  const monitor = getMonitor();
  return Response.json({
    running: monitor.running,
    settings: monitor.settings,
    ticks: monitor.ticks,
    probes: monitor.probes,
    lastTickAt: monitor.lastTickAt,
    lastTickDurationMs: monitor.lastTickDurationMs,
    wan: monitor.wan,
    source: monitor.source,
  });
}

/** تشغيل دورة فحص فورية */
export async function POST() {
  const monitor = await ensureMonitorRunning();
  const report = await monitor.tick();
  return Response.json({ ok: true, report });
}
