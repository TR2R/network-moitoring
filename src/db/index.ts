import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { isDbKillSwitchOn, setDbKillSwitch as setDbKillSwitchState } from "@/lib/resilience";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

// إنشاء اتصال سحابي خفيف وسريع متوافق 100% مع Vercel و Neon
const sql = neon(databaseUrl);
export const db = drizzle(sql);

/**
 * مفتاح اختبار انقطاع قاعة البيانات (Chaos switch)
 */
export function setDbKillSwitch(enabled: boolean) {
  setDbKillSwitchState(enabled);
}

export function isDbKillSwitchEnabled() {
  return isDbKillSwitchOn();
