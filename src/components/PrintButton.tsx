"use client";

export default function PrintButton({ label = "طباعة بطاقة الجهاز" }: { label?: string }) {
  return (
    <button
      onClick={() => window.print()}
      className="no-print rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-slate-700"
    >
      🖨️ {label}
    </button>
  );
}
