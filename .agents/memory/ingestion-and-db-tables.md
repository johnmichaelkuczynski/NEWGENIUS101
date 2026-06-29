---
name: Ingestion & live DB tables
description: How author content is ingested and which DB tables are actually live (schema drift vs shared/schema.ts)
---

# Drop-folder ingestion

Single drop folder `drop/`. Files named `AUTHOR_CATEGORY[_N].txt` (CATEGORY ∈ WORKS|QUOTES|POSITIONS|ARGUMENTS, N = lot number). Run `npx tsx scripts/ingest-drop-folder.ts` (`--dry-run` to preview). Filename routes to the table; success → `drop/_processed/`, failure → `drop/_failed/`. Partial inserts stay in `_processed` with a WARN (re-running would duplicate — there is no row-level dedup; the file-move is the only idempotency guard).

# Live DB tables (the ones that actually exist)

`texts`(thinker,title,source_file,content) → chunked+embedded into `chunks`(thinker,source_text_id,chunk_index,chunk_text,embedding); `quotes`(thinker,quote_text,topic,embedding); `positions`(thinker,topic,position_text,embedding); `arguments`(thinker,argument_type,premises jsonb,conclusion,topic,importance,embedding).

**Why this matters / gotchas:**
- `thinker` columns are **citext** (case-insensitive text), NOT a Postgres enum. Any new author id inserts fine — no enum to extend. Use lowercase last-name ids (hyphens ok: `james-allen`).
- `embedding` is `vector(1536)` (OpenAI `text-embedding-ada-002`), nullable. Insert via neon raw SQL with `${JSON.stringify(vec)}::vector`; jsonb premises via `::jsonb`. But rows with NULL embedding are invisible to semantic search, so always embed.
- **Schema drift:** the live DB does NOT match `shared/schema.ts`. Tables `paper_chunks` and `thinker_quotes` referenced in code DO NOT EXIST. All `server/generate-*-embeddings.ts` / `server/generate-embeddings.ts` are DEAD — they write to `paper_chunks` and `generate-embeddings.ts` even does `db.delete(paperChunks)` first (unsafe, do not run). `scripts/import-positions.ts` also targets stale columns (`position`/`source`/`page`) that differ from live `positions` (`position_text`, no source/page).
- The only current works→chunks embedder before this was `scripts/embed-from-texts-table.ts` (reads `texts`). New unified ingester supersedes the folder-scan flow.
- **Adding a column: do NOT run `npm run db:push`.** Because of the drift, drizzle-kit goes interactive and proposes *destructive table renames* (e.g. "rename arguments → argument_statements"). To add a column safely, run a direct `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ... DEFAULT ...` via the `executeSql` callback (it uses the live Neon DATABASE_URL; the Replit built-in DB is NOT provisioned), then mirror the column in `shared/schema.ts` for types. Adding a NOT NULL column with a default is safe on the live table.

# Embedding scripts & their hard-won quirks

- `scripts/embed-from-texts-table.ts <thinker>` — chunks+embeds an author's `texts` rows into `chunks`. Batches embeddings (100/OpenAI call) and inserts each batch in parallel over HTTP — fast enough to finish ~2700 chunks well within one foreground run. **Index-aware resumable + idempotent**: reads existing `chunk_index` set, embeds only missing, `ON CONFLICT (source_text_id, chunk_index) DO NOTHING`. Rerun is safe and adds nothing if complete.
- `scripts/embed-missing.ts <thinker> [quotes|positions|arguments]` — backfills `embedding IS NULL` rows in quotes/positions/arguments. Needed because older loads inserted these rows WITHOUT embeddings (so they were invisible to search). The drop ingester DOES embed all four types; only legacy data needs this.
- There is a `UNIQUE(source_text_id, chunk_index)` index on `chunks` (`chunks_source_text_idx`) — added so embedders can use ON CONFLICT.

**Why these decisions / environment constraints:**
- **Background jobs die on every workflow restart** (and a workflow restart happens on each checkpoint/turn-end). `nohup`/`setsid`/`disown` did NOT save a detached `tsx` job — it was killed mid-run twice. Lesson: long-running data jobs must run in the **foreground** (under the ~120s bash limit) and be **resumable**, or be driven in slices. Batching OpenAI embeddings is what makes a foreground full run feasible.
- **neon HTTP client (`neon(url)`) quirks:** tagged-template `sql\`...\`` works; the function-call form `sql(queryString, paramsArray)` ALSO works for parameterized queries; but `sql.query()` is NOT a function and `Pool` from `@neondatabase/serverless` FAILS (no WebSocket constructor in this runtime — "All attempts to open a WebSocket… failed"). Use tagged templates or `sql(string, params)`; for bulk insert, fan out row inserts with `Promise.all`.
- **`process.env` is NOT available in the code_execution sandbox** (no DATABASE_URL/OPENAI_API_KEY). Use the `executeSql` callback there for DB reads; run anything needing secrets as a `tsx` script via bash (which has env).
- `arguments.premises` is **jsonb** (a JS array when read back), so `array_to_string(premises,…)` errors — join it in JS instead.

# Making a new author fully usable

Data in tables is necessary but NOT sufficient to show in the UI. The figure list is hardcoded in `server/storage.ts` `getAllThinkers()` (`validThinkers` + `customIcons` + `customTitles`). A new author (e.g. Locke) must be added there to appear in `/api/figures`. Retrieval (`server/.../vector-search.ts`) matches thinker by ILIKE substring of the figureId.
