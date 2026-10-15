import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "نظام مراقبة الشبكة | Network Monitoring",
  description:
    "نظام ذكي لمراقبة الشبكة مع تنبيهات فورية واتصال احتياطي عند انقطاع الشبكة أو قاعدة البيانات",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#020617",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="bg-slate-950 text-slate-200 antialiased">{children}</body>
    </html>
  );
}
