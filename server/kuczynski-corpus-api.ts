import type { Express, RequestHandler, Request, Response } from "express";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";

const listParams = z.object({
  q: z.string().trim().max(200).optional(),
  sourceId: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const sourceIdParams = z.object({ sourceId: z.string().min(1).max(100) });
const thinker = "kuczynski";

type CorpusRow = Record<string, unknown>;

function respondWithRows(
  res: Response,
  rows: CorpusRow[],
  limit: number,
  offset: number,
  category: string,
) {
  res.json({
    category,
    items: rows.slice(0, limit),
    limit,
    offset,
    hasMore: rows.length > limit,
    nextOffset: rows.length > limit ? offset + limit : null,
  });
}

function route(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    handler(req, res).catch((error) => {
      console.error("[Kuczynski corpus API]", error);
      if (!res.headersSent) res.status(500).json({ error: "Corpus retrieval failed" });
    });
  };
}

function parseList(req: Request, res: Response) {
  const parsed = listParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
    return null;
  }
  return parsed.data;
}

function textFilter(q: string | undefined, columns: SQL[]) {
  if (!q) return sql`TRUE`;
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  return sql`(${sql.join(columns.map((column) => sql`${column} ILIKE ${pattern} ESCAPE '\\'`), sql` OR `)})`;
}

export function registerKuczynskiCorpusRoutes(app: Express, authenticate: RequestHandler) {
  const prefix = "/api/external/kuczynski-standalone";

  // Catalog of actual source texts; no generated prose or invented attribution.
  app.get(`${prefix}/sources`, authenticate, route(async (req, res) => {
    const params = parseList(req, res);
    if (!params) return;
    const { q, limit, offset } = params;
    const match = textFilter(q, [sql`t.title`, sql`t.source_file`]);
    const result = await db.execute(sql`
      SELECT t.id AS "sourceId", t.title, t.source_file AS "sourceFile",
             (SELECT COUNT(*)::int FROM chunks c
              WHERE c.source_text_id = t.id AND LOWER(c.thinker::text) = ${thinker}) AS "passageCount"
      FROM texts t
      WHERE LOWER(t.thinker::text) = ${thinker} AND ${match}
      ORDER BY t.title, t.id
      LIMIT ${limit + 1} OFFSET ${offset}
    `);
    respondWithRows(res, result.rows as CorpusRow[], limit, offset, "sources");
  }));

  app.get(`${prefix}/sources/:sourceId`, authenticate, route(async (req, res) => {
    const parsed = sourceIdParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid source ID" });
      return;
    }
    const result = await db.execute(sql`
      SELECT id AS "sourceId", title, source_file AS "sourceFile", content
      FROM texts
      WHERE id = ${parsed.data.sourceId} AND LOWER(thinker::text) = ${thinker}
      LIMIT 1
    `);
    if (!result.rows.length) {
      res.status(404).json({ error: "Kuczynski source not found" });
      return;
    }
    res.json(result.rows[0]);
  }));

  // Paginated, verbatim chunks for Box A. Returned source IDs join to /sources/:sourceId.
  app.get(`${prefix}/passages`, authenticate, route(async (req, res) => {
    const params = parseList(req, res);
    if (!params) return;
    const { q, sourceId, limit, offset } = params;
    const match = textFilter(q, [sql`c.chunk_text`, sql`t.title`]);
    const result = await db.execute(sql`
      SELECT c.id, c.chunk_text AS "text", c.chunk_index AS "chunkIndex",
             t.id AS "sourceId", t.title AS "sourceTitle", t.source_file AS "sourceFile"
      FROM chunks c
      JOIN texts t ON t.id = c.source_text_id AND LOWER(t.thinker::text) = ${thinker}
      WHERE LOWER(c.thinker::text) = ${thinker}
        AND (${sourceId || null}::text IS NULL OR c.source_text_id = ${sourceId || null})
        AND ${match}
      ORDER BY t.title, t.id, c.chunk_index, c.id
      LIMIT ${limit + 1} OFFSET ${offset}
    `);
    respondWithRows(res, result.rows as CorpusRow[], limit, offset, "verbatim_source_passages");
  }));

  app.get(`${prefix}/quotes`, authenticate, route(async (req, res) => {
    const params = parseList(req, res);
    if (!params) return;
    const { q, sourceId, limit, offset } = params;
    const match = textFilter(q, [sql`r.quote_text`, sql`r.topic`]);
    const result = await db.execute(sql`
      SELECT r.id, r.quote_text AS "text", r.topic,
             r.source_text_id AS "sourceId", t.title AS "sourceTitle",
             t.source_file AS "sourceFile"
      FROM quotes r
      LEFT JOIN texts t ON t.id = r.source_text_id AND LOWER(t.thinker::text) = ${thinker}
      WHERE LOWER(r.thinker::text) = ${thinker}
        AND (${sourceId || null}::text IS NULL OR r.source_text_id = ${sourceId || null})
        AND ${match}
      ORDER BY r.id
      LIMIT ${limit + 1} OFFSET ${offset}
    `);
    respondWithRows(res, result.rows as CorpusRow[], limit, offset, "stored_quotes");
  }));

  app.get(`${prefix}/arguments`, authenticate, route(async (req, res) => {
    const params = parseList(req, res);
    if (!params) return;
    const { q, sourceId, limit, offset } = params;
    const match = textFilter(q, [sql`a.conclusion`, sql`a.premises::text`, sql`a.topic`]);
    const result = await db.execute(sql`
      SELECT a.id, a.argument_type AS "argumentType", a.premises, a.conclusion,
             a.topic, a.importance, a.source_text_id AS "sourceId",
             t.title AS "sourceTitle", t.source_file AS "sourceFile"
      FROM arguments a
      LEFT JOIN texts t ON t.id = a.source_text_id AND LOWER(t.thinker::text) = ${thinker}
      WHERE LOWER(a.thinker::text) = ${thinker}
        AND (${sourceId || null}::text IS NULL OR a.source_text_id = ${sourceId || null})
        AND ${match}
      ORDER BY a.id
      LIMIT ${limit + 1} OFFSET ${offset}
    `);
    respondWithRows(res, result.rows as CorpusRow[], limit, offset, "derived_arguments");
  }));

  app.get(`${prefix}/positions`, authenticate, route(async (req, res) => {
    const params = parseList(req, res);
    if (!params) return;
    const { q, sourceId, limit, offset } = params;
    const match = textFilter(q, [sql`p.position_text`, sql`p.topic`]);
    const result = await db.execute(sql`
      SELECT p.id, p.position_text AS "text", p.topic,
             p.source_text_id AS "sourceId", t.title AS "sourceTitle",
             t.source_file AS "sourceFile"
      FROM positions p
      LEFT JOIN texts t ON t.id = p.source_text_id AND LOWER(t.thinker::text) = ${thinker}
      WHERE LOWER(p.thinker::text) = ${thinker}
        AND (${sourceId || null}::text IS NULL OR p.source_text_id = ${sourceId || null})
        AND ${match}
      ORDER BY p.id
      LIMIT ${limit + 1} OFFSET ${offset}
    `);
    respondWithRows(res, result.rows as CorpusRow[], limit, offset, "derived_positions");
  }));
}