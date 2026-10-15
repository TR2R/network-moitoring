"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLiveOverview, type ConnectionState } from "@/hooks/useLiveOverview";
import {
  ALERT_TYPE_LABELS,
  DEVICE_TYPE_LABELS,
  SEVERITY_LABELS,
  type DeviceView,
  type Overview,
} from "@/lib/dashboard-types";
import {
  Badge,
  Card,
  KpiCard,
  Sparkline,
  StatusDot,
  TrafficChart,
  UtilBar,
} from "@/components/ui";
import { formatUptime, relativeTime } from "@/lib/format";

const CONNECTION_LABELS: Record<ConnectionState, { text: string; tone: "green" | "amber" | "red" | "blue" }> = {
  live: { text: "بث مباشر", tone: "green" },
  polling: { text: "تحديث دوري (احتياطي)", tone: "amber" },
  offline: { text: "غير متصل — كاش محلي", tone: "red" },
  connecting: { text: "جارٍ الاتصال", tone: "blue" },
};

export default function Dashboard() {
  const { data, state, browserOnline, lastUpdate, pendingActions, send, refresh, flushQueue } = useLiveOverview();
  const [filter, setFilter] = useState<"all" | "up" | "down" | "degraded">("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  if (!data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-300">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-700 border-t-sky-400" />
          <p className="text-sm">جارٍ تحميل حالة الشبكة…</p>
        </div>
      </main>
    );
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const devices = filterDevices(data.devices, filter, search);
  const connection = CONNECTION_LABELS[state];

  return (
    <main className="min-h-screen bg-slate-950 pb-16 text-slate-200">
      <Header
        data={data}
        state={state}
        browserOnline={browserOnline}
        lastUpdate={lastUpdate}
        pendingActions={pendingActions}
        busy={busy}
        onTick={() => run(() => send("/api/monitor", { method: "POST" }))}
        onRefresh={() => run(() => refresh())}
        onFlush={() => run(() => flushQueue())}
        onToggleSettings={() => setShowSettings((value) => !value)}
        onToggleAdd={() => setShowAdd((value) => !value)}
      />

      <div className="mx-auto max-w-[1500px] space-y-4 px-4">
        <FailoverBanner data={data} busy={busy} send={send} />

        {data.db.mode === "fallback" ? (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-violet-500/30 bg-violet-500/10 px-4 py-3 text-xs text-violet-100">
            <span className="text-lg">💾</span>
            <div>
              <p className="font-semibold">قاعدة البيانات غير متاحة — النظام يعمل على النسخة الاحتياطية المحلية</p>
              <p className="opacity-80">
                {data.db.detail} · {data.db.pendingSamples} قياسًا بانتظار المزامنة · التنبيهات الجديدة تُخزَّن مؤقتًا وتُرسل عند العودة
              </p>
            </div>
          </div>
        ) : null}

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <KpiCard label="إجمالي الأجهزة" value={data.kpis.devicesTotal} icon="🧩" hint={`${data.kpis.portsTotal} منفذ`} />
          <KpiCard label="متصلة" value={data.kpis.devicesUp} tone="green" icon="🟢" hint="تعمل بشكل طبيعي" />
          <KpiCard label="منقطعة" value={data.kpis.devicesDown} tone="red" icon="🔴" hint="لا تستجيب للفحص" />
          <KpiCard label="متدهورة" value={data.kpis.devicesDegraded} tone="amber" icon="🟠" hint="زمن استجابة أو حمل مرتفع" />
          <KpiCard label="تنبيهات نشطة" value={data.kpis.alertsActive} tone={data.kpis.alertsActive > 0 ? "red" : "green"} icon="🔔" hint={`${data.kpis.alertsCritical} تنبيه خطر`} />
          <KpiCard label="متوسط الاستجابة" value={data.kpis.avgLatencyMs} unit="ms" tone="blue" icon="⏱️" hint={`الحد: ${data.settings.latencyThresholdMs}ms`} />
          <KpiCard label="مرور التحميل" value={data.kpis.totalInMbps} unit="Mbps" tone="violet" icon="⬇️" hint={`رفع: ${data.kpis.totalOutMbps} Mbps`} />
          <KpiCard label="منافذ مستخدمة" value={`${data.kpis.portsUsed}/${data.kpis.portsTotal}`} tone="slate" icon="🔌" hint={`فارغة: ${data.kpis.portsFree}`} />
        </section>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <div className="grid gap-4 md:grid-cols-2">
              <Card title="زمن الاستجابة" subtitle={`آخر ${data.latencySeries.length} قياس — الحد ${data.settings.latencyThresholdMs}ms`}>
                <Sparkline values={data.latencySeries.map((point) => point.v)} threshold={data.settings.latencyThresholdMs} color="#38bdf8" />
              </Card>
              <Card title="استهلاك الشبكة" subtitle="مجموع المرور على الأجهزة المراقبة">
                <TrafficChart series={data.trafficSeries} />
              </Card>
            </div>

            <Card
              title="الأجهزة والمنافذ"
              subtitle="اضغط على اسم الجهاز لعرض المنافذ والتفاصيل ورمز QR"
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="بحث بالاسم أو IP…"
                    className="w-40 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs outline-none placeholder:text-slate-500 focus:border-sky-500"
                  />
                  {(["all", "up", "degraded", "down"] as const).map((key) => (
                    <button
                      key={key}
                      onClick={() => setFilter(key)}
                      className={`rounded-lg px-2.5 py-1.5 text-[11px] transition ${
                        filter === key ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/40" : "bg-slate-800/70 text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {key === "all" ? "الكل" : key === "up" ? "متصلة" : key === "degraded" ? "متدهورة" : "منقطعة"}
                    </button>
                  ))}
                </div>
              }
            >
              <DevicesTable devices={devices} busy={busy} send={send} />
            </Card>

            {showAdd ? <AddDeviceForm send={send} onDone={() => setShowAdd(false)} /> : null}
            {showSettings ? <SettingsPanel data={data} send={send} /> : null}
          </div>

          <div className="space-y-4">
            <Card title="الروابط والاتصال الاحتياطي" subtitle="حالة المسار الأساسي والاحتياطي">
              <LinkStatus data={data} busy={busy} send={send} />
            </Card>
            <Card title="الاتصال الاحتياطي لقاعدة البيانات" subtitle="اختبار عمل النظام عند تعذر الوصول للخادم">
              <ResilienceCard data={data} busy={busy} send={send} />
            </Card>
            <Card title="قنوات التنبيه" subtitle="تُجرَّب القنوات الأساسية ثم الاحتياطية تلقائيًا">
              <ChannelsPanel data={data} send={send} busy={busy} />
            </Card>
            <Card title="سجل التحويل الاحتياطي" subtitle="أحداث فشل واستعادة الروابط">
              <FailoverLog data={data} />
            </Card>
            <AlertsPanel data={data} send={send} busy={busy} />
            <Card title="سجل النظام" subtitle="آخر عمليات محرك المراقبة">
              <ActivityLog data={data} />
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}

function filterDevices(devices: DeviceView[], filter: string, search: string) {
  const term = search.trim().toLowerCase();
  return devices.filter((device) => {
    if (filter !== "all" && device.status !== filter) return false;
    if (!term) return true;
    return (
      device.name.toLowerCase().includes(term) ||
      (device.ipAddress ?? "").includes(term) ||
      (device.location ?? "").toLowerCase().includes(term)
    );
  });
}

function Header({
  data,
  state,
  browserOnline,
  lastUpdate,
  pendingActions,
  busy,
  onTick,
  onRefresh,
  onFlush,
  onToggleSettings,
  onToggleAdd,
}: {
  data: Overview;
  state: ConnectionState;
  browserOnline: boolean;
  lastUpdate: string | null;
  pendingActions: number;
  busy: boolean;
  onTick: () => void;
  onRefresh: () => void;
  onFlush: () => void;
  onToggleSettings: () => void;
  onToggleAdd: () => void;
}) {
  const connection = CONNECTION_LABELS[state];
  return (
    <header className="sticky top-0 z-20 mb-4 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-sky-500/15 text-xl ring-1 ring-sky-500/30">🛰️</div>
          <div>
            <h1 className="text-base font-bold text-slate-100">نظام مراقبة الشبكة والتنبيهات</h1>
            <p className="text-[11px] text-slate-400">
              مراقبة السويتشات والراوترات والأجهزة — مع اتصال احتياطي عند الانقطاع
            </p>
          </div>
        </div>

        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Badge tone={connection.tone}>
            <StatusDot status={state === "live" ? "up" : state === "offline" ? "down" : "degraded"} pulse={state === "live"} />
            {connection.text}
          </Badge>
          <Badge tone={browserOnline ? "green" : "red"}>{browserOnline ? "اتصال المتصفح: متوفر" : "المتصفح غير متصل"}</Badge>
          <Badge tone={data.db.mode === "primary" ? "green" : "amber"}>
            قاعدة البيانات: {data.db.mode === "primary" ? "رئيسية" : "احتياطية"}
          </Badge>
          <Badge tone={data.wan.mode === "primary" ? "green" : data.wan.mode === "backup" ? "amber" : "red"}>
            مسار المراقبة: {data.wan.mode === "primary" ? "الرابط الرئيسي" : data.wan.mode === "backup" ? "الرابط الاحتياطي" : "بدون اتصال خارجي"}
          </Badge>
          {pendingActions > 0 ? (
            <button onClick={onFlush} className="rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] text-amber-200 ring-1 ring-amber-500/30">
              {pendingActions} إجراء معلق — إعادة الإرسال
            </button>
          ) : null}
          <span className="text-[11px] text-slate-500">آخر تحديث: {relativeTime(lastUpdate)}</span>
          <button onClick={onTick} disabled={busy} className="rounded-lg bg-sky-500/20 px-3 py-1.5 text-xs text-sky-200 ring-1 ring-sky-500/40 transition hover:bg-sky-500/30 disabled:opacity-50">
            فحص الآن
          </button>
          <button onClick={onRefresh} disabled={busy} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-slate-700 disabled:opacity-50">
            تحديث
          </button>
          <button onClick={onToggleAdd} className="rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-200 ring-1 ring-emerald-500/30 transition hover:bg-emerald-500/25">
            + جهاز
          </button>
          <button onClick={onToggleSettings} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-slate-700">
            الإعدادات
          </button>
        </div>
      </div>
      <div className="mx-auto max-w-[1500px] px-4 pb-2 text-[11px] text-slate-500">
        دورة الفحص كل {data.settings.tickSeconds} ثانية · {data.monitor.probes} فحصًا منفذًا · مصدر البيانات:{" "}
        {data.monitor.source === "primary" ? "الرابط الرئيسي" : data.monitor.source === "backup" ? "الرابط الاحتياطي" : "كاش محلي"}
        {data.db.pendingSamples > 0 ? ` · ${data.db.pendingSamples} قياسًا بانتظار المزامنة` : ""}
      </div>
    </header>
  );
}

function FailoverBanner({ data, busy, send }: { data: Overview; busy: boolean; send: (url: string, init?: RequestInit) => Promise<unknown> }) {
  const mode = data.wan.mode;
  if (mode === "primary") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-xs text-emerald-200">
        <StatusDot status="up" />
        <span>
          الاتصال عبر الرابط الرئيسي <b>{data.wan.primaryName ?? "—"}</b> — زمن الاستجابة {data.wan.primaryLatencyMs ?? "—"}ms ·
          الرابط الاحتياطي جاهز {data.wan.backupUp ? "(متصل)" : "(غير متصل)"}
        </span>
        <button
          onClick={() => void send("/api/simulate", { method: "POST", body: JSON.stringify({ target: "primary", down: true }) })}
          disabled={busy}
          className="ms-auto rounded-lg bg-amber-500/15 px-3 py-1.5 text-[11px] text-amber-200 ring-1 ring-amber-500/30 hover:bg-amber-500/25 disabled:opacity-50"
        >
          محاكاة قطع الرابط الرئيسي
        </button>
      </div>
    );
  }

  const danger = mode === "down";
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-xs ${
        danger ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-amber-500/30 bg-amber-500/10 text-amber-100"
      }`}
    >
      <span className="text-lg">{danger ? "⛔" : "🔁"}</span>
      <div className="space-y-0.5">
        <p className="font-semibold">
          {danger
            ? "انقطاع كامل في الاتصال الخارجي — النظام يعمل في وضع الطوارئ"
            : `تم التحويل تلقائيًا إلى الرابط الاحتياطي: ${data.wan.activeLinkName ?? "—"}`}
        </p>
        <p className="opacity-80">
          {danger
            ? "تم تخزين التنبيهات والقياسات محليًا وسيتم إرسالها عند عودة الاتصال."
            : `الرابط الرئيسي (${data.wan.primaryName ?? "—"}): زمن الاستجابة ${data.wan.primaryLatencyMs ?? "∞"} · الاحتياطي: ${
                data.wan.backupLatencyMs ?? "—"
              }ms · منذ ${relativeTime(data.wan.since)}`}
        </p>
      </div>
      <button
        onClick={() => void send("/api/simulate", { method: "POST", body: JSON.stringify({ target: "primary", down: false }) })}
        disabled={busy}
        className="ms-auto rounded-lg bg-emerald-500/20 px-3 py-1.5 text-[11px] text-emerald-100 ring-1 ring-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50"
      >
        إعادة الرابط الرئيسي
      </button>
    </div>
  );
}

function ResilienceCard({
  data,
  busy,
  send,
}: {
  data: Overview;
  busy: boolean;
  send: (url: string, init?: RequestInit) => Promise<unknown>;
}) {
  const fallback = data.db.mode === "fallback";
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-[11px] text-slate-400">
        <div className="flex items-center gap-2">
          <StatusDot status={fallback ? "down" : "up"} />
          <span className="font-semibold text-slate-200">
            {fallback ? "وضع الطوارئ (نسخة احتياطية)" : "متصل بقاعدة البيانات الرئيسية"}
          </span>
        </div>
        <p className="mt-2 leading-relaxed">{data.db.detail}</p>
        <p className="mt-1">
          قياسات بانتظار المزامنة: <b className="text-slate-200">{data.db.pendingSamples}</b>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void send("/api/resilience", { method: "POST", body: JSON.stringify({ action: "db-outage" }) })}
          disabled={busy || fallback}
          className="rounded-lg bg-red-500/15 px-2.5 py-1 text-[11px] text-red-200 ring-1 ring-red-500/30 hover:bg-red-500/25 disabled:opacity-40"
        >
          محاكاة انقطاع قاعدة البيانات
        </button>
        <button
          onClick={() => void send("/api/resilience", { method: "POST", body: JSON.stringify({ action: "db-restore" }) })}
          disabled={busy || !fallback}
          className="rounded-lg bg-emerald-500/15 px-2.5 py-1 text-[11px] text-emerald-200 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-40"
        >
          استعادة الاتصال
        </button>
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500">
        عند انقطاع قاعدة البيانات تُعرض اللقطة المحفوظة محليًا، وتُخزَّن التنبيهات والقياسات في مخزن مؤقت ثم تُزامن تلقائيًا عند عودة الاتصال.
      </p>
    </div>
  );
}

function LinkStatus({ data, busy, send }: { data: Overview; busy: boolean; send: (url: string, init?: RequestInit) => Promise<unknown> }) {
  const links = data.devices.filter((device) => device.type === "uplink");
  return (
    <div className="space-y-3">
      {links.map((link) => {
        const isPrimary = link.linkRole === "primary";
        const active = data.wan.mode === link.linkRole;
        return (
          <div key={link.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <div className="flex items-center gap-2">
              <StatusDot status={link.status} />
              <span className="text-xs font-semibold text-slate-100">{link.name}</span>
              <Badge tone={isPrimary ? "blue" : "violet"}>{isPrimary ? "أساسي" : "احتياطي"}</Badge>
              {active ? <Badge tone="green">قيد الاستخدام</Badge> : null}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
              <span>IP: {link.ipAddress ?? "—"}</span>
              <span>الاستجابة: {link.latencyMs !== null ? `${link.latencyMs}ms` : "—"}</span>
              <span>تحميل: {link.inMbps ?? 0} Mbps</span>
              <span>رفع: {link.outMbps ?? 0} Mbps</span>
            </div>
            <UtilBar value={link.utilPct} threshold={data.settings.utilizationThresholdPct} />
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => void send("/api/simulate", { method: "POST", body: JSON.stringify({ target: link.linkRole, down: true }) })}
                disabled={busy}
                className="rounded-lg bg-red-500/15 px-2.5 py-1 text-[11px] text-red-200 ring-1 ring-red-500/30 hover:bg-red-500/25 disabled:opacity-50"
              >
                قطع الرابط
              </button>
              <button
                onClick={() => void send("/api/simulate", { method: "POST", body: JSON.stringify({ target: link.linkRole, down: false }) })}
                disabled={busy}
                className="rounded-lg bg-emerald-500/15 px-2.5 py-1 text-[11px] text-emerald-200 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-50"
              >
                استعادة
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DevicesTable({
  devices,
  busy,
  send,
}: {
  devices: DeviceView[];
  busy: boolean;
  send: (url: string, init?: RequestInit) => Promise<unknown>;
}) {
  if (devices.length === 0) {
    return <p className="py-6 text-center text-xs text-slate-500">لا توجد أجهزة مطابقة</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-right text-xs">
        <thead className="text-[11px] text-slate-500">
          <tr className="border-b border-slate-800">
            <th className="pb-2 font-medium">الحالة</th>
            <th className="pb-2 font-medium">الجهاز</th>
            <th className="pb-2 font-medium">النوع</th>
            <th className="pb-2 font-medium">IP</th>
            <th className="pb-2 font-medium">الموقع</th>
            <th className="pb-2 font-medium">الاستجابة</th>
            <th className="pb-2 font-medium">الفقد</th>
            <th className="pb-2 font-medium">الاستهلاك</th>
            <th className="pb-2 font-medium">المنافذ</th>
            <th className="pb-2 font-medium">التشغيل</th>
            <th className="pb-2 font-medium">إجراء</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.id} className="border-b border-slate-900/80 transition hover:bg-slate-900/40">
              <td className="py-2">
                <StatusDot status={device.status} />
              </td>
              <td className="py-2">
                <Link href={`/devices/${device.id}`} className="font-semibold text-slate-100 hover:text-sky-300">
                  {device.name}
                </Link>
                <div className="text-[10px] text-slate-500">
                  {device.model ?? "—"} {device.monitored ? "" : "· غير مراقب"}
                </div>
              </td>
              <td className="py-2 text-slate-300">{DEVICE_TYPE_LABELS[device.type] ?? device.type}</td>
              <td className="py-2 tabular-nums text-slate-400">{device.ipAddress ?? "—"}</td>
              <td className="py-2 text-slate-400">{device.location ?? "—"}</td>
              <td className={`py-2 tabular-nums ${device.latencyMs !== null && device.latencyMs > 150 ? "text-amber-300" : "text-slate-300"}`}>
                {device.latencyMs !== null ? `${device.latencyMs}ms` : "—"}
              </td>
              <td className="py-2 tabular-nums text-slate-400">{device.lossPct !== null ? `${device.lossPct}%` : "—"}</td>
              <td className="py-2 w-32">
                <UtilBar value={device.utilPct} />
              </td>
              <td className="py-2 tabular-nums text-slate-400">
                {device.portsUsed}/{device.portsTotal}
              </td>
              <td className="py-2 text-slate-400">{formatUptime(device.uptimeSeconds)}</td>
              <td className="py-2">
                <button
                  onClick={() =>
                    void send("/api/simulate", {
                      method: "POST",
                      body: JSON.stringify({ target: "device", deviceId: device.id, down: device.status !== "down" }),
                    })
                  }
                  disabled={busy}
                  className={`rounded-lg px-2 py-1 text-[11px] ring-1 transition disabled:opacity-50 ${
                    device.status === "down"
                      ? "bg-emerald-500/15 text-emerald-200 ring-emerald-500/30"
                      : "bg-red-500/15 text-red-200 ring-red-500/30"
                  }`}
                >
                  {device.status === "down" ? "استعادة" : "محاكاة عطل"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AlertsPanel({
  data,
  send,
  busy,
}: {
  data: Overview;
  busy: boolean;
  send: (url: string, init?: RequestInit) => Promise<unknown>;
}) {
  const open = data.alerts.filter((alert) => alert.status !== "resolved").slice(0, 12);
  const resolved = data.alerts.filter((alert) => alert.status === "resolved").slice(0, 5);

  return (
    <Card
      title="التنبيهات"
      subtitle={`${data.kpis.alertsActive} تنبيهًا مفتوحًا · تم إرسالها عبر قنوات متعددة`}
      action={<Badge tone={open.length > 0 ? "red" : "green"}>{open.length > 0 ? "يوجد تنبيهات" : "لا تنبيهات"}</Badge>}
    >
      <div className="space-y-2">
        {open.length === 0 ? <p className="py-3 text-center text-[11px] text-slate-500">لا توجد تنبيهات نشطة</p> : null}
        {open.map((alert) => (
          <div
            key={alert.id}
            className={`rounded-xl border p-3 ${
              alert.severity === "critical"
                ? "border-red-500/30 bg-red-500/5"
                : alert.severity === "warning"
                  ? "border-amber-500/30 bg-amber-500/5"
                  : "border-slate-700 bg-slate-900/50"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-slate-100">{alert.title}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{alert.message}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                  <Badge tone={alert.severity === "critical" ? "red" : alert.severity === "warning" ? "amber" : "blue"}>
                    {SEVERITY_LABELS[alert.severity]}
                  </Badge>
                  <span>{ALERT_TYPE_LABELS[alert.type] ?? alert.type}</span>
                  <span>{relativeTime(alert.createdAt)}</span>
                  {alert.status === "acknowledged" ? <Badge tone="blue">تم الإقرار</Badge> : null}
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                {alert.status === "active" ? (
                  <button
                    onClick={() => void send(`/api/alerts/${alert.id}`, { method: "PATCH", body: JSON.stringify({ action: "acknowledge" }) })}
                    disabled={busy}
                    className="rounded-lg bg-slate-800 px-2 py-1 text-[10px] text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                  >
                    إقرار
                  </button>
                ) : null}
                <button
                  onClick={() => void send(`/api/alerts/${alert.id}`, { method: "PATCH", body: JSON.stringify({ action: "resolve" }) })}
                  disabled={busy}
                  className="rounded-lg bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
                >
                  إغلاق
                </button>
              </div>
            </div>
          </div>
        ))}

        {resolved.length > 0 ? (
          <details className="rounded-xl border border-slate-800 bg-slate-950/50 p-2">
            <summary className="cursor-pointer text-[11px] text-slate-400">تنبيهات مغلقة ({resolved.length})</summary>
            <ul className="mt-2 space-y-1 text-[11px] text-slate-500">
              {resolved.map((alert) => (
                <li key={alert.id} className="flex items-center justify-between gap-2">
                  <span>{alert.title}</span>
                  <span>{relativeTime(alert.resolvedAt)}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Card>
  );
}

function ChannelsPanel({
  data,
  send,
  busy,
}: {
  data: Overview;
  busy: boolean;
  send: (url: string, init?: RequestInit) => Promise<unknown>;
}) {
  return (
    <div className="space-y-2">
      {data.channels.map((channel) => (
        <div key={channel.id} className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
          <StatusDot status={channel.lastStatus === "sent" ? "up" : channel.lastStatus === "failed" ? "down" : "unknown"} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-semibold text-slate-200">{channel.name}</p>
            <p className="truncate text-[10px] text-slate-500">
              {channel.type} · {channel.target}
            </p>
          </div>
          <Badge tone={channel.isFallback ? "amber" : "blue"}>{channel.isFallback ? "احتياطية" : "أساسية"}</Badge>
          <button
            onClick={() => void send("/api/channels", { method: "POST", body: JSON.stringify({ action: "test", id: channel.id }) })}
            disabled={busy}
            className="rounded-lg bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-700 disabled:opacity-50"
          >
            اختبار
          </button>
        </div>
      ))}
      <p className="text-[10px] leading-relaxed text-slate-500">
        عند فشل كل القنوات الأساسية يتم التحويل تلقائيًا للقنوات الاحتياطية، وإذا تعذر الإرسال يُخزَّن التنبيه محليًا حتى عودة الاتصال.
      </p>
    </div>
  );
}

function FailoverLog({ data }: { data: Overview }) {
  if (data.failoverLog.length === 0) {
    return <p className="py-3 text-center text-[11px] text-slate-500">لا توجد أحداث تحويل بعد</p>;
  }
  return (
    <ul className="space-y-2 text-[11px]">
      {data.failoverLog.map((event) => (
        <li key={event.id} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-slate-200">
              {event.kind === "failover" ? "تحويل للرابط الاحتياطي" : event.kind === "failback" ? "عودة للرابط الأساسي" : "انقطاع كامل"}
            </span>
            <span className="text-slate-500">{relativeTime(event.startedAt)}</span>
          </div>
          <p className="mt-1 text-slate-400">{event.reason}</p>
          {event.durationSeconds ? <p className="text-[10px] text-slate-500">المدة: {event.durationSeconds} ثانية</p> : null}
        </li>
      ))}
    </ul>
  );
}

function ActivityLog({ data }: { data: Overview }) {
  return (
    <ul className="space-y-1 text-[11px]">
      {data.activity.length === 0 ? <li className="text-slate-500">لا سجلات</li> : null}
      {data.activity.map((entry, index) => (
        <li key={`${entry.at}-${index}`} className="flex gap-2 border-b border-slate-900/70 pb-1">
          <span className="text-slate-500">{new Date(entry.at).toLocaleTimeString("ar-EG", { hour12: false })}</span>
          <span
            className={
              entry.level === "error" ? "text-red-300" : entry.level === "warn" ? "text-amber-300" : "text-slate-400"
            }
          >
            {entry.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SettingsPanel({ data, send }: { data: Overview; send: (url: string, init?: RequestInit) => Promise<unknown> }) {
  const [form, setForm] = useState(data.settings);
  const [saved, setSaved] = useState(false);

  const fields: { key: keyof typeof form; label: string; suffix?: string }[] = [
    { key: "tickSeconds", label: "فترة الفحص", suffix: "ثانية" },
    { key: "latencyThresholdMs", label: "حد زمن الاستجابة", suffix: "ms" },
    { key: "utilizationThresholdPct", label: "حد استهلاك الشبكة", suffix: "%" },
    { key: "lossThresholdPct", label: "حد فقدان الحزم", suffix: "%" },
    { key: "downFailThreshold", label: "عدد الفحوص قبل التنبيه بالانقطاع", suffix: "فحص" },
    { key: "retentionHours", label: "مدة حفظ القياسات", suffix: "ساعة" },
  ];

  return (
    <Card title="إعدادات المراقبة" subtitle="تُحفظ في قاعدة البيانات وتُطبق على دورة الفحص التالية">
      <div className="grid gap-3 md:grid-cols-3">
        {fields.map((field) => (
          <label key={field.key} className="space-y-1 text-[11px] text-slate-400">
            <span>
              {field.label} {field.suffix ? `(${field.suffix})` : ""}
            </span>
            <input
              type="number"
              value={String(form[field.key] ?? "")}
              onChange={(event) => setForm({ ...form, [field.key]: Number(event.target.value) })}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-500"
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <label className="flex items-center gap-2 text-[11px] text-slate-300">
          <input
            type="checkbox"
            checked={form.notificationsEnabled}
            onChange={(event) => setForm({ ...form, notificationsEnabled: event.target.checked })}
          />
          تفعيل إرسال التنبيهات للقنوات
        </label>
        <button
          onClick={async () => {
            await send("/api/settings", { method: "PATCH", body: JSON.stringify(form) });
            setSaved(true);
            setTimeout(() => setSaved(false), 2500);
          }}
          className="rounded-lg bg-sky-500/20 px-3 py-1.5 text-xs text-sky-200 ring-1 ring-sky-500/40 hover:bg-sky-500/30"
        >
          حفظ الإعدادات
        </button>
        {saved ? <span className="text-[11px] text-emerald-300">تم الحفظ</span> : null}
      </div>
    </Card>
  );
}

function AddDeviceForm({ send, onDone }: { send: (url: string, init?: RequestInit) => Promise<unknown>; onDone: () => void }) {
  const [form, setForm] = useState({
    name: "",
    type: "switch",
    vendor: "",
    model: "",
    ipAddress: "",
    macAddress: "",
    serialNumber: "",
    location: "",
    rack: "",
    portCount: 24,
    probePort: 22,
    probeMode: "tcp",
  });

  const input = "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs outline-none focus:border-sky-500";

  return (
    <Card title="إضافة جهاز جديد" subtitle="يتم توليد المنافذ تلقائيًا ويمكن طباعة بطاقة QR من صفحة الجهاز">
      <div className="grid gap-3 md:grid-cols-4">
        {[
          { key: "name", label: "اسم الجهاز" },
          { key: "vendor", label: "الشركة" },
          { key: "model", label: "الموديل" },
          { key: "ipAddress", label: "عنوان IP" },
          { key: "macAddress", label: "MAC" },
          { key: "serialNumber", label: "الرقم التسلسلي" },
          { key: "location", label: "الموقع" },
          { key: "rack", label: "الحامل/الخزانة" },
        ].map((field) => (
          <label key={field.key} className="space-y-1 text-[11px] text-slate-400">
            <span>{field.label}</span>
            <input
              value={String(form[field.key as keyof typeof form])}
              onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
              className={input}
            />
          </label>
        ))}
        <label className="space-y-1 text-[11px] text-slate-400">
          <span>النوع</span>
          <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} className={input}>
            {Object.entries(DEVICE_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-[11px] text-slate-400">
          <span>عدد المنافذ</span>
          <input type="number" value={form.portCount} onChange={(event) => setForm({ ...form, portCount: Number(event.target.value) })} className={input} />
        </label>
        <label className="space-y-1 text-[11px] text-slate-400">
          <span>منفذ الفحص</span>
          <input type="number" value={form.probePort} onChange={(event) => setForm({ ...form, probePort: Number(event.target.value) })} className={input} />
        </label>
        <label className="space-y-1 text-[11px] text-slate-400">
          <span>طريقة الفحص</span>
          <select value={form.probeMode} onChange={(event) => setForm({ ...form, probeMode: event.target.value })} className={input}>
            <option value="tcp">TCP</option>
            <option value="icmp">ICMP (Ping)</option>
            <option value="simulate">محاكاة</option>
          </select>
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={async () => {
            await send("/api/devices", { method: "POST", body: JSON.stringify(form) });
            onDone();
          }}
          className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs text-emerald-200 ring-1 ring-emerald-500/40 hover:bg-emerald-500/30"
        >
          إضافة الجهاز
        </button>
        <button onClick={onDone} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700">
          إلغاء
        </button>
      </div>
    </Card>
  );
}
