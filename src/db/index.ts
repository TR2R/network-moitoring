import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { isDbKillSwitchOn, setDbKillSwitch as setDbKillSwitchState } from "@/lib/resilience";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __netmonDbKillSwitch?: boolean;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    ssl: {
      rejectUnauthorized: false, // مخصص لضمان قبول شهادة أمان Neon ومنع تعليق الاتصال
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

/**
 * مفتاح اختبار انقطاع قاعدة البيانات (Chaos switch)
 * يُستخدم من لوحة المتابعة لاختبار المسار الاحتياطي: كل الاستعلامات تفشل
 * فيتحول النظام تلقائيًا إلى اللقطة المحفوظة محليًا ويخزن القياسات مؤقتًا.
 */
export function setDbKillSwitch(enabled: boolean) {
  setDbKillSwitchState(enabled);
}

export function isDbKillSwitchEnabled() {
  return isDbKillSwitchOn();
}

if (!("__netmonPatched" in pool) && !(pool as unknown as { __netmonPatched?: boolean }).__netmonPatched) {
  const originalQuery = pool.query.bind(pool);
  const patched = async (...args: unknown[]) => {
    if (isDbKillSwitchEnabled()) {
      throw new Error("محاكاة انقطاع قاعدة البيانات (chaos switch مفعّل)");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any)(...args);
  };
  (pool as unknown as { __netmonPatched?: boolean; query: unknown }).__netmonPatched = true;
  (pool as unknown as { query: unknown }).query = patched;
}

export const db = drizzle(pool);
