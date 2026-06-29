import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';

const DATABASE_URL = process.env.DATABASE_URL!;
const sql = neon(DATABASE_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBED_BATCH = 100;

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: texts.map(t => (t && t.trim() ? t.slice(0, 8000) : ' ')),
  });
  return res.data.map(d => d.embedding);
}

type Spec = { table: string; selectCols: string; body: (row: any) => string };
const SPECS: Record<string, Spec> = {
  quotes: { table: 'quotes', selectCols: 'quote_text', body: r => r.quote_text || '' },
  positions: { table: 'positions', selectCols: 'position_text', body: r => r.position_text || '' },
  arguments: {
    table: 'arguments',
    selectCols: 'premises, conclusion',
    body: r => {
      const prem = Array.isArray(r.premises) ? r.premises.join(' ') : String(r.premises || '');
      return `${prem} ${r.conclusion || ''}`.trim();
    },
  },
};

async function backfill(spec: Spec, thinker: string) {
  const rows = await sql(
    `SELECT id, ${spec.selectCols} FROM ${spec.table}
     WHERE LOWER(thinker) = LOWER($1) AND embedding IS NULL
     ORDER BY id`,
    [thinker]
  ) as any[];

  if (rows.length === 0) {
    console.log(`${spec.table}: nothing to backfill`);
    return;
  }
  console.log(`${spec.table}: ${rows.length} rows missing embeddings`);

  let done = 0;
  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const slice = rows.slice(i, i + EMBED_BATCH);
    let embeddings: number[][];
    let attempt = 0;
    while (true) {
      try { embeddings = await embedBatch(slice.map(spec.body)); break; }
      catch (err: any) {
        attempt++;
        if (attempt >= 3) throw err;
        console.log(`  embed retry ${attempt} (${err.message})`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    await Promise.all(slice.map((row, k) =>
      sql(`UPDATE ${spec.table} SET embedding = $1::vector WHERE id = $2`,
        [JSON.stringify(embeddings[k]), row.id])
    ));
    done += slice.length;
    console.log(`  ${spec.table}: ${done}/${rows.length}`);
  }
}

async function main() {
  const thinker = process.argv[2];
  const only = process.argv[3];
  if (!thinker) {
    console.error('Usage: npx tsx scripts/embed-missing.ts <thinker> [quotes|positions|arguments]');
    process.exit(1);
  }
  const targets = only ? [only] : Object.keys(SPECS);
  for (const t of targets) {
    const spec = SPECS[t];
    if (!spec) { console.error(`unknown table: ${t}`); continue; }
    await backfill(spec, thinker);
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
