/**
 * Unified drag-and-drop ingestion.
 *
 * Drop .txt files into the `drop/` folder using this naming convention:
 *
 *   AUTHOR_CATEGORY            e.g.  LOCKE_WORKS.txt
 *   AUTHOR_CATEGORY_N          e.g.  LOCKE_WORKS_2.txt   (N = lot / volume number)
 *
 * CATEGORY must be one of: WORKS | QUOTES | POSITIONS | ARGUMENTS
 * The filename decides which database table the file is loaded into:
 *
 *   WORKS      -> texts table, then chunked + embedded into chunks
 *   QUOTES     -> quotes table
 *   POSITIONS  -> positions table
 *   ARGUMENTS  -> arguments table
 *
 * Author is matched case-insensitively and stored lowercase (the `thinker`
 * columns are citext). Hyphenated ids are fine (e.g. JAMES-ALLEN, VON-MISES).
 *
 * Usage:
 *   npx tsx scripts/ingest-drop-folder.ts            # ingest everything in drop/
 *   npx tsx scripts/ingest-drop-folder.ts --dry-run  # parse + report, no DB writes
 *
 * Successfully ingested files are moved to drop/_processed/.
 * Files that fail are moved to drop/_failed/ (with the reason printed).
 */

import { neon } from "@neondatabase/serverless";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

const DATABASE_URL = process.env.DATABASE_URL!;
const sql = neon(DATABASE_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DROP_DIR = path.join(process.cwd(), "drop");
const PROCESSED_DIR = path.join(DROP_DIR, "_processed");
const FAILED_DIR = path.join(DROP_DIR, "_failed");

const DRY_RUN = process.argv.includes("--dry-run");

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

const CATEGORIES = ["WORKS", "QUOTES", "POSITIONS", "ARGUMENTS"] as const;
type Category = (typeof CATEGORIES)[number];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalizeCategory(raw: string): Category | null {
  const c = raw.toUpperCase().replace(/S$/, ""); // tolerate singular/plural
  switch (c) {
    case "WORK":
      return "WORKS";
    case "QUOTE":
      return "QUOTES";
    case "POSITION":
      return "POSITIONS";
    case "ARGUMENT":
      return "ARGUMENTS";
    default:
      return null;
  }
}

interface ParsedName {
  author: string;
  category: Category;
  lot: number | null;
}

// Strict: AUTHOR_CATEGORY or AUTHOR_CATEGORY_N (N numeric). Author may contain
// hyphens (james-allen) but no underscores. Anything else is rejected.
function parseFilename(filename: string): ParsedName | null {
  const base = filename.replace(/\.txt$/i, "");
  const m = base.match(/^([a-z0-9][a-z0-9-]*)_([a-z]+)(?:_(\d+))?$/i);
  if (!m) return null;

  const author = m[1].toLowerCase();
  const category = normalizeCategory(m[2]);
  if (!category) return null;

  const lot = m[3] !== undefined ? parseInt(m[3], 10) : null;
  return { author, category, lot };
}

function titleCase(s: string): string {
  return s
    .split(/[-\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function embed(text: string): Promise<number[]> {
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: text.slice(0, 8000),
      });
      return response.data[0].embedding;
    } catch (e: any) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + CHUNK_SIZE;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + CHUNK_SIZE * 0.5) end = breakPoint + 1;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 100) chunks.push(chunk);
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------

interface ParsedQuote {
  text: string;
  topic: string | null;
}

// Pipe format: `author | quote | topic`. Falls back to whole-line quote.
function parseQuotes(content: string): ParsedQuote[] {
  const out: ParsedQuote[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes("|")) {
      const cols = line.split("|").map((c) => c.trim());
      // author | quote | topic  (author column ignored; filename is canonical)
      const quote = cols.length >= 3 ? cols[1] : cols[cols.length - 1];
      const topic = cols.length >= 3 ? cols[2] : null;
      if (quote && quote.length > 1) out.push({ text: quote, topic: topic || null });
    } else if (line.length > 1) {
      out.push({ text: line, topic: null });
    }
  }
  return out;
}

interface ParsedPosition {
  text: string;
  topic: string | null;
}

// Supports both `author | position | topic` pipe lines AND markdown with
// `#`/`**bold**` topic headers followed by numbered or bulleted position items.
// Mode detection avoids capturing intro/commentary prose: if the file has pipe
// lines or list items, only those are treated as positions.
function parsePositions(content: string): ParsedPosition[] {
  const out: ParsedPosition[] = [];
  let currentTopic: string | null = null;

  const cleanTopic = (s: string) =>
    s
      .replace(/[#*`>]/g, "")
      .replace(/^\s*\d+[.)]\s*/, "")
      .trim();

  const lines = content.split("\n").map((l) => l.trim());
  const isListItem = (l: string) => /^(?:\d+[.)]|[-*•])\s+(.+)$/.test(l);
  const hasPipe = lines.some((l) => l.includes("|"));
  const hasList = lines.some((l) => isListItem(l));

  for (const line of lines) {
    if (!line) continue;

    // PIPE MODE: only pipe lines count
    if (hasPipe) {
      if (!line.includes("|")) continue;
      const cols = line.split("|").map((c) => c.trim());
      const text = cols.length >= 3 ? cols[1] : cols[cols.length - 1];
      const topic = cols.length >= 3 ? cols[2] : null;
      if (text && text.length > 5) out.push({ text, topic: topic || null });
      continue;
    }

    // markdown header => set topic
    if (line.startsWith("#")) {
      const t = cleanTopic(line);
      if (t) currentTopic = t;
      continue;
    }
    // a line that is ENTIRELY bold (e.g. **Topic**) => topic
    const boldOnly = line.match(/^\*\*(.+?)\*\*:?$/);
    if (boldOnly) {
      const t = cleanTopic(boldOnly[1]);
      if (t) currentTopic = t;
      continue;
    }
    // separators
    if (/^[-=_*]{3,}$/.test(line)) continue;
    // ALL-CAPS short line => topic header
    if (line.length > 3 && line.length < 80 && line === line.toUpperCase() && !/^\d/.test(line)) {
      currentTopic = cleanTopic(line);
      continue;
    }

    if (hasList) {
      // LIST MODE: only numbered/bulleted items are positions (skip prose)
      const item = line.match(/^(?:\d+[.)]|[-*•])\s+(.+)$/);
      if (item) {
        const text = item[1].replace(/[*`]/g, "").trim();
        if (text.length > 5) out.push({ text, topic: currentTopic });
      }
      continue;
    }

    // PLAIN MODE: no pipes, no lists => each substantial line is a position
    if (line.length > 20) out.push({ text: line.replace(/[*`]/g, "").trim(), topic: currentTopic });
  }
  return out;
}

interface ParsedArgument {
  argumentType: string;
  premises: string[];
  conclusion: string;
  topic: string | null;
  importance: number;
}

// Markdown blocks:
//   ## Topic
//   ### Argument N (type)
//   **Premises:**
//   - p1
//   **-> Conclusion:** c
//   *Source: Topic | Importance: 9/10*
function parseArguments(content: string): ParsedArgument[] {
  const out: ParsedArgument[] = [];
  const lines = content.split("\n");

  let sectionTopic: string | null = null;
  let cur: ParsedArgument | null = null;
  let inPremises = false;

  const push = () => {
    if (cur && (cur.conclusion || cur.premises.length)) out.push(cur);
    cur = null;
    inPremises = false;
  };

  for (const raw of lines) {
    const line = raw.trim();

    // section topic ( ## Heading ) but NOT an argument header ( ### )
    const sec = line.match(/^##\s+(?!#)(.+)$/);
    if (sec) {
      sectionTopic = sec[1].replace(/[*`]/g, "").trim();
      continue;
    }

    const argHeader = line.match(/^###\s+Argument\b.*?(?:\(([^)]+)\))?\s*$/i);
    if (argHeader) {
      push();
      cur = {
        argumentType: (argHeader[1] || "deductive").toLowerCase().trim(),
        premises: [],
        conclusion: "",
        topic: sectionTopic,
        importance: 5,
      };
      continue;
    }
    if (!cur) continue;

    if (/^\*\*premises:?\*\*/i.test(line)) {
      inPremises = true;
      continue;
    }

    const concl = line.match(/^\*\*(?:→|->)?\s*conclusion:?\*\*\s*(.*)$/i);
    if (concl) {
      inPremises = false;
      cur.conclusion = concl[1].replace(/[*`]/g, "").trim();
      continue;
    }

    if (/source:/i.test(line)) {
      const t = line.match(/source:\s*([^|*]+)/i);
      if (t && t[1].trim()) cur.topic = t[1].replace(/[`]/g, "").trim();
      const imp = line.match(/importance:\s*(\d+)/i);
      if (imp) cur.importance = Math.max(1, Math.min(10, parseInt(imp[1], 10)));
      continue;
    }

    if (inPremises) {
      const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
      if (bullet) {
        const p = bullet[1].replace(/[*`]/g, "").trim();
        if (p) cur.premises.push(p);
      }
    }
  }
  push();
  return out;
}

// ---------------------------------------------------------------------------
// ingesters
// ---------------------------------------------------------------------------

interface IngestResult {
  parsed: number; // rows the parser produced
  inserted: number; // rows actually written
  errors: number; // rows that failed to write
  note?: string;
}

async function ingestWorks(name: ParsedName, content: string, sourceFile: string): Promise<IngestResult> {
  const title = `${titleCase(name.author)} Works${name.lot ? ` (Vol ${name.lot})` : ""}`;
  const chunks = chunkText(content);
  if (DRY_RUN) {
    return { parsed: chunks.length, inserted: chunks.length, errors: 0, note: `${chunks.length} chunks would be embedded` };
  }

  const rows = await sql`
    INSERT INTO texts (id, thinker, title, source_file, content)
    VALUES (gen_random_uuid(), ${name.author}, ${title}, ${sourceFile}, ${content})
    RETURNING id
  `;
  const textId = rows[0].id as string;

  let inserted = 0;
  let errors = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const vec = await embed(chunks[i]);
      await sql`
        INSERT INTO chunks (id, thinker, source_text_id, chunk_index, chunk_text, embedding)
        VALUES (gen_random_uuid(), ${name.author}, ${textId}, ${i}, ${chunks[i]}, ${JSON.stringify(vec)}::vector)
      `;
      inserted++;
      if (inserted % 25 === 0) process.stdout.write(`    ...${inserted}/${chunks.length} chunks\n`);
      await new Promise((r) => setTimeout(r, 60));
    } catch (e: any) {
      errors++;
      console.error(`    chunk ${i} failed: ${e.message}`);
    }
  }

  // If nothing embedded, remove the dangling text row so reruns start clean.
  if (inserted === 0) {
    await sql`DELETE FROM texts WHERE id = ${textId}`;
    return { parsed: chunks.length, inserted: 0, errors, note: `embedding failed; rolled back text row` };
  }
  return { parsed: chunks.length, inserted, errors, note: `${inserted} chunks embedded (text id ${textId})` };
}

async function ingestRows<T>(
  parsed: T[],
  insertOne: (row: T) => Promise<void>,
  label: string,
  delayMs = 40,
): Promise<IngestResult> {
  if (DRY_RUN) return { parsed: parsed.length, inserted: parsed.length, errors: 0 };
  let inserted = 0;
  let errors = 0;
  for (const row of parsed) {
    try {
      await insertOne(row);
      inserted++;
      if (inserted % 50 === 0) process.stdout.write(`    ...${inserted}/${parsed.length} ${label}\n`);
      await new Promise((r) => setTimeout(r, delayMs));
    } catch (e: any) {
      errors++;
      console.error(`    ${label} row failed: ${e.message}`);
    }
  }
  return { parsed: parsed.length, inserted, errors };
}

async function ingestQuotes(name: ParsedName, content: string): Promise<IngestResult> {
  const parsed = parseQuotes(content);
  return ingestRows(parsed, async (q) => {
    const vec = await embed(q.text);
    await sql`
      INSERT INTO quotes (id, thinker, quote_text, topic, embedding)
      VALUES (gen_random_uuid(), ${name.author}, ${q.text}, ${q.topic}, ${JSON.stringify(vec)}::vector)
    `;
  }, "quotes");
}

async function ingestPositions(name: ParsedName, content: string): Promise<IngestResult> {
  const parsed = parsePositions(content);
  return ingestRows(parsed, async (p) => {
    const vec = await embed(p.text);
    await sql`
      INSERT INTO positions (id, thinker, topic, position_text, embedding)
      VALUES (gen_random_uuid(), ${name.author}, ${p.topic}, ${p.text}, ${JSON.stringify(vec)}::vector)
    `;
  }, "positions");
}

async function ingestArguments(name: ParsedName, content: string): Promise<IngestResult> {
  const parsed = parseArguments(content).filter((a) => a.conclusion || a.premises.length);
  return ingestRows(parsed, async (a) => {
    const vec = await embed([...a.premises, a.conclusion].join(" "));
    await sql`
      INSERT INTO arguments (id, thinker, argument_type, premises, conclusion, topic, importance, embedding)
      VALUES (
        gen_random_uuid(), ${name.author}, ${a.argumentType},
        ${JSON.stringify(a.premises)}::jsonb, ${a.conclusion}, ${a.topic}, ${a.importance},
        ${JSON.stringify(vec)}::vector
      )
    `;
  }, "arguments");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  for (const d of [DROP_DIR, PROCESSED_DIR, FAILED_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  const files = fs
    .readdirSync(DROP_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".txt"))
    .map((e) => e.name);

  console.log(`\n=== DROP-FOLDER INGEST ${DRY_RUN ? "(DRY RUN)" : ""} ===`);
  console.log(`Folder: ${DROP_DIR}`);
  console.log(`Found ${files.length} .txt file(s)\n`);

  if (files.length === 0) {
    console.log("Nothing to ingest. Drop files named AUTHOR_CATEGORY[_N].txt and re-run.");
    return;
  }

  for (const file of files) {
    const parsed = parseFilename(file);
    if (!parsed) {
      console.log(`SKIP  ${file}`);
      console.log(`      Bad name. Use AUTHOR_CATEGORY[_N].txt with CATEGORY in ${CATEGORIES.join("|")}.`);
      if (!DRY_RUN) fs.renameSync(path.join(DROP_DIR, file), path.join(FAILED_DIR, file));
      continue;
    }

    const { author, category, lot } = parsed;
    const sourceFile = file.replace(/\.txt$/i, "").toLowerCase();
    const content = fs.readFileSync(path.join(DROP_DIR, file), "utf-8");
    console.log(`FILE  ${file}  ->  ${author} / ${category}${lot ? ` (lot ${lot})` : ""}`);

    const move = (dir: string) => {
      if (!DRY_RUN) fs.renameSync(path.join(DROP_DIR, file), path.join(dir, file));
    };

    // empty file => failure
    if (content.trim().length === 0) {
      console.error(`  FAIL  empty file`);
      move(FAILED_DIR);
      continue;
    }

    try {
      let result: IngestResult;
      switch (category) {
        case "WORKS":
          result = await ingestWorks(parsed, content, sourceFile);
          break;
        case "QUOTES":
          result = await ingestQuotes(parsed, content);
          break;
        case "POSITIONS":
          result = await ingestPositions(parsed, content);
          break;
        case "ARGUMENTS":
          result = await ingestArguments(parsed, content);
          break;
      }

      // parse failure: file had content but produced nothing usable
      if (result.parsed === 0) {
        console.error(`  FAIL  nothing parseable — check the file format (see drop/README.md)`);
        move(FAILED_DIR);
        continue;
      }
      // total write failure
      if (!DRY_RUN && result.inserted === 0) {
        console.error(`  FAIL  parsed ${result.parsed} but inserted 0 (${result.errors} errors)${result.note ? ` — ${result.note}` : ""}`);
        move(FAILED_DIR);
        continue;
      }
      // partial: keep processed but flag loudly so the user can review
      if (result.errors > 0) {
        console.warn(`  WARN  ${result.inserted}/${result.parsed} inserted, ${result.errors} FAILED. File kept in _processed; re-running would duplicate, so fix failures manually.`);
        move(PROCESSED_DIR);
        continue;
      }

      console.log(`  OK  ${result.inserted}/${result.parsed} row(s)${result.note ? ` — ${result.note}` : ""}`);
      move(PROCESSED_DIR);
    } catch (e: any) {
      console.error(`  FAIL ${file}: ${e.message}`);
      move(FAILED_DIR);
    }
  }

  console.log(`\n=== DONE ===`);
  if (!DRY_RUN) console.log(`Successful files -> drop/_processed/ ; failures -> drop/_failed/ (fix and re-drop).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
