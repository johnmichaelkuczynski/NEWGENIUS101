import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { pool } from "../db";
import { cleanLibraryText, libraryContentHash, librarySearchTerms, splitLibraryText, type LibraryPassage } from "./text";

export const bookColumns = `id, title, author, filename, status, word_count AS "wordCount",
  chunk_count AS "chunkCount", indexed_chunks AS "indexedChunks", error, created_at AS "createdAt"`;
const queue = new Set<string>();
let working = false;

async function embed(inputs: string[]): Promise<number[][]> {
  if (!process.env.OPENAI_API_KEY) throw new Error("Library indexing requires the configured embedding service.");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 90000, maxRetries: 3 });
  const response = await client.embeddings.create({ model: "text-embedding-ada-002", input: inputs });
  const data = [...response.data].sort((a, b) => a.index - b.index);
  if (data.length !== inputs.length || data.some((row, index) =>
    row.index !== index || row.embedding.length !== 1536 || row.embedding.some(n => !Number.isFinite(n)))) {
    throw new Error("The embedding service returned incomplete library vectors.");
  }
  return data.map(row => row.embedding);
}

/** Unique content hash prevents duplicate records, including simultaneous uploads. */
export async function addLibraryBook(input: { title: string; author: string; filename: string; text: string }) {
  const content = cleanLibraryText(input.text);
  if (content.length < 200) throw new Error("No substantial readable text was found. Scanned PDFs need OCR before upload.");
  if (content.length > 15000000) throw new Error("This book is too large. Split it into volumes of at most 15 million characters.");
  const result = await pool.query(`
    INSERT INTO library_books (id,title,author,filename,content,content_hash,word_count,chunk_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (content_hash) DO NOTHING RETURNING ${bookColumns}`,
    [randomUUID(), input.title.trim(), input.author.trim(), input.filename, content,
      libraryContentHash(content), content.split(/\s+/).length, splitLibraryText(content).length]);
  const duplicate = !result.rows.length;
  const book = result.rows[0] || (await pool.query(`SELECT ${bookColumns} FROM library_books WHERE content_hash=$1`, [libraryContentHash(content)])).rows[0];
  if (book.status === "indexing") enqueueLibraryBook(book.id);
  return { book, duplicate };
}

export function enqueueLibraryBook(id: string) {
  queue.add(id);
  if (!working) void drain();
}

async function drain() {
  working = true;
  try {
    while (queue.size) {
      const id = queue.values().next().value;
      if (!id) break;
      queue.delete(id);
      try { await indexLibraryBook(id); }
      catch (error) {
        const reason = (error as any)?.status === 429
          ? "The embedding service is temporarily rate-limited. Retry indexing."
          : "Indexing could not finish. Completed passages were saved; retry to resume.";
        await pool.query("UPDATE library_books SET status='failed',error=$2,updated_at=now() WHERE id=$1", [id, reason]).catch(() => {});
        console.error("[Library] Indexing stopped", { bookId: id, code: (error as any)?.code || (error as any)?.status || "INDEX_FAILED" });
      }
    }
  } finally { working = false; }
}

async function indexLibraryBook(id: string) {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [`library:${id}`])).rows[0].acquired;
    if (!locked) {
      // The previous server may still be releasing its connection during a
      // restart. Recheck rather than leaving a saved job stranded forever.
      setTimeout(() => enqueueLibraryBook(id), 5000).unref();
      return;
    }
    const book = (await client.query("SELECT content FROM library_books WHERE id=$1 AND status='indexing'", [id])).rows[0];
    if (!book) return;
    const chunks = splitLibraryText(book.content);
    const present = await client.query("SELECT chunk_index FROM library_chunks WHERE book_id=$1 AND embedding IS NOT NULL", [id]);
    const complete = new Set(present.rows.map(row => Number(row.chunk_index)));
    const todo = chunks.map((_, index) => index).filter(index => !complete.has(index));
    for (let start = 0; start < todo.length; start += 60) {
      const indices = todo.slice(start, start + 60);
      const vectors = await embed(indices.map(index => chunks[index]));
      // Deletion while indexing is safe and does not resurrect a removed book.
      if (!(await client.query("SELECT 1 FROM library_books WHERE id=$1", [id])).rowCount) return;
      await client.query(`
        INSERT INTO library_chunks (id,book_id,chunk_index,text,embedding)
        SELECT $1 || ':' || x.idx, $1, x.idx, x.text, x.embedding::text::vector
        FROM jsonb_to_recordset($2::jsonb) AS x(idx int,text text,embedding jsonb)
        ON CONFLICT (book_id,chunk_index) DO NOTHING`,
        [id, JSON.stringify(indices.map((index, i) => ({ idx: index, text: chunks[index], embedding: vectors[i] })))]);
      await client.query(`UPDATE library_books SET indexed_chunks=
        (SELECT count(*) FROM library_chunks WHERE book_id=$1 AND embedding IS NOT NULL),
        updated_at=now() WHERE id=$1`, [id]);
    }
    const count = Number((await client.query("SELECT count(*) AS total FROM library_chunks WHERE book_id=$1 AND embedding IS NOT NULL", [id])).rows[0].total);
    if (count !== chunks.length) throw new Error("Library index is incomplete.");
    await client.query("UPDATE library_books SET status='ready',error=NULL,indexed_chunks=$2,updated_at=now() WHERE id=$1", [id, count]);
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`library:${id}`]).catch(() => {});
    client.release();
  }
}

export async function resumeLibraryImports() {
  const rows = await pool.query("SELECT id FROM library_books WHERE status='indexing' ORDER BY created_at");
  for (const row of rows.rows) enqueueLibraryBook(row.id);
}

export async function searchLibrary(query: string, bookIds: string[] = []): Promise<LibraryPassage[]> {
  const count = await pool.query("SELECT count(*)::int AS total FROM library_books WHERE status='ready'");
  if (!count.rows[0].total) return [];
  const terms = librarySearchTerms(query);
  // Only letters/numbers reach to_tsquery; user syntax cannot become SQL or tsquery operators.
  const tsQuery = terms.join(" | ") || "library";
  let vector: number[] | null = null;
  try { vector = (await embed([query.slice(0, 12000)]))[0]; }
  catch { console.warn("[Library] Semantic search unavailable; searching literal indexed text instead."); }
  const rows = await pool.query({ text: `
    WITH candidates AS (
      SELECT c.id,c.book_id,c.chunk_index,c.text,b.title,b.author,
        ts_rank_cd(to_tsvector('english',c.text),to_tsquery('english',$1)) AS lexical,
        ts_rank_cd(to_tsvector('english',b.title || ' ' || b.author),to_tsquery('english',$1)) AS metadata,
        CASE WHEN $3::vector IS NULL THEN 1 ELSE c.embedding <=> $3::vector END AS distance
      FROM library_chunks c JOIN library_books b ON b.id=c.book_id
      WHERE b.status='ready' AND (cardinality($2::text[])=0 OR b.id=ANY($2::text[]))
    )
    SELECT * FROM candidates
    WHERE lexical>0 OR metadata>0 OR distance<0.38 OR cardinality($2::text[])>0
    ORDER BY (lexical*2 + metadata*3 + (1-distance)*0.7) DESC LIMIT 12`,
    values: [tsQuery, bookIds, vector ? JSON.stringify(vector) : null] });
  if (!vector && !rows.rows.length && bookIds.length) {
    throw new Error("Library semantic search is temporarily unavailable and no literal passages matched. Please retry.");
  }
  // Include adjacent source passages so a keyword hit is not severed from its argument.
  const ranges = rows.rows.map(row => ({ book_id: row.book_id, idx: row.chunk_index }));
  if (!ranges.length) return [];
  const adjacent = await pool.query(`
    SELECT DISTINCT c.id,c.book_id AS "bookId",b.title,b.author,c.chunk_index AS "chunkIndex",c.text
    FROM library_chunks c JOIN library_books b ON b.id=c.book_id
    JOIN jsonb_to_recordset($1::jsonb) AS a(book_id text,idx int)
      ON c.book_id=a.book_id AND c.chunk_index BETWEEN greatest(0,a.idx-1) AND a.idx+1
    WHERE b.status='ready' ORDER BY c.book_id,c.chunk_index`, [JSON.stringify(ranges)]);
  const rank = new Map(rows.rows.map((row, index) => [row.id, index]));
  return adjacent.rows.sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99)).slice(0, 18);
}
