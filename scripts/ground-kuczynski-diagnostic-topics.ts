import { neon } from "@neondatabase/serverless";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";

const databaseUrl = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("EXTERNAL_DATABASE_URL or DATABASE_URL is required");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

const sql = neon(databaseUrl);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.EXTRACTION_MODEL || "gpt-4o";
const thinker = "kuczynski";

const missingWorks = [
  {
    file: "author_database/kuczynski/Analytic Philosophy Complete.txt",
    title: "Analytic Philosophy Complete",
    sourceFile: "kuczynski/analytic-philosophy-complete",
  },
  {
    file: "author_database/kuczynski/Intensionality Modality and Rationality.txt",
    title: "Intensionality, Modality and Rationality",
    sourceFile: "kuczynski/intensionality-modality-and-rationality",
  },
  {
    file: "author_database/kuczynski/Sorites.txt",
    title: "Implicit Comparatives and the Sorites",
    sourceFile: "kuczynski/implicit-comparatives-and-the-sorites",
  },
  {
    file: "author_database/kuczynski/CONCEPTUAL ATOMISM AND THE COMPUTATIONAL THEORY OF MIND.txt",
    title: "Conceptual Atomism and the Computational Theory of Mind",
    sourceFile: "kuczynski/conceptual-atomism-and-the-computational-theory-of-mind",
  },
  {
    file: "author_database/kuczynski/Mind, Meaning & Scientific Explanation.txt",
    title: "Mind, Meaning and Scientific Explanation",
    sourceFile: "kuczynski/mind-meaning-and-scientific-explanation",
  },
  {
    file: "author_database/kuczynski/AI and Philosophy-1.txt",
    title: "AI and Philosophy",
    sourceFile: "kuczynski/ai-and-philosophy",
  },
] as const;

const topics = [
  { question: "What is the difference between semantics and presemantics?", sourceTitle: "Intensionality, Modality and Rationality" },
  { question: "Does Frege's puzzle require a theory of sense?", sourceTitle: "Intensionality, Modality and Rationality" },
  { question: "Are propositional attitudes relations to sentences?", sourceTitle: "Analytic Philosophy Complete" },
  { question: "Is skepticism refutable?", sourceTitle: "Analytic Philosophy Complete" },
  { question: "What is the relation between knowledge by description and knowledge by acquaintance?", sourceTitle: "Conceptual Atomism and the Computational Theory of Mind" },
  { question: "Must a justified believer be able to state his reasons?", sourceTitle: "Mind, Meaning and Scientific Explanation" },
  { question: "Are there natural kinds?", sourceTitle: "Empiricism and the Foundations of Psychology" },
  { question: "Is defeasible inference a species of deduction?", sourceTitle: "AI and Philosophy" },
  { question: "Are numbers objects?", sourceTitle: "Analytic Philosophy Complete" },
  { question: "Is self-deception a refusal to spell out?", sourceTitle: "Chapter 27   How Is Rationalization Possible" },
  { question: "Is supervaluationism a solution to anything?", sourceTitle: "Analytic Philosophy Complete" },
  { question: "Is wealth a continuous scale?", sourceTitle: "Analytic Philosophy Complete" },
] as const;

const explicitGroundings = [
  {
    question: "Is supervaluationism a solution to anything?",
    sourceFile: "kuczynski/implicit-comparatives-and-the-sorites",
    position:
      "Supervaluationism is not a solution to the Sorites paradox: approaches that abandon bivalence go astray at the beginning, because predicates such as “wealthy” are implicit comparatives and classical logic can be preserved.",
    premises: [
      "Solutions to the Sorites paradox that abandon bivalence go astray at the beginning.",
      "Predicates such as “wealthy” are implicit comparatives rather than vague monadic predicates.",
      "The paradox can be resolved while preserving classical logic.",
    ],
    conclusion:
      "Supervaluationism is not a solution to the Sorites paradox, because its departure from bivalence addresses the wrong analysis of the predicate.",
  },
] as const;

function normalize(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\s+/g, " ").trim();
}

function recoverVerbatim(source: string, candidate: string): string | null {
  const exact = source.indexOf(candidate);
  if (exact >= 0) return source.slice(exact, exact + candidate.length).trim();
  const collapsed = normalize(source);
  const needle = normalize(candidate);
  const offset = collapsed.indexOf(needle);
  if (offset < 0) return null;

  let normalizedSource = "";
  const sourceIndexes: number[] = [];
  let inWhitespace = false;
  for (let index = 0; index < source.length; index++) {
    if (/\s/.test(source[index])) {
      if (!inWhitespace && normalizedSource.length > 0) {
        normalizedSource += " ";
        sourceIndexes.push(index);
      }
      inWhitespace = true;
    } else {
      normalizedSource += source[index];
      sourceIndexes.push(index);
      inWhitespace = false;
    }
  }
  const start = sourceIndexes[offset];
  const end = sourceIndexes[offset + needle.length - 1] + 1;
  return source.slice(start, end).trim();
}

function chunkText(content: string): string[] {
  const chunks: string[] = [];
  const size = 1500;
  const overlap = 200;
  for (let start = 0; start < content.length;) {
    let end = Math.min(content.length, start + size);
    if (end < content.length) {
      const boundary = Math.max(content.lastIndexOf(".", end), content.lastIndexOf("\n", end));
      if (boundary > start + size / 2) end = boundary + 1;
    }
    const chunk = content.slice(start, end).trim();
    if (chunk.length > 100) chunks.push(chunk);
    if (end >= content.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

async function embeddings(inputs: string[]): Promise<number[][]> {
  const result: number[][] = [];
  for (let start = 0; start < inputs.length; start += 100) {
    const batch = inputs.slice(start, start + 100);
    const response = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: batch.map((item) => item.slice(0, 8000)),
    });
    result.push(...response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding));
  }
  return result;
}

async function ensureWork(work: typeof missingWorks[number]) {
  const content = fs.readFileSync(path.resolve(work.file), "utf8");
  const compact = content.replace(/^\uFEFF/, "").replace(/\s+/g, "");
  const existing = await sql`
    SELECT id::text
    FROM texts
    WHERE source_file = ${work.sourceFile}
       OR regexp_replace(replace(content, chr(65279), ''), '[[:space:]]+', '', 'g') = ${compact}
    LIMIT 1
  `;
  let sourceId = String(existing[0]?.id || "");
  if (!sourceId) {
    const inserted = await sql`
      INSERT INTO texts (id, thinker, title, source_file, content)
      VALUES (gen_random_uuid(), ${thinker}, ${work.title}, ${work.sourceFile}, ${content})
      RETURNING id::text
    `;
    sourceId = String(inserted[0].id);
  } else {
    await sql`UPDATE texts SET title = ${work.title} WHERE id = ${sourceId}`;
  }

  const chunks = chunkText(content);
  const present = new Set(
    (await sql`SELECT chunk_index FROM chunks WHERE source_text_id = ${sourceId}`)
      .map((row: any) => Number(row.chunk_index)),
  );
  const missing = chunks.map((text, index) => ({ text, index })).filter((item) => !present.has(item.index));
  const vectors = await embeddings(missing.map((item) => item.text));
  for (let start = 0; start < missing.length; start += 40) {
    await Promise.all(missing.slice(start, start + 40).map((item, offset) => sql`
      INSERT INTO chunks (id, thinker, source_text_id, chunk_index, chunk_text, embedding)
      VALUES (
        gen_random_uuid(), ${thinker}, ${sourceId}, ${item.index}, ${item.text},
        ${JSON.stringify(vectors[start + offset])}::vector
      )
      ON CONFLICT (source_text_id, chunk_index) DO NOTHING
    `));
  }
  console.log(`${work.title}: ${chunks.length} chunks (${missing.length} added)`);
}

async function ensureExplicitGroundings() {
  for (const grounding of explicitGroundings) {
    const sources = await sql`
      SELECT id::text
      FROM texts
      WHERE source_file = ${grounding.sourceFile}
      LIMIT 1
    `;
    if (!sources.length) throw new Error(`Missing grounding source: ${grounding.sourceFile}`);
    const sourceId = String(sources[0].id);
    const [positionVector, argumentVector] = await embeddings([
      grounding.position,
      [...grounding.premises, grounding.conclusion].join(" "),
    ]);
    await sql`
      INSERT INTO positions (id, thinker, position_text, topic, source_text_id, embedding)
      SELECT gen_random_uuid(), ${thinker}, ${grounding.position}, ${grounding.question}, ${sourceId},
        ${JSON.stringify(positionVector)}::vector
      WHERE NOT EXISTS (
        SELECT 1 FROM positions
        WHERE source_text_id = ${sourceId} AND topic = ${grounding.question}
      )
    `;
    await sql`
      INSERT INTO arguments (id, thinker, argument_type, premises, conclusion, topic, source_text_id, importance, embedding)
      SELECT gen_random_uuid(), ${thinker}, 'reconstructed', ${JSON.stringify(grounding.premises)}::jsonb,
        ${grounding.conclusion}, ${grounding.question}, ${sourceId}, 10,
        ${JSON.stringify(argumentVector)}::vector
      WHERE NOT EXISTS (
        SELECT 1 FROM arguments
        WHERE source_text_id = ${sourceId} AND topic = ${grounding.question}
      )
    `;
  }
}

async function sourceForTitle(title: string) {
  const rows = await sql`
    SELECT id::text, title, content
    FROM texts
    WHERE LOWER(thinker::text) = ${thinker}
      AND title = ${title}
    ORDER BY (SELECT COUNT(*) FROM chunks c WHERE c.source_text_id = texts.id) DESC
    LIMIT 1
  `;
  if (!rows.length) throw new Error(`Missing source work: ${title}`);
  return { id: String(rows[0].id), title: String(rows[0].title), content: String(rows[0].content) };
}

async function extractTopic(question: string, source: Awaited<ReturnType<typeof sourceForTitle>>) {
  const existingSourceQuoteCount = Number(
    (await sql`SELECT COUNT(*)::int AS count FROM quotes WHERE source_text_id = ${source.id}`)[0]?.count || 0,
  );
  const queryVector = (await embeddings([question]))[0];
  const ranked = await sql`
    SELECT chunk_text
    FROM chunks
    WHERE source_text_id = ${source.id} AND embedding IS NOT NULL
    ORDER BY embedding <=> ${JSON.stringify(queryVector)}::vector
    LIMIT 18
  `;
  const supplemental = await sql`
    SELECT chunk_text
    FROM chunks
    WHERE source_text_id = ${source.id} AND embedding IS NOT NULL
    ORDER BY RANDOM()
    LIMIT 20
  `;
  const passages = ranked.map((row: any, index: number) => `[PASSAGE ${index + 1}]\n${row.chunk_text}`).join("\n\n");
  const response = await openai.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Extract only the author's endorsed answer from supplied primary-source passages. Never infer, repair, or import outside knowledge.",
      },
      {
        role: "user",
        content: `QUESTION: ${question}
WORK: ${source.title}

Return JSON with:
- 6-10 verbatim quotations, each a complete, self-contained, philosophically substantive contiguous substring of the supplied work;
- one faithful position;
- one argument with 2-6 premises and a conclusion;
- a verbatim evidence passage supporting the position and argument.

Reject quotations of opponents unless the author explicitly endorses them. If the work does not directly answer the question, return {"supported":false,"quotes":[]}.

Shape:
{"supported":true,"quotes":[{"text":"...","topic":"..."}],"position":"...","premises":["..."],"conclusion":"...","evidence":"..."}

${passages}`,
      },
    ],
  });
  const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
  const extractedCandidates = (Array.isArray(parsed.quotes) ? parsed.quotes : [])
    .map((item: any) => ({
      text: recoverVerbatim(source.content, String(item.text || "").trim()),
      topic: String(item.topic || question),
    }))
    .filter((item: any) => item.text && item.text.length >= 80);
  const passageCandidates = [...ranked, ...supplemental].flatMap((row: any) => {
    const text = String(row.chunk_text || "").trim();
    const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((item) => item.trim()).filter(Boolean) || [];
    const spans: Array<{ text: string; topic: string }> = [];
    for (let start = 0; start < sentences.length; start += 2) {
      let span = "";
      for (let end = start; end < Math.min(sentences.length, start + 3); end++) {
        span = `${span}${span ? " " : ""}${sentences[end]}`;
        const verbatim = recoverVerbatim(source.content, span);
        if (verbatim && verbatim.length >= 100 && verbatim.length <= 1200) {
          if (end === Math.min(sentences.length, start + 3) - 1) {
            spans.push({ text: verbatim, topic: question });
          }
        }
      }
      if (spans.length >= 2) break;
    }
    return spans;
  });
  const unique = new Map<string, { text: string; topic: string }>();
  for (const candidate of [...extractedCandidates, ...passageCandidates]) {
    unique.set(normalize(candidate.text), candidate);
  }
  const candidates = [...unique.values()].slice(0, 60);
  if (candidates.length < 5) throw new Error(`Only ${candidates.length} exact quotation candidates for: ${question}`);

  const accepted: Array<{ text: string; topic: string }> = [];
  for (let start = 0; start < candidates.length; start += 12) {
    const batch = candidates.slice(start, start + 12);
    const review = await openai.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Be severe. Accept only cleanly bounded, standalone, memorable, philosophically substantive quotations that are strong representatives of the work. Reject setup, fragments, opponent views, and mere topic mentions. Return JSON only.",
        },
        {
          role: "user",
          content: `WORK: ${source.title}
Judge editorial quality only. Return JSON:
{"decisions":[{"index":0,"accept":true,"complete":true,"substantive":true,"memorable":true}]}

${batch.map((item: any, index: number) => `${index}: ${JSON.stringify(item.text)}`).join("\n\n")}`,
        },
      ],
    });
    const decisions = new Map(
      (JSON.parse(review.choices[0]?.message?.content || "{}").decisions || [])
        .map((decision: any) => [Number(decision.index), decision]),
    );
    for (let index = 0; index < batch.length; index++) {
      const decision: any = decisions.get(index);
      if (
        decision?.accept === true
        && decision.complete === true
        && decision.substantive === true
        && decision.memorable === true
      ) {
        accepted.push(batch[index]);
      }
    }
  }
  if (existingSourceQuoteCount + accepted.length < 5) {
    throw new Error(
      `Only ${existingSourceQuoteCount + accepted.length} source quotations passed strict review for: ${question}`,
    );
  }

  const existing = new Set(
    (await sql`SELECT quote_text FROM quotes WHERE source_text_id = ${source.id}`)
      .map((row: any) => normalize(String(row.quote_text))),
  );
  const fresh = accepted.filter((item: any) => !existing.has(normalize(item.text)));
  const quoteVectors = await embeddings(fresh.map((item: any) => item.text));
  for (let index = 0; index < fresh.length; index++) {
    await sql`
      INSERT INTO quotes (id, thinker, quote_text, topic, source_text_id, embedding)
      VALUES (
        gen_random_uuid(), ${thinker}, ${fresh[index].text}, ${fresh[index].topic},
        ${source.id}, ${JSON.stringify(quoteVectors[index])}::vector
      )
    `;
  }

  const evidence = recoverVerbatim(source.content, String(parsed.evidence || "").trim());
  const position = String(parsed.position || "").trim();
  const premises = Array.isArray(parsed.premises) ? parsed.premises.map(String).map((item: string) => item.trim()).filter(Boolean) : [];
  const conclusion = String(parsed.conclusion || "").trim();
  if (!evidence || position.length < 20 || premises.length < 2 || conclusion.length < 20) {
    const linked = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM positions WHERE source_text_id = ${source.id}) AS positions,
        (SELECT COUNT(*)::int FROM arguments WHERE source_text_id = ${source.id}) AS arguments
    `;
    if (Number(linked[0]?.positions || 0) > 0 && Number(linked[0]?.arguments || 0) > 0) {
      console.log(`${question}: retained existing validated source-linked positions and arguments`);
      return;
    }
    throw new Error(`Invalid source-linked reconstruction for: ${question}`);
  }
  const [positionVector, argumentVector] = await embeddings([position, [...premises, conclusion].join(" ")]);
  await sql`
    INSERT INTO positions (id, thinker, position_text, topic, source_text_id, embedding)
    SELECT gen_random_uuid(), ${thinker}, ${position}, ${question}, ${source.id}, ${JSON.stringify(positionVector)}::vector
    WHERE NOT EXISTS (
      SELECT 1 FROM positions WHERE source_text_id = ${source.id} AND LOWER(position_text) = LOWER(${position})
    )
  `;
  await sql`
    INSERT INTO arguments (id, thinker, argument_type, premises, conclusion, topic, source_text_id, importance, embedding)
    SELECT gen_random_uuid(), ${thinker}, 'reconstructed', ${JSON.stringify(premises)}::jsonb,
      ${conclusion}, ${question}, ${source.id}, 9, ${JSON.stringify(argumentVector)}::vector
    WHERE NOT EXISTS (
      SELECT 1 FROM arguments WHERE source_text_id = ${source.id} AND LOWER(conclusion) = LOWER(${conclusion})
    )
  `;
  console.log(`${question}: ${accepted.length} approved (${fresh.length} added)`);
}

async function main() {
  for (const work of missingWorks) await ensureWork(work);
  await ensureExplicitGroundings();
  const fromIndex = Math.max(0, Number(process.argv[process.argv.indexOf("--from") + 1] || 1) - 1);
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1]?.toLowerCase() : "";
  const selectedTopics = topics.slice(fromIndex).filter((topic) =>
    !only || topic.question.toLowerCase().includes(only),
  );
  for (const topic of selectedTopics) {
    const source = await sourceForTitle(topic.sourceTitle);
    await extractTopic(topic.question, source);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});