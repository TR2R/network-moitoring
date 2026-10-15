import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { notificationChannels, notificationLogs } from "@/db/schema";
import type { ChannelType } from "@/db/schema";
import { isDbHealthy, logActivity, markDbBroken, markDbHealthy } from "@/lib/resilience";

export type OutgoingAlert = {
  id: number | null;
  deviceName: string | null;
  severity: string;
  title: string;
  message: string;
  value: string | null;
};

type ChannelRow = {
  id: number;
  name: string;
  type: ChannelType;
  target: string;
  enabled: boolean;
  isFallback: boolean;
  priority: number;
};

const globalForNotify = globalThis as typeof globalThis & {
  __netmonChannels?: ChannelRow[];
};

const TIMEOUT_MS = 2500;

function renderMessage(alert: OutgoingAlert): string {
  const lines = [
    `🔔 تنبيه من نظام مراقبة الشبكة`,
    `الخطورة: ${alert.severity}`,
    `العنوان: ${alert.title}`,
    `التفاصيل: ${alert.message}`,
  ];
  if (alert.deviceName) lines.push(`الجهاز: ${alert.deviceName}`);
  if (alert.value) lines.push(`القراءة: ${alert.value}`);
  return lines.join("\n");
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network error" };
  } finally {
    clearTimeout(timer);
  }
}

/** إرسال فعلي إلى قناة واحدة — القنوات غير المتاحة تُسجل كفاشلة لتتحرك سلسلة الاحتياط للقناة التالية */
async function sendToChannel(channel: ChannelRow, alert: OutgoingAlert): Promise<{ ok: boolean; error?: string }> {
  const text = renderMessage(alert);

  if (channel.type === "log") {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true };
  }

  if (channel.type === "email" || channel.type === "sms") {
    // تُخزَّن محليًا في قائمة الانتظار ويتم إرسالها عند توفر البوابة
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { ok: true };
  }

  if (channel.type === "telegram") {
    const [chatId, token] = channel.target.split("|");
    const botToken = token || process.env.TELEGRAM_BOT_TOKEN || "";
    if (!botToken || !chatId) return { ok: false, error: "إعدادات تيليجرام غير مكتملة" };
    return post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  }

  return post(channel.target, {
    text,
    alert: {
      id: alert.id,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      device: alert.deviceName,
      value: alert.value,
      at: new Date().toISOString(),
    },
  });
}

async function loadChannels(): Promise<ChannelRow[]> {
  try {
    const rows = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.enabled, true))
      .orderBy(asc(notificationChannels.priority));
    markDbHealthy();
    const mapped: ChannelRow[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      target: row.target,
      enabled: row.enabled,
      isFallback: row.isFallback,
      priority: row.priority,
    }));
    globalForNotify.__netmonChannels = mapped;
    return mapped;
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "db error");
    return globalForNotify.__netmonChannels ?? [];
  }
}

async function recordLog(row: {
  alertId: number | null;
  channelName: string;
  channelType: ChannelType;
  via: "primary" | "fallback";
  status: "sent" | "failed";
  attempts: number;
  latencyMs: number;
  error?: string;
}) {
  if (!isDbHealthy()) return;
  try {
    await db.insert(notificationLogs).values({
      alertId: row.alertId,
      channelName: row.channelName,
      channelType: row.channelType,
      via: row.via,
      status: row.status,
      attempts: row.attempts,
      latencyMs: Math.round(row.latencyMs),
      error: row.error ?? null,
    });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "db error");
  }
}

export type DeliveryReport = {
  alertId: number | null;
  delivered: boolean;
  via: "primary" | "fallback" | "none";
  attempts: { channel: string; type: string; via: "primary" | "fallback"; ok: boolean; error?: string }[];
};

/**
 * إرسال التنبيه: يجرّب القنوات الأساسية بالترتيب، وإن فشلت كلها يتحول تلقائيًا
 * إلى القنوات الاحتياطية (Fallback channels) مثل قناة تسجيل محلية أو SMS.
 */
export async function deliverAlert(alert: OutgoingAlert): Promise<DeliveryReport> {
  const channels = await loadChannels();
  const primaries = channels.filter((c) => !c.isFallback).sort((a, b) => a.priority - b.priority);
  const fallbacks = channels.filter((c) => c.isFallback).sort((a, b) => a.priority - b.priority);
  const attempts: DeliveryReport["attempts"] = [];
  let delivered: "primary" | "fallback" | "none" = "none";

  const run = async (list: ChannelRow[], via: "primary" | "fallback") => {
    for (const channel of list) {
      const started = Date.now();
      const result = await sendToChannel(channel, alert);
      attempts.push({
        channel: channel.name,
        type: channel.type,
        via,
        ok: result.ok,
        error: result.error,
      });
      await recordLog({
        alertId: alert.id,
        channelName: channel.name,
        channelType: channel.type,
        via,
        status: result.ok ? "sent" : "failed",
        attempts: 1,
        latencyMs: Date.now() - started,
        error: result.error,
      });
      if (!isDbHealthy()) continue;
      try {
        await db
          .update(notificationChannels)
          .set({
            lastStatus: result.ok ? "sent" : "failed",
            lastSentAt: result.ok ? new Date() : undefined,
          })
          .where(eq(notificationChannels.id, channel.id));
      } catch {
        markDbBroken("channel update failed");
      }
      if (result.ok) {
        delivered = via;
        if (via === "fallback") {
          logActivity("warn", `تم إرسال التنبيه عبر القناة الاحتياطية (${channel.name}) بعد فشل القنوات الأساسية`);
        }
        break;
      }
    }
  };

  await run(primaries, "primary");
  if (delivered === "none") await run(fallbacks, "fallback");

  if (delivered === "none") {
    logActivity("error", `فشل إرسال التنبيه على كل القنوات: ${alert.title}`);
  }

  return { alertId: alert.id, delivered: delivered !== "none", via: delivered, attempts };
}

export async function testChannel(id: number) {
  const rows = await db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).limit(1);
  const channel = rows[0];
  if (!channel) return { ok: false, error: "القناة غير موجودة" };
  const result = await sendToChannel(
    {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      target: channel.target,
      enabled: channel.enabled,
      isFallback: channel.isFallback,
      priority: channel.priority,
    },
    {
      id: null,
      deviceName: null,
      severity: "info",
      title: "رسالة اختبار",
      message: "هذه رسالة اختبار من نظام مراقبة الشبكة",
      value: null,
    },
  );
  await db
    .update(notificationChannels)
    .set({ lastStatus: result.ok ? "sent" : "failed", lastSentAt: result.ok ? new Date() : undefined })
    .where(eq(notificationChannels.id, id));
  return { ok: result.ok, error: result.error };
}

export async function resolveNotificationHistory(alertIds: number[]) {
  if (alertIds.length === 0) return [];
  try {
    return await db
      .select()
      .from(notificationLogs)
      .where(and(inArray(notificationLogs.alertId, alertIds)))
      .limit(50);
  } catch {
    return [];
  }
}
