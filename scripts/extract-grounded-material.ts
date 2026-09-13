import { neon } from "@neondatabase/serverless";
import OpenAI from "openai";

const databaseUrl = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("EXTERNAL_DATABASE_URL or DATABASE_URL is required");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

const sql = neon(databaseUrl);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sourceIds = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const model = process.env.EXTRACTION_MODEL || "gpt-4o";
const WINDOW_SIZE = 14_000;

type QuoteCandidate = { text: string; topic: string };
type PositionCandidate = { position: string; topic: string; evidence: string };
type ArgumentCandidate = {
  premises: string[];
  conclusion: string;
  topic: string;
  importance: number;
  evidence: string;
};

type Extraction = {
  quotes?: QuoteCandidate[];
  positions?: PositionCandidate[];
  arguments?: ArgumentCandidate[];
};

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function recoverVerbatim(source: string, candidate: string): string | null {
  if (!candidate?.trim()) return null;
  const exactIndex = source.indexOf(candidate);
  if (exactIndex >= 0) return source.slice(exactIndex, exactIndex + candidate.length).trim();

  let collapsed = "";
  const sourceIndex: number[] = [];
  let precedingWhitespace = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (/\s/.test(char)) {
      if (!precedingWhitespace && collapsed.length > 0) {
        collapsed += " ";
        sourceIndex.push(i);
      }
      precedingWhitespace = true;
    } else {
      collapsed += char;
      sourceIndex.push(i);
      precedingWhitespace = false;
    }
  }
  const needle = candidate.replace(/\s+/g, " ").trim();
  const offset = collapsed.indexOf(needle);
  if (offset < 0) return null;
  const start = sourceIndex[offset];
  const end = sourceIndex[offset + needle.length - 1] + 1;
  return source.slice(start, end).trim();
}

function splitIntoWindows(content: string): string[] {
  const paragraphs = content.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const windows: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > WINDOW_SIZE) {
      windows.push(current);
      current = "";
    }
    if (paragraph.length > WINDOW_SIZE) {
      if (current) {
        windows.push(current);
        current = "";
      }
      for (let start = 0; start < paragraph.length; start += WINDOW_SIZE) {
        windows.push(paragraph.slice(start, start + WINDOW_SIZE));
      }
    } else {
      current += `${current ? "\n\n" : ""}${paragraph}`;
    }
  }
  if (current) windows.push(current);
  return windows;
}

async function extractWindow(
  title: string,
  window: string,
  index: number,
  total: number,
): Promise<Extraction> {
  const prompt = `You are extracting source-grounded philosophical material from John-Michael Kuczynski's work "${title}", section ${index + 1} of ${total}.

Return strict JSON with arrays named quotes, positions, and arguments.

QUOTES:
- Select 5-10 representative, memorable, philosophically substantive passages.
- Each quote must be a contiguous VERBATIM substring copied from SOURCE.
- Prefer complete statements of a thesis, distinction, explanation, objection, or conclusion.
- Reject headings, table-of-contents text, citations by themselves, generic filler, fragments, and merely transitional prose.
- Preserve the author's exact wording and punctuation.
- Add a concise topic.

POSITIONS:
- Extract 3-6 positions the author actually commits to in this SOURCE section.
- State each position clearly and faithfully without strengthening it.
- Include one contiguous verbatim evidence passage copied from SOURCE.
- Add a concise topic.

ARGUMENTS:
- Extract 2-4 genuine arguments stated or clearly developed in this SOURCE section.
- Give 2-6 faithful premises and one conclusion.
- Do not invent missing premises that materially change the argument.
- Include one contiguous verbatim evidence passage copied from SOURCE that supports the reconstruction.
- Add a concise topic and importance from 1 to 10.

If the section lacks enough high-quality material, return fewer items. Quality and fidelity outrank quantity.

JSON shape:
{"quotes":[{"text":"...","topic":"..."}],"positions":[{"position":"...","topic":"...","evidence":"..."}],"arguments":[{"premises":["..."],"conclusion":"...","topic":"...","importance":8,"evidence":"..."}]}

SOURCE:
${window}`;

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Extract only what the supplied primary source supports. Never use outside knowledge, paraphrase a quotation, or fabricate evidence.",
          },
          { role: "user", content: prompt },
        ],
      });
      return JSON.parse(response.choices[0]?.message?.content || "{}") as Extraction;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function embeddings(inputs: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < inputs.length; start += 100) {
    const batch = inputs.slice(start, start + 100);
    const response = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: batch.map((item) => item.slice(0, 8000)),
    });
    vectors.push(...response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding));
  }
  return vectors;
}

async function processSource(sourceId: string) {
  const rows = await sql`
    SELECT id, thinker, title, source_file, content
    FROM texts
    WHERE id = ${sourceId}
    LIMIT 1
  `;
  if (!rows.length) throw new Error(`Source text not found: ${sourceId}`);
  const source = rows[0] as {
    id: string;
    thinker: string;
    title: string;
    source_file: string;
    content: string;
  };
  const windows = splitIntoWindows(source.content);
  console.log(`\nSOURCE ${source.title} (${source.id}) — ${windows.length} sections`);

  const extractions: Extraction[] = [];
  for (let start = 0; start < windows.length; start += 3) {
    const batch = windows.slice(start, start + 3);
    const results = await Promise.all(
      batch.map((window, offset) => extractWindow(source.title, window, start + offset, windows.length)),
    );
    extractions.push(...results);
    console.log(`  analyzed ${Math.min(start + 3, windows.length)}/${windows.length} sections`);
  }

  const existingQuotes = new Set(
    (await sql`SELECT quote_text FROM quotes WHERE LOWER(thinker::text) = LOWER(${source.thinker})`)
      .map((row: any) => normalized(String(row.quote_text || ""))),
  );
  const existingPositions = new Set(
    (await sql`SELECT position_text FROM positions WHERE LOWER(thinker::text) = LOWER(${source.thinker})`)
      .map((row: any) => normalized(String(row.position_text || ""))),
  );
  const existingArguments = new Set(
    (await sql`SELECT conclusion FROM arguments WHERE LOWER(thinker::text) = LOWER(${source.thinker})`)
      .map((row: any) => normalized(String(row.conclusion || ""))),
  );

  const quotes: QuoteCandidate[] = [];
  const positions: PositionCandidate[] = [];
  const argumentsFound: ArgumentCandidate[] = [];
  let rejectedEvidence = 0;

  for (let i = 0; i < extractions.length; i++) {
    const extraction = extractions[i];
    const window = windows[i];
    for (const candidate of extraction.quotes || []) {
      const windowVerbatim = recoverVerbatim(window, candidate.text);
      const verbatim = windowVerbatim
        ? recoverVerbatim(source.content, windowVerbatim)
        : null;
      if (!verbatim || verbatim.length < 45 || verbatim.length > 1800) {
        rejectedEvidence++;
        continue;
      }
      const key = normalized(verbatim);
      if (existingQuotes.has(key)) continue;
      existingQuotes.add(key);
      quotes.push({ text: verbatim, topic: candidate.topic || source.title });
    }
    for (const candidate of extraction.positions || []) {
      const evidence = recoverVerbatim(window, candidate.evidence);
      const position = String(candidate.position || "").trim();
      if (!evidence || evidence.length < 35 || position.length < 20) {
        rejectedEvidence++;
        continue;
      }
      const key = normalized(position);
      if (existingPositions.has(key)) continue;
      existingPositions.add(key);
      positions.push({ position, topic: candidate.topic || source.title, evidence });
    }
    for (const candidate of extraction.arguments || []) {
      const evidence = recoverVerbatim(window, candidate.evidence);
      const premises = Array.isArray(candidate.premises)
        ? candidate.premises.map(String).map((item) => item.trim()).filter(Boolean)
        : [];
      const conclusion = String(candidate.conclusion || "").trim();
      if (!evidence || evidence.length < 45 || premises.length < 2 || conclusion.length < 20) {
        rejectedEvidence++;
        continue;
      }
      const key = normalized(conclusion);
      if (existingArguments.has(key)) continue;
      existingArguments.add(key);
      argumentsFound.push({
        premises,
        conclusion,
        topic: candidate.topic || source.title,
        importance: Math.max(1, Math.min(10, Number(candidate.importance) || 5)),
        evidence,
      });
    }
  }

  const quoteVectors = await embeddings(quotes.map((item) => item.text));
  for (let i = 0; i < quotes.length; i++) {
    await sql`
      INSERT INTO quotes (id, thinker, quote_text, topic, source_text_id, embedding)
      VALUES (
        gen_random_uuid(), ${source.thinker}, ${quotes[i].text}, ${quotes[i].topic},
        ${source.id}, ${JSON.stringify(quoteVectors[i])}::vector
      )
    `;
  }

  const positionVectors = await embeddings(positions.map((item) => item.position));
  for (let i = 0; i < positions.length; i++) {
    await sql`
      INSERT INTO positions (id, thinker, position_text, topic, source_text_id, embedding)
      VALUES (
        gen_random_uuid(), ${source.thinker}, ${positions[i].position}, ${positions[i].topic},
        ${source.id}, ${JSON.stringify(positionVectors[i])}::vector
      )
    `;
  }

  const argumentVectors = await embeddings(
    argumentsFound.map((item) => [...item.premises, item.conclusion].join(" ")),
  );
  for (let i = 0; i < argumentsFound.length; i++) {
    const item = argumentsFound[i];
    await sql`
      INSERT INTO arguments (
        id, thinker, argument_type, premises, conclusion, topic,
        source_text_id, importance, embedding
      )
      VALUES (
        gen_random_uuid(), ${source.thinker}, 'reconstructed',
        ${JSON.stringify(item.premises)}::jsonb, ${item.conclusion}, ${item.topic},
        ${source.id}, ${item.importance}, ${JSON.stringify(argumentVectors[i])}::vector
      )
    `;
  }

  console.log(
    `  INSERTED ${quotes.length} quotes, ${positions.length} positions, `
      + `${argumentsFound.length} arguments; rejected ${rejectedEvidence} unsupported candidates`,
  );
  return {
    sourceId: source.id,
    title: source.title,
    quotes: quotes.length,
    positions: positions.length,
    arguments: argumentsFound.length,
    rejectedEvidence,
  };
}

async function main() {
  if (!sourceIds.length) {
    throw new Error("Usage: npx tsx scripts/extract-grounded-material.ts <source-text-id> [...]");
  }
  const results = [];
  for (const sourceId of sourceIds) results.push(await processSource(sourceId));
  console.log(`\nRESULTS\n${JSON.stringify(results, null, 2)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});