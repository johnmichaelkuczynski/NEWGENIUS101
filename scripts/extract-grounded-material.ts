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

async function extractQuotesOnly(
  title: string,
  window: string,
  index: number,
  total: number,
): Promise<QuoteCandidate[]> {
  const prompt = `Extract 5-10 representative quotations from John-Michael Kuczynski's work "${title}", section ${index + 1} of ${total}.

Each quotation must be:
- a contiguous VERBATIM substring copied exactly from SOURCE;
- a complete, philosophically substantive statement;
- understandable without a broken beginning or ending;
- between 45 and 1,800 characters.

Reject headings, fragments, citations by themselves, filler, and transitional prose.
Return strict JSON only: {"quotes":[{"text":"exact source substring","topic":"concise topic"}]}

SOURCE:
${window}`;

  const response = await openai.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Copy quotations exactly from the supplied source. Never paraphrase, repair, normalize, or fabricate quotation text.",
      },
      { role: "user", content: prompt },
    ],
  });
  const parsed = JSON.parse(response.choices[0]?.message?.content || "{}") as Extraction;
  return Array.isArray(parsed.quotes) ? parsed.quotes : [];
}

async function reviewQuoteQuality(
  title: string,
  candidates: QuoteCandidate[],
): Promise<{ accepted: QuoteCandidate[]; rejected: number }> {
  const accepted: QuoteCandidate[] = [];
  let rejected = 0;

  for (let start = 0; start < candidates.length; start += 12) {
    const batch = candidates.slice(start, start + 12);
    const numbered = batch
      .map((candidate, index) => `${index}\t${JSON.stringify(candidate.text)}`)
      .join("\n\n");
    const response = await openai.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are the final quotation editor for a serious philosopher's published corpus.
Be severe. Verbatim accuracy has already been checked; your task is editorial quality.
Accept a quotation only when ALL are true:
1. It begins and ends cleanly and is not a sentence fragment, excerpt boundary, heading, list scrap, or dangling continuation.
2. It is self-contained enough to understand without omitted surrounding prose.
3. It states a philosophically substantive thesis, distinction, argument, explanation, objection, or conclusion.
4. It is memorable, incisive, and strong enough to represent the author in a quotation generator.
5. It is not merely setup, transition, summary scaffolding, an isolated example, or a commonplace observation.
When uncertain, reject it. Do not reward quantity.`,
        },
        {
          role: "user",
          content: `Work: ${title}

Judge each numbered candidate. Return strict JSON:
{"decisions":[{"index":0,"accept":true,"complete":true,"substantive":true,"memorable":true,"reason":"brief reason"}]}

CANDIDATES:
${numbered}`,
        },
      ],
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}") as {
      decisions?: Array<{
        index: number;
        accept: boolean;
        complete: boolean;
        substantive: boolean;
        memorable: boolean;
      }>;
    };
    const decisions = new Map(
      (parsed.decisions || []).map((decision) => [Number(decision.index), decision]),
    );
    for (let index = 0; index < batch.length; index++) {
      const decision = decisions.get(index);
      const text = batch[index].text.trim();
      const cleanBoundary =
        text.length >= 80
        && /^[A-Z0-9“"'([]/.test(text)
        && /[.!?…”"')\]]$/.test(text);
      if (
        cleanBoundary
        && decision?.accept === true
        && decision.complete === true
        && decision.substantive === true
        && decision.memorable === true
      ) {
        accepted.push(batch[index]);
      } else {
        rejected++;
      }
    }
  }

  return { accepted, rejected };
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
  const existingSourceQuoteCount = Number(
    (await sql`SELECT COUNT(*)::int AS count FROM quotes WHERE source_text_id = ${source.id}`)[0]?.count || 0,
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

  if (existingSourceQuoteCount + quotes.length < 5) {
    console.log("  fewer than 5 source quotations; running quote-only recovery");
    for (let start = 0; start < windows.length; start += 3) {
      const batch = windows.slice(start, start + 3);
      const recoveredBatches = await Promise.all(
        batch.map((window, offset) =>
          extractQuotesOnly(source.title, window, start + offset, windows.length)
        ),
      );
      for (let offset = 0; offset < recoveredBatches.length; offset++) {
        const window = batch[offset];
        for (const candidate of recoveredBatches[offset]) {
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
      }
    }
  }

  const qualityReview = await reviewQuoteQuality(source.title, quotes);
  rejectedEvidence += qualityReview.rejected;
  const acceptedQuotes = [...qualityReview.accepted];

  if (existingSourceQuoteCount + acceptedQuotes.length < 5) {
    console.log("  fewer than 5 quotations survived quality review; running strict quote-only recovery");
    const recoveryCandidates: QuoteCandidate[] = [];
    for (let start = 0; start < windows.length; start += 3) {
      const batch = windows.slice(start, start + 3);
      const recoveredBatches = await Promise.all(
        batch.map((window, offset) =>
          extractQuotesOnly(source.title, window, start + offset, windows.length)
        ),
      );
      for (let offset = 0; offset < recoveredBatches.length; offset++) {
        const window = batch[offset];
        for (const candidate of recoveredBatches[offset]) {
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
          recoveryCandidates.push({
            text: verbatim,
            topic: candidate.topic || source.title,
          });
        }
      }
    }
    const recoveryReview = await reviewQuoteQuality(source.title, recoveryCandidates);
    rejectedEvidence += recoveryReview.rejected;
    acceptedQuotes.push(...recoveryReview.accepted);
  }

  if (existingSourceQuoteCount + acceptedQuotes.length < 5) {
    throw new Error(
      `Only ${existingSourceQuoteCount + acceptedQuotes.length} quotations passed strict quality review; refusing to pad the quote generator`,
    );
  }

  const quoteVectors = await embeddings(acceptedQuotes.map((item) => item.text));
  for (let i = 0; i < acceptedQuotes.length; i++) {
    await sql`
      INSERT INTO quotes (id, thinker, quote_text, topic, source_text_id, embedding)
      VALUES (
        gen_random_uuid(), ${source.thinker}, ${acceptedQuotes[i].text}, ${acceptedQuotes[i].topic},
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
    `  INSERTED ${acceptedQuotes.length} quotes, ${positions.length} positions, `
      + `${argumentsFound.length} arguments; rejected ${rejectedEvidence} unsupported candidates`,
  );
  return {
    sourceId: source.id,
    title: source.title,
    quotes: acceptedQuotes.length,
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