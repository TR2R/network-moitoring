import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { alerts } from "@/db/schema";
import { markDbBroken } from "@/lib/resilience";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 60));
    const where =
      status && status !== "all"
        ? status === "open"
          ? inArray(alerts.status, ["active", "acknowledged"])
          : eq(alerts.status, status as "active" | "acknowledged" | "resolved")
        : undefined;

    const rows = await db
      .select()
      .from(alerts)
      .where(where ? and(where) : undefined)
      .orderBy(desc(alerts.createdAt))
      .limit(limit);
    return Response.json({ alerts: rows });
  } catch (error) {
    markDbBroken(error instanceof Error ? error.message : "alerts read failed");
    return Response.json({ alerts: [], error: "تعذر قراءة التنبيهات" }, { status: 200 });
  }
}
