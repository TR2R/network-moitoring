import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { devices, ports, type DeviceType, type SimProfile } from "@/db/schema";
import { ensureMonitorRunning } from "@/lib/monitor";
import { markDbBroken } from "@/lib/resilience";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await db.select().from(devices).orderBy(asc(devices.id));
    const portRows = await db.select().from(ports).orderBy(asc(ports.id));
    const result = rows.map((device) => ({
      ...device,
      ports: portRows.filter((port) => port.deviceId === device.id),
    }));
    return Response.json({ devices: result });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "devices read failed");
    return Response.json({ devices: [], error: "تعذر قراءة الأجهزة من قاعدة البيانات" }, { status: 200 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: string;
      type?: DeviceType;
      vendor?: string;
      model?: string;
      ipAddress?: string;
      macAddress?: string;
      serialNumber?: string;
      location?: string;
      rack?: string;
      criticality?: string;
      probePort?: number;
      probeMode?: string;
      simProfile?: SimProfile;
      portCount?: number;
    };

    if (!body.name || !body.type) {
      return Response.json({ ok: false, error: "الاسم والنوع مطلوبان" }, { status: 400 });
    }

    const portCount = Math.min(96, Math.max(0, Number(body.portCount ?? 8)));
    const inserted = await db
      .insert(devices)
      .values({
        name: body.name,
        type: body.type,
        vendor: body.vendor ?? null,
        model: body.model ?? null,
        ipAddress: body.ipAddress ?? null,
        macAddress: body.macAddress ?? null,
        serialNumber: body.serialNumber ?? null,
        location: body.location ?? null,
        rack: body.rack ?? null,
        criticality: (body.criticality as "low" | "medium" | "high" | "critical") ?? "medium",
        probeMode: (body.probeMode as "tcp" | "icmp" | "simulate") ?? "tcp",
        probePort: Number(body.probePort ?? 443),
        simProfile: body.simProfile ?? "stable",
        status: "unknown",
      })
      .returning({ id: devices.id });

    const deviceId = inserted[0].id;
    if (portCount > 0) {
      await db.insert(ports).values(
        Array.from({ length: portCount }, (_, index) => ({
          deviceId,
          label: `Gi0/${index + 1}`,
          portType: index === 0 ? ("uplink" as const) : ("ethernet" as const),
          status: "free" as const,
          speedMbps: 1000,
        })),
      );
    }

    return Response.json({ ok: true, id: deviceId });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "device create failed");
    return Response.json({ ok: false, error: "تعذر إضافة الجهاز" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));
    if (!id) return Response.json({ ok: false, error: "معرف غير صالح" }, { status: 400 });
    await db.delete(devices).where(eq(devices.id, id));
    return Response.json({ ok: true });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "device delete failed");
    return Response.json({ ok: false, error: "تعذر حذف الجهاز" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  // تحديث سريع من لوحة المتابعة: محاكاة عطل / إيقاف مراقبة
  try {
    const body = (await request.json()) as {
      id?: number;
      forceStatus?: "none" | "down" | "maintenance";
      monitored?: boolean;
      simProfile?: SimProfile;
    };
    if (!body.id) return Response.json({ ok: false, error: "معرف غير صالح" }, { status: 400 });
    await ensureMonitorRunning();
    await db
      .update(devices)
      .set({
        forceStatus: body.forceStatus ?? "none",
        monitored: body.monitored ?? true,
        simProfile: body.simProfile ?? "stable",
        updatedAt: new Date(),
      })
      .where(eq(devices.id, body.id));
    return Response.json({ ok: true });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "device update failed");
    return Response.json({ ok: false, error: "تعذر تحديث الجهاز" }, { status: 500 });
  }
}
