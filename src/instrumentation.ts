/**
 * إقلاع الخدمات الخلفية عند تشغيل الخادم:
 * تشغيل محرك المراقبة الدوري وفحص الروابط الاحتياطية.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureMonitorRunning } = await import("@/lib/monitor");
    await ensureMonitorRunning();
  } catch (error) {
    console.error("[netmon] failed to start monitor", error);
  }
}
