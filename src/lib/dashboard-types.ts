import type { AlertStatus, DeviceStatus, DeviceType, Severity, SimProfile } from "@/db/schema";

export type MonitorSettings = {
  tickSeconds: number;
  latencyThresholdMs: number;
  utilizationThresholdPct: number;
  lossThresholdPct: number;
  downFailThreshold: number;
  retentionHours: number;
  notificationsEnabled: boolean;
};

export const DEFAULT_SETTINGS: MonitorSettings = {
  tickSeconds: 10,
  latencyThresholdMs: 180,
  utilizationThresholdPct: 80,
  lossThresholdPct: 8,
  downFailThreshold: 2,
  retentionHours: 24,
  notificationsEnabled: true,
};

export type DeviceView = {
  id: number;
  name: string;
  type: DeviceType;
  status: DeviceStatus;
  ipAddress: string | null;
  macAddress: string | null;
  model: string | null;
  vendor: string | null;
  location: string | null;
  rack: string | null;
  criticality: string;
  linkRole: string;
  monitored: boolean;
  probeMode: string;
  simProfile: SimProfile;
  latencyMs: number | null;
  lossPct: number | null;
  inMbps: number | null;
  outMbps: number | null;
  cpuPct: number | null;
  memPct: number | null;
  utilPct: number | null;
  uptimeSeconds: number;
  portsUsed: number;
  portsTotal: number;
  lastSeenAt: string | null;
  lastStatusChangeAt: string | null;
};

export type AlertView = {
  id: number;
  deviceId: number | null;
  deviceName: string | null;
  type: string;
  severity: Severity;
  title: string;
  message: string;
  value: string | null;
  status: AlertStatus;
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
};

export type ChannelView = {
  id: number;
  name: string;
  type: string;
  target: string;
  enabled: boolean;
  isFallback: boolean;
  priority: number;
  lastStatus: string;
  lastSentAt: string | null;
};

export type FailoverView = {
  id: number;
  kind: string;
  fromLink: string | null;
  toLink: string | null;
  reason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
};

export type Overview = {
  generatedAt: string;
  /** حالة قاعدة البيانات: primary = متصلة، fallback = يعمل على النسخة الاحتياطية/اللقطة المحلية */
  db: { mode: "primary" | "fallback"; detail: string; pendingSamples: number };
  monitor: {
    running: boolean;
    startedAt: string;
    lastTickAt: string | null;
    nextTickAt: string | null;
    tickSeconds: number;
    lastTickDurationMs: number;
    ticks: number;
    probes: number;
    source: "primary" | "backup" | "cache";
  };
  wan: {
    mode: "primary" | "backup" | "down";
    activeLinkName: string | null;
    primaryName: string | null;
    backupName: string | null;
    primaryUp: boolean;
    backupUp: boolean;
    primaryLatencyMs: number | null;
    backupLatencyMs: number | null;
    since: string | null;
    simulated: boolean;
  };
  kpis: {
    devicesTotal: number;
    devicesUp: number;
    devicesDown: number;
    devicesDegraded: number;
    alertsActive: number;
    alertsCritical: number;
    avgLatencyMs: number;
    totalInMbps: number;
    totalOutMbps: number;
    portsUsed: number;
    portsFree: number;
    portsTotal: number;
  };
  devices: DeviceView[];
  alerts: AlertView[];
  channels: ChannelView[];
  failoverLog: FailoverView[];
  latencySeries: { t: string; v: number }[];
  trafficSeries: { t: string; inMbps: number; outMbps: number }[];
  activity: { at: string; level: string; message: string }[];
  settings: MonitorSettings;
};

export const DEVICE_TYPE_LABELS: Record<string, string> = {
  router: "راوتر",
  switch: "سويتش",
  firewall: "جدار حماية",
  access_point: "نقطة وصول",
  patch_panel: "لوحة توصيل",
  server: "سيرفر",
  ups: "UPS",
  uplink: "رابط خارجي",
};

export const STATUS_LABELS: Record<string, string> = {
  up: "متصله",
  down: "منقطعة",
  degraded: "متدهورة",
  unknown: "غير معروفة",
  maintenance: "صيانة",
};

export const SEVERITY_LABELS: Record<string, string> = {
  info: "معلومة",
  warning: "تحذير",
  critical: "خطر",
};

export const ALERT_TYPE_LABELS: Record<string, string> = {
  device_down: "انقطاع جهاز",
  device_degraded: "تدهور الأداء",
  high_latency: "ارتفاع زمن الاستجابة",
  high_utilization: "ارتفاع استهلاك الشبكة",
  packet_loss: "فقدان حزم",
  port_down: "انقطاع منفذ",
  wan_failover: "تحويل للرابط الاحتياطي",
  wan_down: "انقطاع الاتصال الخارجي",
  recovered: "تعافي الخدمة",
  system: "النظام",
};
