---
name: Dual-DB schema sync
description: Runtime DB is EXTERNAL_DATABASE_URL but drizzle-kit push targets DATABASE_URL — new tables must be created in both.
---

The rule: any new table added to `shared/schema.ts` must be created manually (SQL via psql) in **both** `$DATABASE_URL` and `$EXTERNAL_DATABASE_URL`.

**Why:** `server/db.ts` prefers `EXTERNAL_DATABASE_URL`; `drizzle.config.ts` only knows `DATABASE_URL`. `npm run db:push` therefore never touches the database the app actually uses. This bit the api_keys, unique_visitors, and anon_usage tables (Aug 2026).

**How to apply:** after any schema change, run the equivalent `CREATE TABLE IF NOT EXISTS` against both URLs, or fix the config to target the external DB.
