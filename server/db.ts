import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

// Use EXTERNAL_DATABASE_URL if provided, otherwise fall back to DATABASE_URL
const databaseUrl = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "EXTERNAL_DATABASE_URL or DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle({ client: pool, schema });

/**
 * Bootstrap step: guarantees the api_keys table exists in whichever database
 * the server is using. drizzle-kit push only targets DATABASE_URL, but the app
 * may run against EXTERNAL_DATABASE_URL, so we ensure this table on startup.
 * Keep this definition in sync with `apiKeys` in shared/schema.ts.
 */
export async function ensureApiKeysTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      key_hash VARCHAR(64) NOT NULL UNIQUE,
      key_prefix VARCHAR(16) NOT NULL,
      label VARCHAR(256) NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT false,
      request_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
}
