import { eq } from "drizzle-orm";
import { db } from "@/db";
import { alerts } from "@/db/schema";
import { logActivity } from "@/lib/resilience";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const alertId = Number(id);
  if (!alertId) return Response.json({ ok: false, error: "معرف غير صالح" }, { status: 400 });

  try {
    const body = (await request.json()) as { action?: "acknowledge" | "resolve" | "reopen"; by?: string };
    const action = body.action ?? "acknowledge";
    const now = new Date();

    if (action === "acknowledge") {
      await db
        .update(alerts)
        .set({ status: "acknowledged", acknowledgedAt: now, acknowledgedBy: body.by ?? "مشغل الشبكة" })
        .where(eq(alerts.id, alertId));
      logActivity("info", `تم الإقرار بالتنبيه #${alertId}`);
    } else if (action === "resolve") {
      await db
        .update(alerts)
        .set({ status: "resolved", resolvedAt: now })
        .where(eq(alerts.id, alertId));
      logActivity("info", `تم إغلاق التنبيه #${alertId}`);
    } else {
      await db
        .update(alerts)
        .set({ status: "active", acknowledgedAt: null, resolvedAt: null })
        .where(eq(alerts.id, alertId));
    }

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "تعذر تحديث التنبيه" },
      { status: 500 },
    );
  }
}
