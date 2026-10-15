import { ensureMonitorRunning, getMonitor } from "@/lib/monitor";
import type { MonitorSettings } from "@/lib/dashboard-types";

export const dynamic = "force-dynamic";

export async function GET() {
  const monitor = getMonitor();
  return Response.json({ settings: monitor.settings });
}

export async function PATCH(request: Request) {
  const monitor = await ensureMonitorRunning();
  const body = (await request.json()) as Partial<MonitorSettings>;
  const clean: Partial<MonitorSettings> = {};
  const numericKeys: (keyof MonitorSettings)[] = [
    "tickSeconds",
    "latencyThresholdMs",
    "utilizationThresholdPct",
    "lossThresholdPct",
    "downFailThreshold",
    "retentionHours",
  ];
  for (const key of numericKeys) {
    const value = body[key];
    if (value !== undefined && !Number.isNaN(Number(value))) {
      clean[key] = Number(value) as never;
    }
  }
  if (body.notificationsEnabled !== undefined) {
    clean.notificationsEnabled = Boolean(body.notificationsEnabled);
  }
  const settings = await monitor.saveSettings(clean);
  return Response.json({ ok: true, settings });
}
