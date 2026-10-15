import { promises as fs } from "node:fs";
import path from "node:path";
import type { Overview } from "@/lib/dashboard-types";

/**
 * طبقة الاتصال الاحتياطي (Resilience layer)
 * ------------------------------------------------------------
 * 1) عند تعذر الوصول إلى قاعدة البيانات تُخزَّن آخر لقطة معروفة في الذاكرة وعلى القرص
 *    حتى تظل لوحة المتابعة والتنبيهات تعمل (وضع degraded).
 * 2) القياسات التي تعجز قاعدة البيانات عن استقبالها تُحفظ في مخزن مؤقت ثم تُرسل
 *    تلقائيًا عند عودة الاتصال (Flush عند التعافي).
 */

const SNAPSHOT_DIR = path.join(process.cwd(), ".data");
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, "last-overview.json");

type GlobalResilience = typeof globalThis & {
  __netmonResilience?: {
    lastGoodOverview: Overview | null;
    lastGoodAt: number | null;
    dbHealthy: boolean;
    lastDbError: string | null;
    lastDbErrorAt: number | null;
    pendingSamples: PendingSample[];
    bufferedAlerts: BufferedAlert[];
    activityLog: { at: string; level: "info" | "warn" | "error"; message: string }[];
  };
};

export type PendingSample = {
  deviceId: number;
  status: string;
  latencyMs: number | null;
  lossPct: number | null;
  inMbps: number | null;
  outMbps: number | null;
  cpuPct: number | null;
  memPct: number | null;
  source: "primary" | "backup" | "cache";
  createdAt: string;
};

export type BufferedAlert = {
  deviceId: number | null;
  deviceName: string | null;
  type: string;
  severity: string;
  title: string;
  message: string;
  value: string | null;
  createdAt: string;
};

const g = globalThis as GlobalResilience;

function store() {
  if (!g.__netmonResilience) {
    g.__netmonResilience = {
      lastGoodOverview: null,
      lastGoodAt: null,
      dbHealthy: true,
      lastDbError: null,
      lastDbErrorAt: null,
      pendingSamples: [],
      bufferedAlerts: [],
      activityLog: [],
    };
  }
  return g.__netmonResilience;
}

const globalKill = globalThis as typeof globalThis & { __netmonDbKillSwitch?: boolean };

/** تفعيل/إلغاء محاكاة انقطاع قاعدة البيانات لاختبار المسار الاحتياطي */
export function setDbKillSwitch(enabled: boolean) {
  globalKill.__netmonDbKillSwitch = enabled;
  logActivity(
    enabled ? "error" : "info",
    enabled
      ? "تم تفعيل محاكاة انقطاع قاعدة البيانات — النظام يعمل على اللقطة الاحتياطية"
      : "تم استعادة قاعدة البيانات من وضع المحاكاة",
  );
}

export function isDbKillSwitchOn() {
  return Boolean(globalKill.__netmonDbKillSwitch);
}

export function logActivity(level: "info" | "warn" | "error", message: string) {
  const s = store();
  s.activityLog.unshift({ at: new Date().toISOString(), level, message });
  if (s.activityLog.length > 60) s.activityLog.length = 60;
}

export function getActivityLog() {
  return store().activityLog.slice(0, 25);
}

export function markDbHealthy() {
  const s = store();
  const wasUnhealthy = !s.dbHealthy;
  s.dbHealthy = true;
  s.lastDbError = null;
  if (wasUnhealthy) {
    logActivity("info", "تم استعادة الاتصال بقاعدة البيانات الرئيسية ومزامنة البيانات المؤقتة");
  }
  return wasUnhealthy;
}

export function markDbBroken(error: string) {
  const s = store();
  const wasHealthy = s.dbHealthy;
  s.dbHealthy = false;
  s.lastDbError = error;
  s.lastDbErrorAt = Date.now();
  if (wasHealthy) {
    logActivity("error", `فشل الاتصال بقاعدة البيانات، التبديل إلى النسخة الاحتياطية: ${error}`);
  }
}

export function isDbHealthy() {
  return store().dbHealthy;
}

export function dbStatus() {
  const s = store();
  return {
    healthy: s.dbHealthy,
    lastError: s.lastDbError,
    lastErrorAt: s.lastDbErrorAt ? new Date(s.lastDbErrorAt).toISOString() : null,
  };
}

export function queueSamples(samples: PendingSample[]) {
  const s = store();
  s.pendingSamples.push(...samples);
  if (s.pendingSamples.length > 5000) s.pendingSamples.splice(0, s.pendingSamples.length - 5000);
}

export function takePendingSamples(limit = 1000): PendingSample[] {
  const s = store();
  const batch = s.pendingSamples.slice(0, limit);
  s.pendingSamples.splice(0, batch.length);
  return batch;
}

export function pendingSampleCount() {
  return store().pendingSamples.length;
}

export function queueAlert(alert: BufferedAlert) {
  const s = store();
  s.bufferedAlerts.unshift(alert);
  if (s.bufferedAlerts.length > 300) s.bufferedAlerts.length = 300;
}

export function takeBufferedAlerts(limit = 50): BufferedAlert[] {
  const s = store();
  const batch = s.bufferedAlerts.slice(0, limit);
  s.bufferedAlerts.splice(0, batch.length);
  return batch;
}

/** حفظ آخر لقطة سليمة في الذاكرة وعلى القرص */
export async function saveSnapshot(overview: Overview) {
  const s = store();
  s.lastGoodOverview = overview;
  s.lastGoodAt = Date.now();
  try {
    await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
    await fs.writeFile(SNAPSHOT_FILE, JSON.stringify(overview), "utf8");
  } catch (error) {
    logActivity(
      "warn",
      `تعذر حفظ اللقطة المحلية: ${error instanceof Error ? error.message : "خطأ غير معروف"}`,
    );
  }
}

export function cachedOverview(): Overview | null {
  return store().lastGoodOverview;
}

/** قراءة اللقطة المحفوظة على القرص (تُستخدم بعد إعادة تشغيل الخادم) */
export async function readDiskSnapshot(): Promise<Overview | null> {
  try {
    const raw = await fs.readFile(SNAPSHOT_FILE, "utf8");
    return JSON.parse(raw) as Overview;
  } catch {
    return null;
  }
}
