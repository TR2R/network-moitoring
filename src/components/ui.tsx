"use client";

import type { ReactNode } from "react";
import { STATUS_COLORS } from "@/lib/format";

export function StatusDot({ status, pulse = true }: { status: string; pulse?: boolean }) {
  const color = STATUS_COLORS[status] ?? STATUS_COLORS.unknown;
  return (
    <span className="relative inline-flex h-3 w-3 shrink-0">
      {pulse && status === "up" ? (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: color }} />
      ) : null}
      <span className="relative inline-flex h-3 w-3 rounded-full" style={{ background: color }} />
    </span>
  );
}

export function Badge({
  children,
  tone = "slate",
  className = "",
}: {
  children: ReactNode;
  tone?: "slate" | "green" | "red" | "amber" | "blue" | "violet";
  className?: string;
}) {
  const tones: Record<string, string> = {
    slate: "bg-slate-800/70 text-slate-300 ring-slate-700",
    green: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
    red: "bg-red-500/10 text-red-300 ring-red-500/30",
    amber: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
    blue: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
    violet: "bg-violet-500/10 text-violet-300 ring-violet-500/30",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-slate-800/80 bg-slate-900/60 p-4 shadow-lg shadow-black/20 backdrop-blur ${className}`}
    >
      {title ? (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[11px] text-slate-400">{subtitle}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function KpiCard({
  label,
  value,
  unit,
  hint,
  tone = "slate",
  icon,
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  tone?: "slate" | "green" | "red" | "amber" | "blue" | "violet";
  icon?: string;
}) {
  const accents: Record<string, string> = {
    slate: "from-slate-800/60 to-slate-900/40 text-slate-100",
    green: "from-emerald-500/20 to-slate-900/40 text-emerald-200",
    red: "from-red-500/20 to-slate-900/40 text-red-200",
    amber: "from-amber-500/20 to-slate-900/40 text-amber-200",
    blue: "from-sky-500/20 to-slate-900/40 text-sky-200",
    violet: "from-violet-500/20 to-slate-900/40 text-violet-200",
  };
  return (
    <div className={`rounded-2xl border border-slate-800/80 bg-gradient-to-bl p-4 ${accents[tone]}`}>
      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <span>{label}</span>
        {icon ? <span className="text-base leading-none">{icon}</span> : null}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums">{value}</span>
        {unit ? <span className="text-xs text-slate-400">{unit}</span> : null}
      </div>
      {hint ? <p className="mt-1 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function Sparkline({
  values,
  color = "#38bdf8",
  height = 56,
  threshold,
}: {
  values: number[];
  color?: string;
  height?: number;
  threshold?: number;
}) {
  const width = 240;
  if (values.length === 0) {
    return <div className="flex h-14 items-center justify-center text-[11px] text-slate-500">لا توجد بيانات بعد</div>;
  }
  const max = Math.max(...values, threshold ?? 0, 1) * 1.15;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - (value / max) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const areaId = `spark-${color.replace("#", "")}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-14 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {threshold ? (
        <line
          x1="0"
          x2={width}
          y1={height - (threshold / max) * height}
          y2={height - (threshold / max) * height}
          stroke="#f59e0b"
          strokeDasharray="4 4"
          strokeWidth="1"
          opacity="0.6"
        />
      ) : null}
      <polygon points={`0,${height} ${points.join(" ")} ${width},${height}`} fill={`url(#${areaId})`} />
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

export function TrafficChart({
  series,
  height = 80,
}: {
  series: { t: string; inMbps: number; outMbps: number }[];
  height?: number;
}) {
  const width = 320;
  if (series.length === 0) {
    return <div className="flex h-20 items-center justify-center text-[11px] text-slate-500">لا توجد بيانات مرور بعد</div>;
  }
  const max = Math.max(...series.flatMap((point) => [point.inMbps, point.outMbps]), 10) * 1.2;
  const step = series.length > 1 ? width / (series.length - 1) : width;
  const toPoints = (pick: (point: { inMbps: number; outMbps: number }) => number) =>
    series.map((point, index) => `${(index * step).toFixed(1)},${(height - (pick(point) / max) * height).toFixed(1)}`);

  const inPoints = toPoints((point) => point.inMbps);
  const outPoints = toPoints((point) => point.outMbps);

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="traffic-in" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,${height} ${inPoints.join(" ")} ${width},${height}`} fill="url(#traffic-in)" />
        <polyline points={inPoints.join(" ")} fill="none" stroke="#22d3ee" strokeWidth="1.6" />
        <polyline points={outPoints.join(" ")} fill="none" stroke="#a78bfa" strokeWidth="1.6" strokeDasharray="5 3" />
      </svg>
      <div className="flex items-center gap-4 text-[11px] text-slate-400">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-cyan-400" /> تحميل (In)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-violet-400" /> رفع (Out)
        </span>
        <span className="ms-auto">أقصى: {max.toFixed(0)} Mbps</span>
      </div>
    </div>
  );
}

export function UtilBar({ value, threshold = 80 }: { value: number | null; threshold?: number }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  const color = pct >= threshold ? "bg-red-500" : pct >= threshold * 0.7 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full min-w-16 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 shrink-0 text-[11px] tabular-nums text-slate-400">{pct.toFixed(0)}%</span>
    </div>
  );
}
