import { eq } from "drizzle-orm";
import { db } from "@/db";
import { devices, type SimProfile } from "@/db/schema";
import { ensureMonitorRunning, getMonitor } from "@/lib/monitor";
import { logActivity, markDbBroken } from "@/lib/resilience";

export const dynamic = "force-dynamic";

/**
 * محاكاة الأعطال لاختبار النظام:
 * - قطع الرابط الرئيسي لاختبار التحويل التلقائي للرابط الاحتياطي
 * - حقن عطل في جهاز محدد أو تغيير سلوكه (flaky / offline / busy)
 */
export async function POST(request: Request) {
  const monitor = await ensureMonitorRunning();
  try {
    const body = (await request.json()) as {
      target?: "primary" | "backup" | "off" | "device";
      deviceId?: number;
      down?: boolean;
      profile?: SimProfile;
      monitored?: boolean;
    };

    if (body.target === "device" && body.deviceId) {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.down !== undefined) patch.forceStatus = body.down ? "down" : "none";
      if (body.profile) patch.simProfile = body.profile;
      if (body.monitored !== undefined) patch.monitored = body.monitored;
      await db.update(devices).set(patch).where(eq(devices.id, body.deviceId));
      logActivity(
        "info",
        `تم ${body.down ? "حقن عطل في" : "إعادة تشغيل"} الجهاز #${body.deviceId}${
          body.profile ? ` بسلوك ${body.profile}` : ""
        }`,
      );
      const report = await monitor.tick();
      return Response.json({ ok: true, report });
    }

    const target: "primary" | "backup" | "off" =
      body.target === "backup" || body.target === "off" ? body.target : "primary";
    await monitor.setLinkSimulation(target, body.down ?? true);
    const report = await monitor.tick();
    return Response.json({ ok: true, report, wan: getMonitor().wan });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "simulation failed");
    return Response.json({ ok: false, error: "تعذر تنفيذ المحاكاة" }, { status: 500 });
  }
}
