import { ensureMonitorRunning } from "@/lib/monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** بث مباشر لحالة الشبكة (Server-Sent Events) */
export async function GET(request: Request) {
  const monitor = await ensureMonitorRunning();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let interval: ReturnType<typeof setInterval> | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const send = async () => {
        if (closed) return;
        try {
          const overview = await monitor.getOverview();
          controller.enqueue(
            encoder.encode(`event: overview\ndata: ${JSON.stringify(overview)}\n\n`),
          );
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                message: error instanceof Error ? error.message : "stream error",
              })}\n\n`,
            ),
          );
        }
      };

      void send();
      interval = setInterval(() => void send(), 4000);
      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
