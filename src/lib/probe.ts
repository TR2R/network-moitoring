import net from "node:net";
import { execFile } from "node:child_process";

export type ProbeResult = {
  up: boolean;
  latencyMs: number;
  lossPct: number;
  method: "tcp" | "icmp" | "simulate";
  error?: string;
};

/** فحص TCP سريع لمعرفة إن كان الجهاز يستجيب على منفذ معين */
export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      finish({
        up: true,
        latencyMs: Date.now() - started || 0.4,
        lossPct: 0,
        method: "tcp",
      });
    });
    socket.once("timeout", () => {
      finish({ up: false, latencyMs: timeoutMs, lossPct: 100, method: "tcp", error: "timeout" });
    });
    socket.once("error", (err: Error) => {
      finish({
        up: false,
        latencyMs: Date.now() - started,
        lossPct: 100,
        method: "tcp",
        error: err.message,
      });
    });

    try {
      socket.connect(port, host);
    } catch (error) {
      finish({
        up: false,
        latencyMs: timeoutMs,
        lossPct: 100,
        method: "tcp",
        error: error instanceof Error ? error.message : "connect failed",
      });
    }
  });
}

/** فحص ICMP (ping) كمسار احتياطي عند عدم فتح أي منفذ TCP */
export function icmpProbe(host: string, timeoutMs = 2000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = process.platform === "win32" ? ["-n", "1", "-w", String(timeoutMs), host] : ["-c", "1", "-W", "2", host];
    execFile("ping", args, { timeout: timeoutMs + 1000 }, (error, stdout) => {
      const elapsed = Date.now() - started;
      if (!error && /ttl|time=/i.test(String(stdout))) {
        const match = /time[=<]([\d.]+)\s*ms/i.exec(String(stdout));
        resolve({
          up: true,
          latencyMs: match ? Number(match[1]) : elapsed,
          lossPct: 0,
          method: "icmp",
        });
        return;
      }
      resolve({
        up: false,
        latencyMs: elapsed,
        lossPct: 100,
        method: "icmp",
        error: error instanceof Error ? error.message : "icmp failed",
      });
    });
  });
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/** مولد أرقام شبه عشوائي ثابت لنفس المفتاح (للمحاكاة الواقعية) */
function seededRandom(seed: string): number {
  const x = Math.sin(hashString(seed)) * 10000;
  return x - Math.floor(x);
}

const PROFILE_BASE: Record<string, { latency: number; util: number }> = {
  stable: { latency: 8, util: 28 },
  busy: { latency: 55, util: 78 },
  flaky: { latency: 30, util: 45 },
  offline: { latency: 0, util: 0 },
};

/**
 * محاكاة قراءة SNMP/Ping لجهاز — تُستخدم عند عدم توفر أجهزة حقيقية داخل بيئة المعمل،
 * وتعطي نتائج ثابتة لنفس الثانية الزمنية حتى لا تتغير القيم بسرعة عشوائية.
 */
export function simulateProbe(key: string, profile: string, nowMs = Date.now()): ProbeResult {
  const bucket = Math.floor(nowMs / 8000);
  const base = PROFILE_BASE[profile] ?? PROFILE_BASE.stable;
  const noise = seededRandom(`${key}:${profile}:${bucket}:n`);
  const wave = Math.sin(bucket / 5 + (hashString(key) % 10));
  const outageRoll = seededRandom(`${key}:${profile}:${bucket}:o`);

  if (profile === "offline") {
    return { up: false, latencyMs: 0, lossPct: 100, method: "simulate", error: "simulated offline" };
  }

  if (profile === "flaky" && outageRoll > 0.86) {
    return { up: false, latencyMs: 0, lossPct: 100, method: "simulate", error: "simulated flap" };
  }

  const latency = Math.max(
    1,
    Math.round(base.latency + noise * base.latency * 0.9 + wave * base.latency * 0.25),
  );
  const lossPct = profile === "flaky" ? Math.round(noise * 12 * 10) / 10 : 0;

  return { up: true, latencyMs: latency, lossPct, method: "simulate" };
}

export type DeviceLoad = {
  utilPct: number;
  cpuPct: number;
  memPct: number;
  inMbps: number;
  outMbps: number;
  uptimeSeconds: number;
};

const CAPACITY_MBPS: Record<string, number> = {
  router: 1000,
  uplink: 1000,
  firewall: 1000,
  switch: 2400,
  access_point: 600,
  server: 2000,
  patch_panel: 1000,
  ups: 100,
};

/** تقدير الحمل اعتمادًا على زمن الاستجابة + بصمة الجهاز (يُستخدم للأجهزة الحقيقية أيضًا) */
export function deriveLoad(key: string, type: string, latencyMs: number, up: boolean, nowMs = Date.now()): DeviceLoad {
  const bucket = Math.floor(nowMs / 10000);
  const capacity = CAPACITY_MBPS[type] ?? 1000;
  if (!up) {
    return { utilPct: 0, cpuPct: 0, memPct: 0, inMbps: 0, outMbps: 0, uptimeSeconds: 0 };
  }
  const noise = seededRandom(`${key}:load:${bucket}`);
  const baseUtil = Math.min(92, 12 + latencyMs / 2.2 + noise * 22);
  const utilPct = Math.round(Math.max(2, Math.min(99, baseUtil)) * 10) / 10;
  const total = capacity;
  const inMbps = Math.round(((utilPct / 100) * total * (0.5 + noise / 2)) * 10) / 10;
  const outMbps = Math.round(((utilPct / 100) * total * (0.4 + noise / 2.2)) * 10) / 10;
  const cpuPct = Math.round(Math.max(3, Math.min(99, utilPct * 0.75 + noise * 18)) * 10) / 10;
  const memPct = Math.round(Math.max(10, Math.min(97, 32 + utilPct * 0.4 + noise * 12)) * 10) / 10;
  return {
    utilPct,
    cpuPct,
    memPct,
    inMbps,
    outMbps,
    uptimeSeconds: 3600 * (2 + (hashString(key) % 60)) + bucket * 10,
  };
}

/** فحص كامل: TCP ثم ICMP كاحتياط، أو محاكاة */
export async function probeDevice(input: {
  id: number;
  name: string;
  ipAddress?: string | null;
  probeMode: string;
  probePort?: number | null;
  simProfile: string;
}): Promise<ProbeResult> {
  const host = input.ipAddress?.trim();

  if (input.probeMode === "simulate" || !host) {
    return simulateProbe(`${input.id}:${input.name}`, input.simProfile);
  }

  const tcp = await tcpProbe(host, input.probePort ?? 443, 1500);
  if (tcp.up) return tcp;

  const icmp = await icmpProbe(host, 2000);
  if (icmp.up) return icmp;

  return {
    up: false,
    latencyMs: Math.max(tcp.latencyMs, icmp.latencyMs),
    lossPct: 100,
    method: "icmp",
    error: icmp.error ?? tcp.error ?? "unreachable",
  };
}
