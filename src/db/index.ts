import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { isDbKillSwitchOn, setDbKillSwitch as setDbKillSwitchState } from "@/lib/resilience";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const sql = neon(databaseUrl);
export const db = drizzle(sql);

export function setDbKillSwitch(enabled: boolean) {
  setDbKillSwitchState(enabled);
}

export function isDbKillSwitchEnabled() {
  return isDbKillSwitchOn();
}
