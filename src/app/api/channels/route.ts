import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { notificationChannels, type ChannelType } from "@/db/schema";
import { testChannel } from "@/lib/notify";
import { markDbBroken } from "@/lib/resilience";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await db.select().from(notificationChannels).orderBy(asc(notificationChannels.priority));
    return Response.json({ channels: rows });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "channels read failed");
    return Response.json({ channels: [] });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "create" | "test";
      id?: number;
      name?: string;
      type?: ChannelType;
      target?: string;
      isFallback?: boolean;
      priority?: number;
    };

    if (body.action === "test" && body.id) {
      const result = await testChannel(body.id);
      return Response.json(result);
    }

    if (!body.name || !body.type || !body.target) {
      return Response.json({ ok: false, error: "الاسم والنوع والوجهة مطلوبة" }, { status: 400 });
    }

    const inserted = await db
      .insert(notificationChannels)
      .values({
        name: body.name,
        type: body.type,
        target: body.target,
        isFallback: Boolean(body.isFallback),
        priority: Number(body.priority ?? 100),
        enabled: true,
      })
      .returning({ id: notificationChannels.id });

    return Response.json({ ok: true, id: inserted[0].id });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "channel create failed");
    return Response.json({ ok: false, error: "تعذر حفظ القناة" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { id?: number; enabled?: boolean; isFallback?: boolean; priority?: number };
    if (!body.id) return Response.json({ ok: false, error: "معرف غير صالح" }, { status: 400 });
    const patch: Record<string, unknown> = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.isFallback !== undefined) patch.isFallback = body.isFallback;
    if (body.priority !== undefined) patch.priority = Number(body.priority);
    await db.update(notificationChannels).set(patch).where(eq(notificationChannels.id, body.id));
    return Response.json({ ok: true });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "channel update failed");
    return Response.json({ ok: false, error: "تعذر تحديث القناة" }, { status: 500 });
  }
}
