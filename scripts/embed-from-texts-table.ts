import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';

const DATABASE_URL = process.env.DATABASE_URL!;
const sql = neon(DATABASE_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const EMBED_BATCH = 100;

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;

    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint = Math.max(lastPeriod, lastNewline);

      if (breakPoint > start + CHUNK_SIZE * 0.5) {
        end = breakPoint + 1;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 100) {
      chunks.push(chunk);
    }

    start = end - CHUNK_OVERLAP;
  }

  return chunks;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: texts.map(t => t.slice(0, 8000)),
  });
  return response.data.map(d => d.embedding);
}

async function main() {
  const thinker = process.argv[2];

  if (!thinker) {
    console.error('Usage: npx tsx scripts/embed-from-texts-table.ts <thinker-name>');
    console.error('Example: npx tsx scripts/embed-from-texts-table.ts jung');
    process.exit(1);
  }

  console.log(`\nEmbedding texts for: ${thinker}`);
  console.log('='.repeat(50));

  const texts = await sql`
    SELECT id, title, content FROM texts
    WHERE LOWER(thinker) = LOWER(${thinker})
    ORDER BY title
  `;

  console.log(`Found ${texts.length} texts to process\n`);

  if (texts.length === 0) {
    console.log('No texts found for this thinker.');
    process.exit(0);
  }

  let totalInserted = 0;

  for (const text of texts) {
    const chunks = chunkText(text.content as string);

    // Index-aware resume: read which chunk_indexes already exist for this
    // text and only embed the missing ones. This heals holes left by an
    // interrupted run and never skips or duplicates a chunk. Combined with
    // the UNIQUE(source_text_id, chunk_index) index + ON CONFLICT below,
    // reruns are fully idempotent.
    const existingRows = await sql`
      SELECT chunk_index FROM chunks WHERE source_text_id = ${text.id}
    ` as any[];
    const existing = new Set<number>(existingRows.map(r => Number(r.chunk_index)));
    const todo: number[] = [];
    for (let i = 0; i < chunks.length; i++) if (!existing.has(i)) todo.push(i);

    if (todo.length === 0) {
      console.log(`Processing: ${text.title} — already complete (${chunks.length} chunks)`);
      continue;
    }

    console.log(`Processing: ${text.title} — ${chunks.length} chunks total, ${existing.size} present, ${todo.length} to embed`);

    for (let i = 0; i < todo.length; i += EMBED_BATCH) {
      const idxBatch = todo.slice(i, i + EMBED_BATCH);
      const slice = idxBatch.map(idx => chunks[idx]);

      let embeddings: number[][];
      let attempt = 0;
      while (true) {
        try {
          embeddings = await embedBatch(slice);
          break;
        } catch (err: any) {
          attempt++;
          if (attempt >= 3) throw err;
          console.log(`  embed retry ${attempt} (${err.message})`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }

      // Insert this batch's rows in parallel over HTTP. ON CONFLICT makes
      // reruns safe even if a previous run inserted some of these indexes.
      await Promise.all(idxBatch.map((idx, k) =>
        sql`
          INSERT INTO chunks (thinker, source_text_id, chunk_index, chunk_text, embedding)
          VALUES (${thinker}, ${text.id}, ${idx}, ${chunks[idx]}, ${JSON.stringify(embeddings[k])}::vector)
          ON CONFLICT (source_text_id, chunk_index) DO NOTHING
        `
      ));

      totalInserted += idxBatch.length;
      console.log(`  embedded ${Math.min(i + idxBatch.length, todo.length)}/${todo.length} missing (of ${chunks.length} total)`);
    }
  }

  console.log(`\nDone! Inserted ${totalInserted} new chunks for ${thinker}`);

  const finalCount = await sql`SELECT COUNT(*) as count FROM chunks WHERE LOWER(thinker) = LOWER(${thinker})`;
  console.log(`Total chunks in database for ${thinker}: ${finalCount[0].count}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
