import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  alerts,
  appSettings,
  devices,
  failoverEvents,
  metricSamples,
  notificationChannels,
  ports,
  type DeviceStatus,
  type DeviceType,
  type ProbeMode,
  type SimProfile,
} from "@/db/schema";

type AlertType = typeof alerts.$inferInsert["type"];
import {
  DEFAULT_SETTINGS,
  type AlertView,
  type DeviceView,
  type MonitorSettings,
  type Overview,
} from "@/lib/dashboard-types";
import { deliverAlert } from "@/lib/notify";
import { deriveLoad, probeDevice, simulateProbe, type DeviceLoad, type ProbeResult } from "@/lib/probe";
import {
  cachedOverview,
  getActivityLog,
  isDbHealthy,
  logActivity,
  markDbBroken,
  markDbHealthy,
  pendingSampleCount,
  queueAlert,
  queueSamples,
  readDiskSnapshot,
  saveSnapshot,
  takePendingSamples,
} from "@/lib/resilience";

type WanMode = "primary" | "backup" | "down";

type MonitorGlobal = typeof globalThis & {
  __netmonMonitor?: NetworkMonitor;
};

export type TickReport = {
  ranAt: string;
  durationMs: number;
  probes: number;
  dbMode: "primary" | "fallback";
  wanMode: WanMode;
  newAlerts: number;
  resolvedAlerts: number;
  bufferedSamples: number;
};

const EMPTY_LOAD: DeviceLoad = {
  utilPct: 0,
  cpuPct: 0,
  memPct: 0,
  inMbps: 0,
  outMbps: 0,
  uptimeSeconds: 0,
};

function capacityOf(type: string) {
  switch (type) {
    case "switch":
      return 2400;
    case "server":
      return 2000;
    case "access_point":
      return 600;
    case "ups":
      return 100;
    default:
      return 1000;
  }
}

export class NetworkMonitor {
  settings: MonitorSettings = { ...DEFAULT_SETTINGS };
  running = false;
  startedAt = new Date().toISOString();
  lastTickAt: string | null = null;
  lastTickDurationMs = 0;
  ticks = 0;
  probes = 0;
  source: "primary" | "backup" | "cache" = "primary";
  wan: Overview["wan"] = {
    mode: "primary",
    activeLinkName: null,
    primaryName: null,
    backupName: null,
    primaryUp: true,
    backupUp: true,
    primaryLatencyMs: null,
    backupLatencyMs: null,
    since: new Date().toISOString(),
    simulated: false,
  };

  private failCounts = new Map<number, number>();
  private okCounts = new Map<number, number>();
  private statuses = new Map<number, DeviceStatus>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private latencySeries: { t: string; v: number }[] = [];
  private trafficSeries: { t: string; inMbps: number; outMbps: number }[] = [];
  private dbMode: "primary" | "fallback" = "primary";

  /* ------------------------------------------------------------------ إعدادات */

  async loadSettings() {
    try {
      const rows = await db.select().from(appSettings);
      markDbHealthy();
      const map = new Map(rows.map((row) => [row.key, row.value]));
      const patch: Partial<MonitorSettings> = {};
      const num = (key: keyof MonitorSettings) => {
        const raw = map.get(key);
        if (raw !== undefined && !Number.isNaN(Number(raw))) {
          patch[key] = Number(raw) as never;
        }
      };
      num("tickSeconds");
      num("latencyThresholdMs");
      num("utilizationThresholdPct");
      num("lossThresholdPct");
      num("downFailThreshold");
      num("retentionHours");
      if (map.get("notificationsEnabled") !== undefined) {
        patch.notificationsEnabled = map.get("notificationsEnabled") === "true";
      }
      this.settings = { ...DEFAULT_SETTINGS, ...patch };
      this.dbMode = "primary";
    } catch (error) {
      markDbBroken(error instanceof Error ? error.message : "settings read failed");
      this.dbMode = "fallback";
    }
  }

  async saveSettings(patch: Partial<MonitorSettings>) {
    this.settings = { ...this.settings, ...patch };
    try {
      for (const [key, value] of Object.entries(patch)) {
        await db
          .insert(appSettings)
          .values({ key, value: String(value) })
          .onConflictDoUpdate({ target: appSettings.key, set: { value: String(value), updatedAt: new Date() } });
      }
      markDbHealthy();
    } catch (error) {
      markDbBroken(error instanceof Error ? error.message : "settings write failed");
    }
    if (patch.tickSeconds && this.running) {
      this.start();
    }
    return this.settings;
  }

  /* ------------------------------------------------------------------ بيانات تجريبية */

  async seedIfEmpty(force = false) {
    try {
      const existing = await db.select({ id: devices.id }).from(devices).limit(1);
      markDbHealthy();
      if (existing.length > 0 && !force) return false;

      if (force) {
        await db.delete(metricSamples);
        await db.delete(alerts);
        await db.delete(failoverEvents);
        await db.delete(ports);
        await db.delete(devices);
      }

      const seedDevices: {
        name: string;
        type: DeviceType;
        vendor: string;
        model: string;
        ipAddress: string | null;
        macAddress: string | null;
        location: string;
        rack: string;
        serialNumber: string;
        criticality: "low" | "medium" | "high" | "critical";
        probePort: number;
        probeMode?: ProbeMode;
        simProfile: SimProfile;
        linkRole?: "primary" | "backup" | "none";
        portCount: number;
      }[] = [
        { name: "الرابط الخارجي الرئيسي (فايبر 1G)", type: "uplink", vendor: "STC", model: "Fiber ONT X21", ipAddress: "10.0.0.1", macAddress: "A4:7B:2C:11:90:01", location: "غرفة المعلومات - المبنى أ", rack: "R1", serialNumber: "ONX21-0001", criticality: "critical", probePort: 443, simProfile: "stable", linkRole: "primary", portCount: 2 },
        { name: "الرابط الاحتياطي (LTE)", type: "uplink", vendor: "Mobily", model: "LTE Router B535", ipAddress: "10.0.0.2", macAddress: "A4:7B:2C:11:90:02", location: "غرفة المعلومات - المبنى أ", rack: "R1", serialNumber: "B535-0002", criticality: "critical", probePort: 443, simProfile: "stable", linkRole: "backup", portCount: 2 },
        { name: "الراوتر الأساسي", type: "router", vendor: "Cisco", model: "ISR 4331", ipAddress: "10.10.0.1", macAddress: "F8:66:C2:AA:10:01", location: "غرفة المعلومات - المبنى أ", rack: "R1", serialNumber: "ISR4331-7712", criticality: "critical", probePort: 22, simProfile: "stable", portCount: 8 },
        { name: "جدار الحماية", type: "firewall", vendor: "Fortinet", model: "FortiGate 100F", ipAddress: "10.10.0.254", macAddress: "90:6C:AC:BB:20:44", location: "غرفة المعلومات - المبنى أ", rack: "R1", serialNumber: "FG100F-3391", criticality: "critical", probePort: 443, simProfile: "stable", portCount: 12 },
        { name: "سويتش النواة Core-SW1", type: "switch", vendor: "Cisco", model: "Catalyst 9200-48P", ipAddress: "10.10.1.2", macAddress: "00:1B:0C:61:33:10", location: "غرفة المعلومات - المبنى أ", rack: "R2", serialNumber: "CAT9200-4811", criticality: "critical", probePort: 22, simProfile: "stable", portCount: 48 },
        { name: "سويتش الطابق الأول", type: "switch", vendor: "HP", model: "Aruba 2930F-24G", ipAddress: "10.10.1.11", macAddress: "3C:52:82:1A:5B:0F", location: "الطابق الأول - خزانة الشبكة", rack: "F1-SW", serialNumber: "ARB2930-1122", criticality: "high", probePort: 22, simProfile: "busy", portCount: 24 },
        { name: "سويتش الطابق الثاني", type: "switch", vendor: "TP-Link", model: "T1600G-28TS", ipAddress: "10.10.1.12", macAddress: "50:C2:E8:9C:71:22", location: "الطابق الثاني - خزانة الشبكة", rack: "F2-SW", serialNumber: "TPL1600-2831", criticality: "medium", probePort: 22, simProfile: "flaky", portCount: 24 },
        { name: "سويتش المخزن القديم", type: "switch", vendor: "D-Link", model: "DGS-1024D", ipAddress: "10.10.1.19", macAddress: "00:1C:F0:88:12:9A", location: "المخزن - المبنى ب", rack: "B1-SW", serialNumber: "DGS1024-0091", criticality: "low", probePort: 23, simProfile: "offline", portCount: 24 },
        { name: "نقطة وصول - الاستقبال", type: "access_point", vendor: "Ubiquiti", model: "UniFi U6 Pro", ipAddress: "10.10.20.11", macAddress: "78:8A:20:41:12:C1", location: "الاستقبال - الدور الأرضي", rack: "-", serialNumber: "U6PRO-0411", criticality: "medium", probePort: 443, simProfile: "flaky", portCount: 2 },
        { name: "نقطة وصول - قاعة الاجتماعات", type: "access_point", vendor: "Ubiquiti", model: "UniFi U6 Lite", ipAddress: "10.10.20.12", macAddress: "78:8A:20:41:12:C2", location: "قاعة الاجتماعات - الدور الأول", rack: "-", serialNumber: "U6LITE-0412", criticality: "medium", probePort: 443, simProfile: "stable", portCount: 2 },
        { name: "سيرفر الملفات والمتابعة", type: "server", vendor: "Dell", model: "PowerEdge R450", ipAddress: "10.10.30.5", macAddress: "B4:2E:99:31:AA:05", location: "غرفة المعلومات - المبنى أ", rack: "R3", serialNumber: "R450-9931", criticality: "high", probePort: 445, simProfile: "busy", portCount: 4 },
        { name: "لوحة التوصيل الرئيسية Patch Panel A", type: "patch_panel", vendor: "Legrand", model: "24-Port Cat6A", ipAddress: null, macAddress: null, location: "غرفة المعلومات - المبنى أ", rack: "R2", serialNumber: "LGR24-PP-A", criticality: "medium", probePort: 0, simProfile: "stable", portCount: 24 },
      ];

      const inserted = await db
        .insert(devices)
        .values(
          seedDevices.map((device, index) => ({
            name: device.name,
            type: device.type,
            vendor: device.vendor,
            model: device.model,
            serialNumber: device.serialNumber,
            ipAddress: device.ipAddress,
            macAddress: device.macAddress,
            location: device.location,
            rack: device.rack,
            linkRole: device.linkRole ?? "none",
            criticality: device.criticality,
            monitored: device.type !== "patch_panel",
            probeMode: device.probeMode ?? ("simulate" as ProbeMode),
            probePort: device.probePort,
            simProfile: device.simProfile,
            status: "unknown" as DeviceStatus,
          })),
        )
        .returning({ id: devices.id, type: devices.type, name: devices.name, status: devices.status });

      const switchNameById = new Map(inserted.map((row) => [row.id, row.name]));
      const portRows: (typeof ports.$inferInsert)[] = [];
      inserted.forEach((row, index) => {
        const spec = seedDevices[index];
        const isPanel = row.type === "patch_panel";
        const isAp = row.type === "access_point";
        for (let p = 1; p <= spec.portCount; p += 1) {
          const label = isAp ? `Port ${p}` : `${row.type === "patch_panel" ? "PP" : "Gi0"}/${p}`;
          const filled = p <= (isPanel ? 14 : isAp ? 1 : Math.round(spec.portCount * 0.45));
          const disabled = !isAp && !isPanel && p === spec.portCount;
          portRows.push({
            deviceId: row.id,
            label,
            portType: isPanel ? "patch" : p === 1 && !isAp ? "uplink" : "ethernet",
            status: disabled ? "disabled" : filled ? "up" : "free",
            speedMbps: isAp ? 1000 : row.type === "switch" ? 1000 : 1000,
            utilizationPct: 0,
            connectedTo: filled
              ? isPanel
                ? `مقبس ${10 + p} - الطابق ${(p % 2) + 1}`
                : p === 1 && !isAp
                  ? "الراوتر الأساسي"
                  : `جهاز ${100 + index}-${p} (PC/Printer/AP)`
              : null,
            vlan: filled ? (p % 4 === 0 ? 30 : p % 3 === 0 ? 20 : 10) : null,
            poe: isAp || (row.type === "switch" && p % 5 === 0),
          });
        }
      });
      // إدخال المنافذ على دفعات
      for (let i = 0; i < portRows.length; i += 200) {
        await db.insert(ports).values(portRows.slice(i, i + 200));
      }

      const channelCount = await db.select({ id: notificationChannels.id }).from(notificationChannels).limit(1);
      if (channelCount.length === 0) {
        await db.insert(notificationChannels).values([
          {
            name: "بوابة Webhook - نظام التذاكر",
            type: "webhook",
            target: "https://hooks.internal.example.com/netmon",
            enabled: true,
            isFallback: false,
            priority: 10,
          },
          {
            name: "البريد - مدير الشبكة",
            type: "email",
            target: "noc@example.com",
            enabled: true,
            isFallback: true,
            priority: 50,
          },
          {
            name: "سجل التنبيهات المحلي (Offline)",
            type: "log",
            target: "local://alert-log",
            enabled: true,
            isFallback: true,
            priority: 900,
          },
        ]);
      }

      await db.insert(alerts).values({
        type: "system",
        severity: "info",
        title: "تم تشغيل نظام المراقبة",
        message: `تمت تهيئة النظام ومراقبة ${inserted.length} جهازًا و${portRows.length} منفذًا`,
        status: "resolved",
        resolvedAt: new Date(),
      });

      logActivity(
        "info",
        `تمت تهيئة بيانات الشبكة: ${inserted.length} جهاز و${portRows.length} منفذ (${
          switchNameById.size > 0 ? "بيانات تجريبية" : "بيانات فعلية"
        })`,
      );
      return true;
    } catch (error) {
      markDbBroken(error instanceof Error ? error.message : "seed failed");
      logActivity("error", `تعذر تهيئة البيانات: ${error instanceof Error ? error.message : "خطأ"}`);
      return false;
    }
  }

  /* ------------------------------------------------------------------ دورة الفحص */

  private async probeOne(device: typeof devices.$inferSelect, now: number) {
    if (device.forceStatus === "maintenance") {
      return { probe: { up: false, latencyMs: 0, lossPct: 0, method: "simulate" as const }, load: EMPTY_LOAD, forced: true };
    }
    const probe = await probeDevice({
      id: device.id,
      name: device.name,
      ipAddress: device.ipAddress,
      probeMode: device.probeMode,
      probePort: device.probePort,
      simProfile: device.simProfile,
    });
    const finalProbe: ProbeResult =
      device.forceStatus === "down" ? { ...probe, up: false, latencyMs: 0, lossPct: 100 } : probe;
    const load = finalProbe.up
      ? deriveLoad(`${device.id}:${device.name}`, device.type, finalProbe.latencyMs, true, now)
      : EMPTY_LOAD;
    return { probe: finalProbe, load, forced: device.forceStatus === "down" };
  }

  async tick(): Promise<TickReport> {
    const startedAt = Date.now();
    if (this.ticking) {
      return {
        ranAt: new Date(startedAt).toISOString(),
        durationMs: 0,
        probes: 0,
        dbMode: this.dbMode,
        wanMode: this.wan.mode,
        newAlerts: 0,
        resolvedAlerts: 0,
        bufferedSamples: pendingSampleCount(),
      };
    }
    this.ticking = true;

    let newAlerts = 0;
    let resolvedAlerts = 0;

    try {
      await this.loadSettings();
      await this.seedIfEmpty();

      const rows = await db.select().from(devices).orderBy(asc(devices.id));
      markDbHealthy();
      this.dbMode = "primary";

      const now = Date.now();
      const uplinks = rows.filter((d) => d.type === "uplink");
      const others = rows.filter((d) => d.type !== "uplink");
      const primary = uplinks.find((d) => d.linkRole === "primary") ?? null;
      const backup = uplinks.find((d) => d.linkRole === "backup") ?? null;

      const measurements = new Map<number, { probe: ProbeResult; load: DeviceLoad }>();

      // 1) فحص روابط الاتصال الخارجي أولاً لتحديد المسار المستخدم
      for (const link of uplinks) {
        if (!link.monitored) continue;
        const result = await this.probeOne(link, now);
        measurements.set(link.id, { probe: result.probe, load: result.load });
      }

      const primaryUp = primary
        ? primary.forceStatus === "down"
          ? false
          : primary.forceStatus === "maintenance"
            ? false
            : (measurements.get(primary.id)?.probe.up ?? false)
        : false;
      const backupUp = backup
        ? backup.forceStatus === "down"
          ? false
          : (measurements.get(backup.id)?.probe.up ?? false)
        : false;

      const nextWanMode: WanMode = primaryUp ? "primary" : backupUp ? "backup" : "down";
      if (nextWanMode !== this.wan.mode) {
        await this.handleWanChange(nextWanMode, primary?.name ?? null, backup?.name ?? null, primaryUp, backupUp);
      }
      this.wan = {
        ...this.wan,
        mode: nextWanMode,
        activeLinkName: nextWanMode === "primary" ? (primary?.name ?? null) : nextWanMode === "backup" ? (backup?.name ?? null) : null,
        primaryName: primary?.name ?? null,
        backupName: backup?.name ?? null,
        primaryUp,
        backupUp,
        primaryLatencyMs: primary ? (measurements.get(primary.id)?.probe.latencyMs ?? null) : null,
        backupLatencyMs: backup ? (measurements.get(backup.id)?.probe.latencyMs ?? null) : null,
      };
      this.source = nextWanMode === "down" ? "cache" : nextWanMode === "backup" ? "backup" : "primary";

      // 2) فحص بقية الأجهزة على دفعات متوازية
      const chunkSize = 6;
      for (let i = 0; i < others.length; i += chunkSize) {
        const chunk = others.slice(i, i + chunkSize).filter((d) => d.monitored);
        const results = await Promise.all(
          chunk.map(async (device) => ({ device, result: await this.probeOne(device, now) })),
        );
        for (const item of results) {
          measurements.set(item.device.id, { probe: item.result.probe, load: item.result.load });
        }
      }

      // 3) تحديث الحالة وحساب التنبيهات
      const nowIso = new Date();
      const sampleRows: (typeof metricSamples.$inferInsert)[] = [];
      const deviceUpdates: { device: typeof devices.$inferSelect; status: DeviceStatus; probe: ProbeResult; load: DeviceLoad }[] = [];

      for (const device of rows) {
        const measurement = measurements.get(device.id);
        const previous = this.statuses.get(device.id) ?? device.status;

        if (!device.monitored) {
          this.statuses.set(device.id, "unknown");
          continue;
        }
        if (!measurement) {
          this.statuses.set(device.id, previous);
          continue;
        }

        const { probe, load } = measurement;
        let status: DeviceStatus;
        if (device.forceStatus === "maintenance") {
          status = "maintenance";
        } else if (!probe.up) {
          status = "down";
        } else if (
          probe.latencyMs > this.settings.latencyThresholdMs ||
          probe.lossPct > this.settings.lossThresholdPct ||
          load.utilPct > this.settings.utilizationThresholdPct
        ) {
          status = "degraded";
        } else {
          status = "up";
        }

        // عدّادات الانقطاع لتجنب التنبيهات العابرة (Flapping)
        if (status === "down") {
          this.failCounts.set(device.id, (this.failCounts.get(device.id) ?? 0) + 1);
          this.okCounts.set(device.id, 0);
        } else {
          this.okCounts.set(device.id, (this.okCounts.get(device.id) ?? 0) + 1);
          this.failCounts.set(device.id, 0);
        }

        sampleRows.push({
          deviceId: device.id,
          status,
          latencyMs: probe.up ? probe.latencyMs : null,
          lossPct: probe.lossPct,
          inMbps: load.inMbps,
          outMbps: load.outMbps,
          cpuPct: load.cpuPct,
          memPct: load.memPct,
          source: this.source,
          createdAt: nowIso,
        });

        deviceUpdates.push({ device, status, probe, load });

        const isUplink = device.type === "uplink";
        const failures = this.failCounts.get(device.id) ?? 0;
        const successes = this.okCounts.get(device.id) ?? 0;

        // تنبيه الانقطاع
        if (status === "down" && failures >= this.settings.downFailThreshold) {
          const created = await this.raiseAlert({
            deviceId: device.id,
            deviceName: device.name,
            type: "device_down",
            severity: device.criticality === "critical" || isUplink ? "critical" : "warning",
            title: `انقطاع في ${device.name}`,
            message:
              isUplink && nextWanMode !== "down"
                ? `انقطع الرابط وتم التحويل تلقائيًا إلى المسار الاحتياطي`
                : `الجهاز لا يستجيب على ${device.ipAddress ?? "العنوان المسجل"} منذ ${failures} فحصًا`,
            value: probe.error ?? `loss ${probe.lossPct}%`,
          });
          if (created) newAlerts += 1;
        }

        if (previous !== "down" && status === "down" && failures < this.settings.downFailThreshold) {
          logActivity("warn", `فقدان الاتصال بـ ${device.name} (فحص ${failures})`);
        }

        // تنبيه التدهور
        if (status === "degraded") {
          if (probe.latencyMs > this.settings.latencyThresholdMs) {
            const created = await this.raiseAlert({
              deviceId: device.id,
              deviceName: device.name,
              type: "high_latency",
              severity: "warning",
              title: `ارتفاع زمن الاستجابة في ${device.name}`,
              message: `زمن الاستجابة ${probe.latencyMs}ms تجاوز الحد المسموح (${this.settings.latencyThresholdMs}ms)`,
              value: `${probe.latencyMs} ms`,
            });
            if (created) newAlerts += 1;
          }
          if (load.utilPct > this.settings.utilizationThresholdPct) {
            const created = await this.raiseAlert({
              deviceId: device.id,
              deviceName: device.name,
              type: "high_utilization",
              severity: "warning",
              title: `ارتفاع استهلاك الشبكة في ${device.name}`,
              message: `استهلاك الوصلات وصل إلى ${load.utilPct}% (${load.inMbps + load.outMbps} Mbps)`,
              value: `${load.utilPct}%`,
            });
            if (created) newAlerts += 1;
          }
          if (probe.lossPct > this.settings.lossThresholdPct) {
            const created = await this.raiseAlert({
              deviceId: device.id,
              deviceName: device.name,
              type: "packet_loss",
              severity: "warning",
              title: `فقدان حزم في ${device.name}`,
              message: `نسبة فقدان الحزم ${probe.lossPct}%`,
              value: `${probe.lossPct}%`,
            });
            if (created) newAlerts += 1;
          }
        }

        // التعافي
        if (previous === "down" && status !== "down" && successes === 1) {
          const count = await this.resolveAlertsForDevice(device.id, device.name);
          resolvedAlerts += count;
        }
        if (previous === "degraded" && status === "up" && successes === 1) {
          const count = await this.resolveAlertsForDevice(device.id, device.name);
          resolvedAlerts += count;
        }

        this.statuses.set(device.id, status);
      }

      // 4) كتابة النتائج (مع مخزن مؤقت عند تعذر الوصول لقاعدة البيانات)
      try {
        for (const item of deviceUpdates) {
          const changed = (this.statuses.get(item.device.id) ?? item.status) !== item.device.status;
          await db
            .update(devices)
            .set({
              status: item.status,
              lastLatencyMs: item.probe.up ? item.probe.latencyMs : null,
              lastLossPct: item.probe.lossPct,
              lastInMbps: item.load.inMbps,
              lastOutMbps: item.load.outMbps,
              lastCpuPct: item.load.cpuPct,
              lastMemPct: item.load.memPct,
              uptimeSeconds: item.load.uptimeSeconds,
              failCount: this.failCounts.get(item.device.id) ?? 0,
              okCount: this.okCounts.get(item.device.id) ?? 0,
              lastSeenAt: item.probe.up ? nowIso : item.device.lastSeenAt,
              lastStatusChangeAt: changed ? nowIso : item.device.lastStatusChangeAt,
              updatedAt: nowIso,
            })
            .where(eq(devices.id, item.device.id));

          if (changed && item.device.status !== item.status) {
            const portStatus = item.status === "down" ? "down" : item.status === "maintenance" ? "disabled" : "up";
            await db
              .update(ports)
              .set({ status: portStatus, lastSeenAt: item.probe.up ? nowIso : null })
              .where(and(eq(ports.deviceId, item.device.id), eq(ports.status, item.status === "down" ? "up" : "down")));
          }
        }

        if (sampleRows.length > 0) {
          await db.insert(metricSamples).values(sampleRows);
        }

        // إرسال القياسات المعلقة عند عودة الاتصال بقاعدة البيانات
        const pending = takePendingSamples(500);
        if (pending.length > 0) {
          await db.insert(metricSamples).values(
            pending.map((sample) => ({
              deviceId: sample.deviceId,
              status: sample.status as DeviceStatus,
              latencyMs: sample.latencyMs,
              lossPct: sample.lossPct,
              inMbps: sample.inMbps,
              outMbps: sample.outMbps,
              cpuPct: sample.cpuPct,
              memPct: sample.memPct,
              source: sample.source,
              createdAt: new Date(sample.createdAt),
            })),
          );
          logActivity("info", `تمت مزامنة ${pending.length} قياسًا محفوظًا مؤقتًا أثناء انقطاع قاعدة البيانات`);
        }

        // تنظيف القياسات القديمة
        if (this.ticks % 30 === 0) {
          await db.execute(
            sql`delete from metric_samples where created_at < now() - (${this.settings.retentionHours} || ' hours')::interval`,
          );
        }
      } catch (error) {
        markDbBroken(error instanceof Error ? error.message : "write failed");
        this.dbMode = "fallback";
        queueSamples(
          sampleRows.map((row) => ({
            deviceId: row.deviceId,
            status: String(row.status),
            latencyMs: row.latencyMs ?? null,
            lossPct: row.lossPct ?? null,
            inMbps: row.inMbps ?? null,
            outMbps: row.outMbps ?? null,
            cpuPct: row.cpuPct ?? null,
            memPct: row.memPct ?? null,
            source: this.source,
            createdAt: (row.createdAt as Date).toISOString(),
          })),
        );
        logActivity("warn", "تم تخزين القياسات محليًا مؤقتًا حتى عودة قاعدة البيانات");
      }

      this.probes += measurements.size;
      this.ticks += 1;
      this.lastTickAt = new Date().toISOString();
      this.lastTickDurationMs = Date.now() - startedAt;

      await this.refreshSeriesFromDb();
      const overview = await this.buildOverview();
      await saveSnapshot(overview);

      return {
        ranAt: this.lastTickAt,
        durationMs: this.lastTickDurationMs,
        probes: measurements.size,
        dbMode: this.dbMode,
        wanMode: this.wan.mode,
        newAlerts,
        resolvedAlerts,
        bufferedSamples: pendingSampleCount(),
      };
    } catch (error) {
      markDbBroken(error instanceof Error ? error.message : "tick failed");
      this.dbMode = "fallback";
      this.lastTickAt = new Date().toISOString();
      this.lastTickDurationMs = Date.now() - startedAt;
      logActivity("error", `تعذرت دورة الفحص على قاعدة البيانات، العمل على النسخة الاحتياطية`);
      const cached = cachedOverview();
      if (cached) await saveSnapshot({ ...cached, db: { mode: "fallback", detail: "يعمل على اللقطة المحلية", pendingSamples: pendingSampleCount() } });
      return {
        ranAt: this.lastTickAt,
        durationMs: this.lastTickDurationMs,
        probes: 0,
        dbMode: "fallback",
        wanMode: this.wan.mode,
        newAlerts,
        resolvedAlerts,
        bufferedSamples: pendingSampleCount(),
      };
    } finally {
      this.ticking = false;
    }
  }

  /* ------------------------------------------------------------------ الروابط الاحتياطية */

  private async handleWanChange(
    mode: WanMode,
    primaryName: string | null,
    backupName: string | null,
    primaryUp: boolean,
    backupUp: boolean,
  ) {
    const now = new Date();
    const previousSince = this.wan.since ? new Date(this.wan.since) : now;
    const duration = Math.round((now.getTime() - previousSince.getTime()) / 1000);

    try {
      if (mode === "backup") {
        await db.insert(failoverEvents).values({
          kind: "failover",
          fromLink: primaryName,
          toLink: backupName,
          reason: "انقطاع الرابط الرئيسي والتحويل التلقائي للرابط الاحتياطي",
          startedAt: now,
        });
      } else if (mode === "primary" && this.wan.mode === "backup") {
        await db.insert(failoverEvents).values({
          kind: "failback",
          fromLink: backupName,
          toLink: primaryName,
          reason: "عودة الرابط الرئيسي وإعادة التحويل إليه",
          startedAt: now,
          endedAt: now,
          durationSeconds: duration,
        });
      } else if (mode === "down") {
        await db.insert(failoverEvents).values({
          kind: "outage",
          fromLink: primaryName,
          toLink: null,
          reason: "انقطاع جميع روابط الاتصال الخارجي",
          startedAt: now,
        });
      } else if (mode === "primary" && this.wan.mode === "down") {
        await db.insert(failoverEvents).values({
          kind: "failback",
          fromLink: null,
          toLink: primaryName,
          reason: "استعادة الاتصال الخارجي",
          startedAt: now,
          endedAt: now,
          durationSeconds: duration,
        });
      }
      markDbHealthy();
    } catch (error) {
      markDbBroken(error instanceof Error ? error.message : "failover event failed");
    }

    const title =
      mode === "backup"
        ? "تم التحويل إلى الرابط الاحتياطي"
        : mode === "down"
          ? "انقطاع كامل في الاتصال الخارجي"
          : "العودة إلى الرابط الرئيسي";

    const message =
      mode === "backup"
        ? `الرابط الرئيسي (${primaryName ?? "غير معروف"}) منقطع، والمراقبة تعمل الآن عبر ${backupName ?? "الرابط الاحتياطي"}`
        : mode === "down"
          ? "جميع روابط الاتصال الخارجي منقطعة، تم تخزين البيانات محليًا وسيتم إرسال التنبيهات عند عودة الاتصال"
          : `الرابط الرئيسي (${primaryName ?? ""}) يعمل بشكل طبيعي`;

    if (mode === "primary" && this.wan.mode !== "primary") {
      try {
        await db
          .update(alerts)
          .set({ status: "resolved", resolvedAt: now })
          .where(and(inArray(alerts.type, ["wan_failover", "wan_down"]), inArray(alerts.status, ["active", "acknowledged"])));
        markDbHealthy();
      } catch (error) {
        markDbBroken(error instanceof Error ? error.message : "resolve wan alerts failed");
      }
    }

    this.wan.since = now.toISOString();
    logActivity(mode === "primary" ? "info" : "warn", message);

    await this.raiseAlert({
      deviceId: null,
      deviceName: primaryName,
      type: mode === "backup" ? "wan_failover" : mode === "down" ? "wan_down" : "recovered",
      severity: mode === "primary" ? "info" : "critical",
      title,
      message,
      value: mode,
    });
  }

  /** محاكاة انقطاع الرابط الرئيسي لاختبار التحويل التلقائي */
  async setLinkSimulation(target: "primary" | "backup" | "off", down: boolean) {
    try {
      const rows = await db.select().from(devices).where(eq(devices.type, "uplink"));
      for (const link of rows) {
        if (target !== "off" && link.linkRole !== target) continue;
        const value = target === "off" ? "none" : down ? "down" : "none";
        await db
          .update(devices)
          .set({ forceStatus: value, updatedAt: new Date() })
          .where(eq(devices.id, link.id));
        this.statuses.set(link.id, down ? "down" : "up");
      }
      logActivity("info", target === "off" ? "تم إلغاء محاكاة أعطال الروابط" : `محاكاة ${down ? "انقطاع" : "تشغيل"} الرابط ${target}`);
      return { ok: true };
    } catch (error) {
      markDbBroken(error instanceof Error ? error.message : "simulation failed");
      return { ok: false, error: error instanceof Error ? error.message : "error" };
    }
  }

  /* ------------------------------------------------------------------ التنبيهات */

  private async raiseAlert(input: {
    deviceId: number | null;
    deviceName: string | null;
    type: AlertType;
    severity: "info" | "warning" | "critical";
    title: string;
    message: string;
    value: string | null;
  }): Promise<boolean> {
    const payload = {
      deviceId: input.deviceId,
      type: input.type,
      status: "active" as const,
    };
    try {
      const existing = await db
        .select({ id: alerts.id })
        .from(alerts)
        .where(
          input.deviceId === null
            ? and(eq(alerts.type, input.type), eq(alerts.status, "active"), eq(alerts.title, input.title))
            : and(eq(alerts.deviceId, input.deviceId), eq(alerts.type, input.type), inArray(alerts.status, ["active", "acknowledged"])),
        )
        .limit(1);
      if (existing.length > 0) return false;

      const inserted = await db
        .insert(alerts)
        .values({
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          type: input.type as never,
          severity: input.severity,
          title: input.title,
          message: input.message,
          value: input.value,
          status: "active",
        })
        .returning({ id: alerts.id });

      const alertRecord = {
        id: inserted[0]?.id ?? null,
        deviceName: input.deviceName,
        severity: input.severity,
        title: input.title,
        message: input.message,
        value: input.value,
      };

      if (this.settings.notificationsEnabled) {
        void deliverAlert(alertRecord).catch(() => undefined);
      } else {
        queueAlert({
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          type: input.type,
          severity: input.severity,
          title: input.title,
          message: input.message,
          value: input.value,
          createdAt: new Date().toISOString(),
        });
      }
      return true;
    } catch (error) {
      markDbBroken(error instanceof Error ? error.message : "alert write failed");
      queueAlert({
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        type: input.type,
        severity: input.severity,
        title: input.title,
        message: input.message,
        value: input.value,
        createdAt: new Date().toISOString(),
      });
      return true;
    }
  }

  private async resolveAlertsForDevice(deviceId: number, deviceName: string) {
    try {
      const updated = await db
        .update(alerts)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(and(eq(alerts.deviceId, deviceId), inArray(alerts.status, ["active", "acknowledged"])))
        .returning({ id: alerts.id });
      if (updated.length > 0) {
        logActivity("info", `تعافى الجهاز ${deviceName} وتم إغلاق ${updated.length} تنبيهًا`);
      }
      return updated.length;
    } catch {
      return 0;
    }
  }

  /* ------------------------------------------------------------------ اللقطة العامة */

  private async refreshSeriesFromDb() {
    try {
      const rows = await db
        .select({
          createdAt: metricSamples.createdAt,
          latencyMs: metricSamples.latencyMs,
          inMbps: metricSamples.inMbps,
          outMbps: metricSamples.outMbps,
        })
        .from(metricSamples)
        .orderBy(desc(metricSamples.createdAt))
        .limit(400);

      const buckets = new Map<string, { latSum: number; latCount: number; inSum: number; outSum: number }>();
      for (const row of rows) {
        const key = new Date(row.createdAt).toISOString().slice(0, 16);
        const bucket = buckets.get(key) ?? { latSum: 0, latCount: 0, inSum: 0, outSum: 0 };
        if (row.latencyMs !== null) {
          bucket.latSum += row.latencyMs;
          bucket.latCount += 1;
        }
        bucket.inSum += row.inMbps ?? 0;
        bucket.outSum += row.outMbps ?? 0;
        buckets.set(key, bucket);
      }
      const ordered = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-40);
      this.latencySeries = ordered.map(([key, value]) => ({
        t: `${key}:00`,
        v: value.latCount > 0 ? Math.round((value.latSum / value.latCount) * 10) / 10 : 0,
      }));
      this.trafficSeries = ordered.map(([key, value]) => ({
        t: `${key}:00`,
        inMbps: Math.round(value.inSum * 10) / 10,
        outMbps: Math.round(value.outSum * 10) / 10,
      }));
    } catch {
      // في حال تعذر القراءة نُبقي السلاسل المحلية كما هي
    }
  }

  async buildOverview(): Promise<Overview> {
    try {
      const [deviceRows, portAgg, alertRows, channelRows, failoverRows] = await Promise.all([
        db.select().from(devices).orderBy(asc(devices.id)),
        db
          .select({
            deviceId: ports.deviceId,
            total: sql<number>`count(*)::int`,
            used: sql<number>`sum(case when ${ports.status} in ('up','down') then 1 else 0 end)::int`,
          })
          .from(ports)
          .groupBy(ports.deviceId),
        db.select().from(alerts).orderBy(desc(alerts.createdAt)).limit(40),
        db.select().from(notificationChannels).orderBy(asc(notificationChannels.priority)),
        db.select().from(failoverEvents).orderBy(desc(failoverEvents.startedAt)).limit(8),
      ]);
      markDbHealthy();
      this.dbMode = "primary";

      const portMap = new Map(portAgg.map((row) => [row.deviceId, row]));

      const deviceViews: DeviceView[] = deviceRows.map((device) => {
        const agg = portMap.get(device.id);
        const util =
          device.lastInMbps !== null && device.lastOutMbps !== null
            ? Math.min(
                100,
                Math.round(((device.lastInMbps + device.lastOutMbps) / (2 * capacityOf(device.type))) * 1000) / 10,
              )
            : null;
        return {
          id: device.id,
          name: device.name,
          type: device.type,
          status: device.status,
          ipAddress: device.ipAddress,
          macAddress: device.macAddress,
          model: device.model,
          vendor: device.vendor,
          location: device.location,
          rack: device.rack,
          criticality: device.criticality,
          linkRole: device.linkRole,
          monitored: device.monitored,
          probeMode: device.probeMode,
          simProfile: device.simProfile,
          latencyMs: device.lastLatencyMs,
          lossPct: device.lastLossPct,
          inMbps: device.lastInMbps,
          outMbps: device.lastOutMbps,
          cpuPct: device.lastCpuPct,
          memPct: device.lastMemPct,
          utilPct: util,
          uptimeSeconds: device.uptimeSeconds,
          portsUsed: agg?.used ?? 0,
          portsTotal: agg?.total ?? 0,
          lastSeenAt: device.lastSeenAt ? new Date(device.lastSeenAt).toISOString() : null,
          lastStatusChangeAt: new Date(device.lastStatusChangeAt).toISOString(),
        };
      });

      const alertViews: AlertView[] = alertRows.map((alert) => ({
        id: alert.id,
        deviceId: alert.deviceId,
        deviceName: alert.deviceName,
        type: alert.type,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        value: alert.value,
        status: alert.status,
        createdAt: new Date(alert.createdAt).toISOString(),
        acknowledgedAt: alert.acknowledgedAt ? new Date(alert.acknowledgedAt).toISOString() : null,
        resolvedAt: alert.resolvedAt ? new Date(alert.resolvedAt).toISOString() : null,
      }));

      const latencyValues = deviceViews.filter((d) => d.monitored && d.latencyMs !== null).map((d) => d.latencyMs ?? 0);
      const portsUsedTotal = deviceViews.reduce((sum, d) => sum + d.portsUsed, 0);
      const portsTotalAll = deviceViews.reduce((sum, d) => sum + d.portsTotal, 0);

      return {
        generatedAt: new Date().toISOString(),
        db: {
          mode: "primary",
          detail: "متصل بقاعدة البيانات الرئيسية",
          pendingSamples: pendingSampleCount(),
        },
        monitor: {
          running: this.running,
          startedAt: this.startedAt,
          lastTickAt: this.lastTickAt,
          nextTickAt: this.lastTickAt
            ? new Date(new Date(this.lastTickAt).getTime() + this.settings.tickSeconds * 1000).toISOString()
            : null,
          tickSeconds: this.settings.tickSeconds,
          lastTickDurationMs: this.lastTickDurationMs,
          ticks: this.ticks,
          probes: this.probes,
          source: this.source,
        },
        wan: { ...this.wan },
        kpis: {
          devicesTotal: deviceViews.length,
          devicesUp: deviceViews.filter((d) => d.status === "up").length,
          devicesDown: deviceViews.filter((d) => d.status === "down").length,
          devicesDegraded: deviceViews.filter((d) => d.status === "degraded").length,
          alertsActive: alertViews.filter((a) => a.status === "active" || a.status === "acknowledged").length,
          alertsCritical: alertViews.filter((a) => a.severity === "critical" && a.status !== "resolved").length,
          avgLatencyMs:
            latencyValues.length > 0
              ? Math.round((latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length) * 10) / 10
              : 0,
          totalInMbps: Math.round(deviceViews.reduce((sum, d) => sum + (d.inMbps ?? 0), 0) * 10) / 10,
          totalOutMbps: Math.round(deviceViews.reduce((sum, d) => sum + (d.outMbps ?? 0), 0) * 10) / 10,
          portsUsed: portsUsedTotal,
          portsFree: Math.max(0, portsTotalAll - portsUsedTotal),
          portsTotal: portsTotalAll,
        },
        devices: deviceViews,
        alerts: alertViews,
        channels: channelRows.map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          target: channel.target,
          enabled: channel.enabled,
          isFallback: channel.isFallback,
          priority: channel.priority,
          lastStatus: channel.lastStatus,
          lastSentAt: channel.lastSentAt ? new Date(channel.lastSentAt).toISOString() : null,
        })),
        failoverLog: failoverRows.map((event) => ({
          id: event.id,
          kind: event.kind,
          fromLink: event.fromLink,
          toLink: event.toLink,
          reason: event.reason,
          startedAt: new Date(event.startedAt).toISOString(),
          endedAt: event.endedAt ? new Date(event.endedAt).toISOString() : null,
          durationSeconds: event.durationSeconds,
        })),
        latencySeries: this.latencySeries,
        trafficSeries: this.trafficSeries,
        activity: getActivityLog(),
        settings: this.settings,
      };
    } catch (error) {
      markDbBroken(error instanceof Error ? error.message : "overview read failed");
      this.dbMode = "fallback";
      const cached = cachedOverview() ?? (await readDiskSnapshot());
      if (cached) {
        return {
          ...cached,
          generatedAt: new Date().toISOString(),
          db: {
            mode: "fallback",
            detail: "تعذر الوصول لقاعدة البيانات — يتم العرض من اللقطة الاحتياطية المحفوظة محليًا",
            pendingSamples: pendingSampleCount(),
          },
          activity: getActivityLog(),
        };
      }
      return {
        generatedAt: new Date().toISOString(),
        db: { mode: "fallback", detail: "لا توجد لقطة محفوظة بعد", pendingSamples: pendingSampleCount() },
        monitor: {
          running: this.running,
          startedAt: this.startedAt,
          lastTickAt: this.lastTickAt,
          nextTickAt: null,
          tickSeconds: this.settings.tickSeconds,
          lastTickDurationMs: this.lastTickDurationMs,
          ticks: this.ticks,
          probes: this.probes,
          source: "cache",
        },
        wan: { ...this.wan },
        kpis: {
          devicesTotal: 0,
          devicesUp: 0,
          devicesDown: 0,
          devicesDegraded: 0,
          alertsActive: 0,
          alertsCritical: 0,
          avgLatencyMs: 0,
          totalInMbps: 0,
          totalOutMbps: 0,
          portsUsed: 0,
          portsFree: 0,
          portsTotal: 0,
        },
        devices: [],
        alerts: [],
        channels: [],
        failoverLog: [],
        latencySeries: [],
        trafficSeries: [],
        activity: getActivityLog(),
        settings: this.settings,
      };
    }
  }

  async getOverview(force = false): Promise<Overview> {
    const stale =
      !this.lastTickAt || Date.now() - new Date(this.lastTickAt).getTime() > this.settings.tickSeconds * 1000;
    if (force || stale || this.ticks === 0) {
      await this.tick();
    }
    const fresh = await this.buildOverview();
    if (fresh.db.mode === "primary") {
      await saveSnapshot(fresh);
      return fresh;
    }
    const cached = cachedOverview();
    return cached ?? fresh;
  }

  /* ------------------------------------------------------------------ التشغيل */

  start() {
    if (this.timer) clearTimeout(this.timer);
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (error) {
        logActivity("error", `خطأ في دورة المراقبة: ${error instanceof Error ? error.message : "غير معروف"}`);
      }
      if (this.running) {
        this.timer = setTimeout(loop, Math.max(5, this.settings.tickSeconds) * 1000);
      }
    };
    this.timer = setTimeout(loop, 1500);
    logActivity("info", `تم تشغيل محرك المراقبة بفاصل ${this.settings.tickSeconds} ثانية`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export function getMonitor(): NetworkMonitor {
  const g = globalThis as MonitorGlobal;
  if (!g.__netmonMonitor) {
    g.__netmonMonitor = new NetworkMonitor();
    g.__netmonMonitor.startedAt = new Date().toISOString();
  }
  return g.__netmonMonitor;
}

export async function ensureMonitorRunning() {
  const monitor = getMonitor();
  if (!monitor.running) {
    monitor.start();
  }
  return monitor;
}

export { simulateProbe };
