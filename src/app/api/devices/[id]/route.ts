import { desc, eq } from "drizzle-orm";
import QRCode from "qrcode";
import { db } from "@/db";
import { alerts, cables, devices, metricSamples, ports } from "@/db/schema";
import { markDbBroken } from "@/lib/resilience";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deviceId = Number(id);
  if (!deviceId) return Response.json({ error: "معرف غير صالح" }, { status: 400 });

  try {
    const rows = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
    const device = rows[0];
    if (!device) return Response.json({ error: "الجهاز غير موجود" }, { status: 404 });

    const [portRows, sampleRows, alertRows, cableRows] = await Promise.all([
      db.select().from(ports).where(eq(ports.deviceId, deviceId)).orderBy(ports.id),
      db
        .select()
        .from(metricSamples)
        .where(eq(metricSamples.deviceId, deviceId))
        .orderBy(desc(metricSamples.createdAt))
        .limit(90),
      db.select().from(alerts).where(eq(alerts.deviceId, deviceId)).orderBy(desc(alerts.createdAt)).limit(20),
      db.select().from(cables).orderBy(cables.id).limit(300),
    ]);

    const origin = new URL(request.url).origin;
    const target = `${origin}/devices/${device.id}`;
    const qrSvg = await QRCode.toString(target, {
      type: "svg",
      margin: 1,
      width: 220,
      color: { dark: "#0f172a", light: "#ffffff" },
    });

    return Response.json({
      device,
      ports: portRows,
      samples: sampleRows
        .map((sample) => ({
          t: new Date(sample.createdAt).toISOString(),
          latencyMs: sample.latencyMs,
          inMbps: sample.inMbps,
          outMbps: sample.outMbps,
          lossPct: sample.lossPct,
          source: sample.source,
        }))
        .reverse(),
      alerts: alertRows,
      cables: cableRows.filter(
        (cable) => cable.fromDeviceId === deviceId || cable.toDeviceId === deviceId,
      ),
      qr: { svg: qrSvg, target },
    });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "device read failed");
    return Response.json({ error: "تعذر قراءة بيانات الجهاز" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deviceId = Number(id);
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    const allowed = [
      "name",
      "type",
      "vendor",
      "model",
      "ipAddress",
      "macAddress",
      "serialNumber",
      "location",
      "rack",
      "notes",
      "criticality",
      "probeMode",
      "probePort",
      "simProfile",
      "forceStatus",
      "monitored",
    ];
    for (const key of allowed) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    const updated = await db.update(devices).set(patch).where(eq(devices.id, deviceId)).returning();
    if (updated.length === 0) return Response.json({ ok: false, error: "غير موجود" }, { status: 404 });
    return Response.json({ ok: true, device: updated[0] });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "device patch failed");
    return Response.json({ ok: false, error: "تعذر تحديث الجهاز" }, { status: 500 });
  }
}
