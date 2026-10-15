import QRCode from "qrcode";

export const dynamic = "force-dynamic";

/** توليد QR Code لأي نص (يُستخدم لبطاقات الأجهزة والكيابل) */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const text = url.searchParams.get("text") ?? "";
  const size = Math.min(600, Math.max(80, Number(url.searchParams.get("size") ?? 200)));
  if (!text) return new Response("missing text", { status: 400 });

  const svg = await QRCode.toString(text, {
    type: "svg",
    margin: 1,
    width: size,
    color: { dark: "#0f172a", light: "#ffffff" },
  });

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
