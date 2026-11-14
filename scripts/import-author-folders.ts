import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import OpenAI from "openai";
import { cleanGutenberg, contentIdentity, fingerprint, importChunks } from "./author-import-utils";

const url = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error("Application database is not configured");
const sql = neon(url);
const embeddings = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 90000, maxRetries: 2 });
const reportPath = "generated-artifacts/author-import/report.json";
const apply = process.argv.includes("--apply");
const authorIndex = process.argv.indexOf("--authors");
const authors = authorIndex < 0 ? [] : process.argv[authorIndex + 1].split(",");
const report: any[] = [];

async function vectorsFor(texts: string[]) {
  const response = await embeddings.embeddings.create({ model: "text-embedding-ada-002", input: texts });
  const data = [...response.data].sort((a, b) => a.index - b.index);
  if (data.length !== texts.length || data.some((item, i) =>
    item.index !== i || item.embedding.length !== 1536 || item.embedding.some(n => !Number.isFinite(n)))) {
    throw new Error("Embedding response failed completeness or vector-dimension checks");
  }
  return data.map(item => item.embedding);
}

async function main() {
  if (!authors.length || authors.some(author => !/^[a-z_]{2,40}$/.test(author))) {
    throw new Error("Usage: node --import tsx scripts/import-author-folders.ts --authors hegel,whewell [--apply]");
  }
  await mkdir(path.dirname(reportPath), { recursive: true });
  // Check embeddings before creating records. No application restart is needed.
  if (apply) await vectorsFor(["A primary-source passage about knowledge and reasoning."]);
  for (const author of authors) {
    const folder = path.join("ALL_AUTHOR_WORKS", author);
    const existing = await sql`
      SELECT t.id, t.title, t.source_file, t.content,
        (SELECT count(*)::int FROM chunks c WHERE c.source_text_id=t.id) AS chunks,
        (SELECT count(*)::int FROM chunks c WHERE c.source_text_id=t.id AND c.embedding IS NULL) AS unembedded
      FROM texts t WHERE lower(t.thinker::text) = ${author}
    `;
    const identities = new Map(existing.map(row => [contentIdentity(cleanGutenberg(row.content)), row]));
    for (const filename of (await readdir(folder)).filter(file => file.toLowerCase().endsWith(".txt")).sort()) {
      const file = path.join(folder, filename);
      const bytes = await readFile(file);
      const rawHash = fingerprint(bytes.toString("base64"));
      const content = cleanGutenberg(bytes.toString("utf8"));
      const title = path.parse(filename).name;
      const sourceFile = `${author}/${title.toLowerCase()}`;
      if (content.length < 1000) throw new Error(`Source is unexpectedly short after cleaning: ${file}`);
      const identity = contentIdentity(content);
      const matching = identities.get(identity);
      const byFilename = existing.find(row => row.source_file === sourceFile);
      if (byFilename && contentIdentity(cleanGutenberg(byFilename.content)) !== identity) {
        throw new Error(`A different version already uses this source filename: ${file}`);
      }
      const record = matching || byFilename;
      const entry = {
        author, file, title, originalHash: rawHash, characters: content.length,
        removedCharacters: bytes.toString("utf8").length - content.length,
        textId: record?.id, status: apply ? "indexing" : "planned",
        existingChunks: Number(record?.chunks || 0), addedChunks: 0, expectedChunks: 0,
      };
      report.push(entry);
      // An already indexed copy with equivalent words need not be duplicated or
      // rechunked simply because a new upload uses different whitespace.
      if (record && record.chunks > 0 && record.unembedded === 0
        && record.chunks === importChunks(record.content).length) {
        entry.status = "already indexed; duplicate skipped";
        console.log(`${author}: ${filename}: already indexed (${record.chunks} passages)`);
        continue;
      }
      const chunks = importChunks(record?.chunks > 0 ? record.content : content);
      entry.expectedChunks = chunks.length;
      console.log(`${author}: ${filename}: ${matching ? "existing matching work" : "new work"}, ${chunks.length} passages${apply ? "" : " (plan only)"}`);
      if (!apply) continue;
      let textId = record?.id;
      if (!textId) {
        const inserted = await sql`
          INSERT INTO texts (id, thinker, title, source_file, content)
          VALUES (gen_random_uuid(), ${author}, ${title}, ${sourceFile}, ${content}) RETURNING id
        `;
        textId = inserted[0].id;
      } else if (record.chunks === 0) {
        // Reuse an unindexed equivalent work; remove only the wrapper from the
        // database copy. Uploaded originals and authored words remain intact.
        await sql`UPDATE texts SET content=${content}, title=${title} WHERE id=${textId}`;
      }
      entry.textId = textId;
      const present = await sql`SELECT chunk_index, chunk_text, embedding IS NOT NULL AS embedded FROM chunks WHERE source_text_id=${textId}`;
      const occupied = new Map(present.map(row => [Number(row.chunk_index), row]));
      const todo: number[] = [];
      for (let index = 0; index < chunks.length; index++) {
        const current = occupied.get(index);
        if (current && current.chunk_text !== chunks[index]) throw new Error(`Chunk layout mismatch; existing text was not altered: ${filename}`);
        if (!current?.embedded) todo.push(index);
      }
      for (let start = 0; start < todo.length; start += 100) {
        const indices = todo.slice(start, start + 100);
        const vectors = await vectorsFor(indices.map(index => chunks[index]));
        const rows = indices.map((index, k) => ({ chunk_index: index, chunk_text: chunks[index], embedding: vectors[k] }));
        const inserted = await sql`
          INSERT INTO chunks (id, thinker, source_text_id, chunk_index, chunk_text, embedding)
          SELECT gen_random_uuid(), ${author}, ${textId}, x.chunk_index, x.chunk_text, x.embedding::text::vector
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(chunk_index int, chunk_text text, embedding jsonb)
          ON CONFLICT (source_text_id, chunk_index) DO UPDATE SET embedding=EXCLUDED.embedding
            WHERE chunks.embedding IS NULL AND chunks.chunk_text=EXCLUDED.chunk_text
          RETURNING chunk_index
        `;
        entry.addedChunks += inserted.length;
        await writeFile(reportPath, JSON.stringify(report, null, 2));
        console.log(`${author}: ${filename}: ${Math.min(start + indices.length, todo.length)}/${todo.length} missing passages embedded`);
      }
      const final = await sql`
        SELECT count(*)::int AS total, count(embedding)::int AS embedded,
          count(DISTINCT chunk_index)::int AS unique_indices,
          min(chunk_index)::int AS first, max(chunk_index)::int AS last
        FROM chunks WHERE source_text_id=${textId}
      `;
      if (final[0].total !== chunks.length || final[0].embedded !== chunks.length ||
        final[0].unique_indices !== chunks.length || final[0].first !== 0 || final[0].last !== chunks.length - 1) {
        throw new Error(`Index verification failed for ${filename}`);
      }
      if (fingerprint((await readFile(file)).toString("base64")) !== rawHash) {
        throw new Error(`The uploaded source changed during import: ${filename}`);
      }
      entry.status = "complete";
      identities.set(identity, { id: textId, content, title, source_file: sourceFile, chunks: chunks.length, unembedded: 0 });
      console.log(`${author}: ${filename}: COMPLETE ${chunks.length} searchable passages; original unchanged`);
    }
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ apply, files: report.length, addedPassages: report.reduce((n, row) => n + row.addedChunks, 0), report: reportPath }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {});
    console.error("Import stopped; completed batches are resumable.", { status: error?.status, code: error?.code, message: error?.status ? "Embedding or database service rejected the request" : error?.message });
    process.exitCode = 1;
  });
}
