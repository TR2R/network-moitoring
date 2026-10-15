import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * نظام مراقبة الشبكة - مخطط قاعدة البيانات
 * Network Monitoring System schema
 */

export type DeviceType =
  | "router"
  | "switch"
  | "firewall"
  | "access_point"
  | "patch_panel"
  | "server"
  | "ups"
  | "uplink";

export type DeviceStatus = "up" | "down" | "degraded" | "unknown" | "maintenance";
export type ProbeMode = "tcp" | "icmp" | "simulate";
export type SimProfile = "stable" | "busy" | "flaky" | "offline";
export type Severity = "info" | "warning" | "critical";
export type AlertStatus = "active" | "acknowledged" | "resolved";
export type PortStatus = "up" | "down" | "disabled" | "free";
export type LinkRole = "primary" | "backup" | "none";
export type ChannelType = "webhook" | "telegram" | "slack" | "email" | "sms" | "log";

export const devices = pgTable(
  "devices",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").$type<DeviceType>().notNull().default("switch"),
    vendor: text("vendor"),
    model: text("model"),
    serialNumber: text("serial_number"),
    ipAddress: text("ip_address"),
    macAddress: text("mac_address"),
    location: text("location"),
    rack: text("rack"),
    /** لأعمدة الربط الخارجي: primary أو backup */
    linkRole: text("link_role").$type<LinkRole>().notNull().default("none"),
    criticality: text("criticality")
      .$type<"low" | "medium" | "high" | "critical">()
      .notNull()
      .default("medium"),
    monitored: boolean("monitored").notNull().default(true),
    probeMode: text("probe_mode").$type<ProbeMode>().notNull().default("tcp"),
    probePort: integer("probe_port").default(443),
    simProfile: text("sim_profile").$type<SimProfile>().notNull().default("stable"),
    /** وضع الصيانة/الاختبار اليدوي */
    forceStatus: text("force_status").$type<DeviceStatus | "none">().notNull().default("none"),

    status: text("status").$type<DeviceStatus>().notNull().default("unknown"),
    lastLatencyMs: real("last_latency_ms"),
    lastLossPct: real("last_loss_pct"),
    lastInMbps: real("last_in_mbps"),
    lastOutMbps: real("last_out_mbps"),
    lastCpuPct: real("last_cpu_pct"),
    lastMemPct: real("last_mem_pct"),
    uptimeSeconds: integer("uptime_seconds").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    okCount: integer("ok_count").notNull().default(0),

    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastStatusChangeAt: timestamp("last_status_change_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("devices_status_idx").on(table.status)],
);

export const ports = pgTable(
  "ports",
  {
    id: serial("id").primaryKey(),
    deviceId: integer("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    portType: text("port_type")
      .$type<"ethernet" | "sfp" | "uplink" | "console" | "patch">()
      .notNull()
      .default("ethernet"),
    status: text("status").$type<PortStatus>().notNull().default("free"),
    speedMbps: integer("speed_mbps").notNull().default(1000),
    utilizationPct: real("utilization_pct").notNull().default(0),
    connectedTo: text("connected_to"),
    peerDeviceId: integer("peer_device_id"),
    vlan: integer("vlan"),
    poe: boolean("poe").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => [index("ports_device_idx").on(table.deviceId)],
);

export const metricSamples = pgTable(
  "metric_samples",
  {
    id: serial("id").primaryKey(),
    deviceId: integer("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    status: text("status").$type<DeviceStatus>().notNull().default("unknown"),
    latencyMs: real("latency_ms"),
    lossPct: real("loss_pct"),
    inMbps: real("in_mbps"),
    outMbps: real("out_mbps"),
    cpuPct: real("cpu_pct"),
    memPct: real("mem_pct"),
    /** المسار المستخدم في القياس: primary / backup / cache */
    source: text("source").$type<"primary" | "backup" | "cache">().notNull().default("primary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("metric_samples_device_time_idx").on(table.deviceId, table.createdAt)],
);

export const alerts = pgTable(
  "alerts",
  {
    id: serial("id").primaryKey(),
    deviceId: integer("device_id").references(() => devices.id, { onDelete: "cascade" }),
    deviceName: text("device_name"),
    type: text("type")
      .$type<
        | "device_down"
        | "device_degraded"
        | "high_latency"
        | "high_utilization"
        | "packet_loss"
        | "port_down"
        | "wan_failover"
        | "wan_down"
        | "recovered"
        | "system"
      >()
      .notNull(),
    severity: text("severity").$type<Severity>().notNull().default("warning"),
    title: text("title").notNull(),
    message: text("message").notNull(),
    value: text("value"),
    status: text("status").$type<AlertStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [index("alerts_status_idx").on(table.status, table.createdAt)],
);

export const notificationChannels = pgTable("notification_channels", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").$type<ChannelType>().notNull().default("webhook"),
  target: text("target").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  /** قناة احتياطية تعمل فقط عند فشل القنوات الأساسية */
  isFallback: boolean("is_fallback").notNull().default(false),
  priority: integer("priority").notNull().default(100),
  lastStatus: text("last_status").$type<"sent" | "failed" | "skipped" | "unknown">().notNull().default("unknown"),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notificationLogs = pgTable("notification_logs", {
  id: serial("id").primaryKey(),
  alertId: integer("alert_id").references(() => alerts.id, { onDelete: "cascade" }),
  channelName: text("channel_name").notNull(),
  channelType: text("channel_type").$type<ChannelType>().notNull().default("log"),
  via: text("via").$type<"primary" | "fallback">().notNull().default("primary"),
  status: text("status").$type<"sent" | "failed">().notNull().default("failed"),
  attempts: integer("attempts").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const failoverEvents = pgTable("failover_events", {
  id: serial("id").primaryKey(),
  kind: text("kind").$type<"failover" | "failback" | "outage">().notNull(),
  fromLink: text("from_link"),
  toLink: text("to_link"),
  reason: text("reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
});

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** جاهز للمرحلة الثانية/الثالثة: جرد الأجهزة والكيابل */
export const cables = pgTable("cables", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  label: text("label"),
  cableType: text("cable_type").$type<"cat6" | "cat6a" | "fiber" | "console" | "power">().notNull().default("cat6"),
  fromDeviceId: integer("from_device_id").references(() => devices.id, { onDelete: "set null" }),
  fromPort: text("from_port"),
  toDeviceId: integer("to_device_id").references(() => devices.id, { onDelete: "set null" }),
  toPort: text("to_port"),
  lengthM: real("length_m"),
  status: text("status").$type<"ok" | "suspect" | "broken" | "spare">().notNull().default("ok"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type Port = typeof ports.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type FailoverEvent = typeof failoverEvents.$inferSelect;
