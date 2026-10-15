import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import QRCode from "qrcode";
import { db } from "@/db";
import { alerts, cables, devices, metricSamples, ports } from "@/db/schema";
import PrintButton from "@/components/PrintButton";
import { Sparkline, StatusDot, UtilBar } from "@/components/ui";
import { formatUptime } from "@/lib/format";
import { ALERT_TYPE_LABELS, DEVICE_TYPE_LABELS, SEVERITY_LABELS } from "@/lib/dashboard-types";

export const dynamic = "force-dynamic";

const PORT_STATUS: Record<string, { label: string; className: string }> = {
  up: { label: "مستخدم", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" },
  down: { label: "منقطع", className: "border-red-500/40 bg-red-500/10 text-red-200" },
  free: { label: "فارغ", className: "border-slate-700 bg-slate-900/60 text-slate-400" },
  disabled: { label: "معطل", className: "border-slate-700 bg-slate-900 text-slate-500" },
};

export default async function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deviceId = Number(id);
  if (!deviceId) notFound();

  const rows = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  const device = rows[0];
  if (!device) notFound();

  const [portRows, sampleRows, alertRows, cableRows] = await Promise.all([
    db.select().from(ports).where(eq(ports.deviceId, deviceId)).orderBy(ports.id),
    db
      .select()
      .from(metricSamples)
      .where(eq(metricSamples.deviceId, deviceId))
      .orderBy(desc(metricSamples.createdAt))
      .limit(80),
    db.select().from(alerts).where(eq(alerts.deviceId, deviceId)).orderBy(desc(alerts.createdAt)).limit(10),
    db.select().from(cables).limit(200),
  ]);

  const connectedCables = cableRows.filter(
    (cable) => cable.fromDeviceId === deviceId || cable.toDeviceId === deviceId,
  );

  const samples = sampleRows.slice().reverse();
  const usedPorts = portRows.filter((port) => port.status === "up").length;
  const freePorts = portRows.filter((port) => port.status === "free").length;
  const downPorts = portRows.filter((port) => port.status === "down").length;

  const qrSvg = await QRCode.toString(`http://localhost:3000/devices/${device.id}`, {
    type: "svg",
    margin: 1,
    width: 200,
    color: { dark: "#0f172a", light: "#ffffff" },
  });

  const info: { label: string; value: string }[] = [
    { label: "النوع", value: DEVICE_TYPE_LABELS[device.type] ?? device.type },
    { label: "الشركة", value: device.vendor ?? "—" },
    { label: "الموديل", value: device.model ?? "—" },
    { label: "الرقم التسلسلي", value: device.serialNumber ?? "—" },
    { label: "عنوان IP", value: device.ipAddress ?? "—" },
    { label: "عنوان MAC", value: device.macAddress ?? "—" },
    { label: "الموقع", value: device.location ?? "—" },
    { label: "الخزانة/الحامل", value: device.rack ?? "—" },
    { label: "الأهمية", value: device.criticality },
    { label: "طريقة الفحص", value: device.probeMode.toUpperCase() },
    { label: "مدة التشغيل", value: formatUptime(device.uptimeSeconds) },
    {
      label: "آخر اتصال",
      value: device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString("ar-EG") : "—",
    },
  ];

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-200">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-wrap items-center gap-3 no-print">
          <Link href="/" className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700">
            ← رجوع للوحة المتابعة
          </Link>
          <div className="flex items-center gap-2">
            <StatusDot status={device.status} />
            <h1 className="text-lg font-bold text-slate-100">{device.name}</h1>
          </div>
          <span className="text-xs text-slate-400">{device.location ?? "—"}</span>
          <div className="ms-auto flex items-center gap-2">
            <PrintButton />
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 lg:col-span-2">
            <h2 className="mb-3 text-sm font-semibold text-slate-100">بيانات الجهاز</h2>
            <dl className="grid grid-cols-2 gap-3 text-xs md:grid-cols-3">
              {info.map((item) => (
                <div key={item.label} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <dt className="text-[11px] text-slate-500">{item.label}</dt>
                  <dd className="mt-1 font-medium text-slate-200">{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-white p-4 text-center">
            <h2 className="mb-2 text-sm font-bold text-slate-900">بطاقة QR للجهاز</h2>
            <div className="mx-auto w-[200px]" dangerouslySetInnerHTML={{ __html: qrSvg }} />
            <p className="mt-2 text-xs font-semibold text-slate-800">{device.name}</p>
            <p className="text-[11px] text-slate-500">
              {device.ipAddress ?? "بدون IP"} · {device.location ?? "—"}
            </p>
            <p className="mt-1 text-[10px] text-slate-400">امسح الرمز للوصول إلى بيانات الجهاز ومنافذه</p>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-[11px] text-slate-500">زمن الاستجابة</p>
            <p className="text-xl font-bold tabular-nums text-sky-300">{device.lastLatencyMs ?? "—"} ms</p>
            <Sparkline values={samples.map((sample) => sample.latencyMs ?? 0)} color="#38bdf8" />
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-[11px] text-slate-500">استهلاك الوصلات</p>
            <p className="text-xl font-bold tabular-nums text-violet-300">{device.lastInMbps ?? 0} / {device.lastOutMbps ?? 0} Mbps</p>
            <div className="mt-2">
              <UtilBar
                value={
                  device.lastInMbps !== null
                    ? Math.min(100, ((device.lastInMbps + (device.lastOutMbps ?? 0)) / 2000) * 100)
                    : 0
                }
              />
            </div>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-[11px] text-slate-500">المنافذ</p>
            <p className="text-xl font-bold tabular-nums text-emerald-300">
              {usedPorts} / {portRows.length}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              فارغة: {freePorts} · منقطعة: {downPorts}
            </p>
            <p className="mt-2 text-[11px] text-slate-400">
              المعالج: {device.lastCpuPct ?? 0}% · الذاكرة: {device.lastMemPct ?? 0}%
            </p>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-100">
            المنافذ ({portRows.length}) — مستخدمة {usedPorts} · فارغة {freePorts}
          </h2>
          <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4 lg:grid-cols-6">
            {portRows.map((port) => {
              const meta = PORT_STATUS[port.status] ?? PORT_STATUS.free;
              return (
                <div key={port.id} className={`rounded-xl border p-2 ${meta.className}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold">{port.label}</span>
                    <span>{meta.label}</span>
                  </div>
                  <p className="mt-1 truncate text-[10px] opacity-80">{port.connectedTo ?? "غير متصل"}</p>
                  <p className="text-[10px] opacity-70">
                    {port.speedMbps}Mbps {port.vlan ? `· VLAN ${port.vlan}` : ""} {port.poe ? "· PoE" : ""}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-100">سجل التنبيهات</h2>
            <ul className="space-y-2 text-[11px]">
              {alertRows.length === 0 ? <li className="text-slate-500">لا توجد تنبيهات</li> : null}
              {alertRows.map((alert) => (
                <li key={alert.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-200">{alert.title}</span>
                    <span className="text-slate-500">{new Date(alert.createdAt).toLocaleString("ar-EG")}</span>
                  </div>
                  <p className="mt-1 text-slate-400">{alert.message}</p>
                  <div className="mt-1 flex gap-2 text-[10px] text-slate-500">
                    <span>{ALERT_TYPE_LABELS[alert.type] ?? alert.type}</span>
                    <span>· {SEVERITY_LABELS[alert.severity]}</span>
                    <span>· {alert.status === "resolved" ? "مغلق" : alert.status === "acknowledged" ? "مُقر" : "مفتوح"}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-100">الكيابات المرتبطة</h2>
            {connectedCables.length === 0 ? (
              <p className="text-[11px] text-slate-500">
                لم يتم تسجيل كيابات لهذا الجهاز بعد — سيتم تفعيلها في نظام إدارة الكيابل والمنافذ.
              </p>
            ) : (
              <ul className="space-y-2 text-[11px]">
                {connectedCables.map((cable) => (
                  <li key={cable.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <span className="font-semibold text-slate-200">{cable.code}</span>
                    <span className="text-slate-500"> · {cable.cableType}</span>
                    <p className="mt-1 text-slate-400">
                      {cable.fromPort ?? "—"} → {cable.toPort ?? "—"} ({cable.lengthM ?? "—"} م)
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
