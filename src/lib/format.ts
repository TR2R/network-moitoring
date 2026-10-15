/** أدوات تنسيق مشتركة بين الخادم والعميل (بدون توجيهات client) */

export const STATUS_COLORS: Record<string, string> = {
  up: "#22c55e",
  down: "#ef4444",
  degraded: "#f59e0b",
  unknown: "#64748b",
  maintenance: "#3b82f6",
};

export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.round(diff / 1000);
  if (seconds < 5) return "الآن";
  if (seconds < 60) return `قبل ${seconds} ثانية`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `قبل ${minutes} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `قبل ${hours} ساعة`;
  const days = Math.round(hours / 24);
  return `قبل ${days} يوم`;
}

export function formatUptime(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}ي ${hours}س`;
  if (hours > 0) return `${hours}س ${minutes}د`;
  return `${minutes}د`;
}
