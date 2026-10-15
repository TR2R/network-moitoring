import { ensureMonitorRunning } from "@/lib/monitor";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const monitor = await ensureMonitorRunning();
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";
  const overview = await monitor.getOverview(force);
  return Response.json(overview, { headers: { "cache-control": "no-store" } });
}
