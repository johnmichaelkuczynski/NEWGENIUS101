import { db } from "./db";
import { sql } from "drizzle-orm";
import { normalizeAuthorName } from "./vector-search";
import type { AuditedSearchResult, AuditEventCallback, PassageCandidate } from "./audited-search";

export type GroundingGenerator = (system: string, user: string, maxTokens: number) => Promise<string>;
export interface ComparisonSource {
  id: string;
  thinker: string;
  sourceId: string;
  title: string;
  index: number;
  text: string;
}
export interface ComparisonGrounding {
  audit: AuditedSearchResult;
  binding: string;
  context: string;
  sources: ComparisonSource[];
}
export interface PrimaryRetrievalOptions {
  anchors?: Array<{ sourceFile: string; chunkIndex: number }>;
  argumentHints?: string;
}
export interface UnindexedWork {
  id: string;
  thinker: string;
  title: string;
  content: string;
}
export function selectUnindexedPassages(works: UnindexedWork[], terms: string[], limit = 24): any[] {
  const candidates: Array<{ score: number; row: any }> = [];
  for (const work of works) {
    const lower = work.content.toLowerCase();
    for (let offset = 0; offset < work.content.length; offset += 5000) {
      const body = lower.slice(offset, offset + 6500);
      const score = terms.reduce((sum, term, index) => sum + (body.includes(term) ? (index < 6 ? 3 : 1) : 0), 0);
      if (score) candidates.push({ score, row: {
        id: `text:${work.id}:${offset}`, thinker: work.thinker, source_text_id: work.id,
        chunk_index: offset / 5000, chunk_text: work.content.slice(offset, offset + 6500), title: work.title,
      } });
    }
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, limit).map((candidate) => candidate.row);
}
const stopwords = new Set("the and for are not but with from that this what which would could should have does your their there they them explain evaluate question answer author personally agree view inherently different difference differences give state own about correctly capture mean said says did can has his her how why when".split(" "));
export function comparisonTerms(question: string, expansion = ""): string[] {
  return Array.from(new Set(`${question} ${expansion}`.toLowerCase().match(new RegExp("[\\p{L}\\p{N}]+", "gu")) || []))
    .filter((word) => word.length >= 3 && !stopwords.has(word)).slice(0, 32);
}
export function comparisonAuthorNames(id: string, name: string): string[] {
  return Array.from(new Set([id, id.replace(/[-_]/g, " "), name, normalizeAuthorName(id), normalizeAuthorName(name)]
    .map((value) => value.toLowerCase().trim())));
}
function parseJson(text: string): any {
  return JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim());
}
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();

export function hasStrengthenedDenial(question: string, answer: string): boolean {
  const opening = answer.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  const addedQualifier = ["wholly", "entirely", "completely", "universally", "purely"]
    .some((word) => new RegExp(`\\b${word}\\b`, "i").test(opening)
      && !new RegExp(`\\b${word}\\b`, "i").test(question));
  return addedQualifier && /\b(no|not|never|deny|denies|reject|rejects)\b/i.test(opening);
}

export function validateComparisonBinding(value: unknown, sources: ComparisonSource[]): {
  answer: string; quotes: Array<{ passageId: string; text: string }>; sources: ComparisonSource[];
} {
  const data = value as any;
  if (!data || typeof data.answer !== "string" || !data.answer.trim() || !Array.isArray(data.quotes)) {
    throw new Error("The source-derived answer could not be validated.");
  }
  const validQuotes = data.quotes.filter((quote: any) =>
    typeof quote?.passageId === "string" && typeof quote?.text === "string" &&
    quote.text.trim().length >= 30 &&
    sources.some((source) => source.id === quote.passageId && normalized(source.text).includes(normalized(quote.text))));
  if (!validQuotes.length) throw new Error("No verified primary-source support was selected for this answer.");
  const selectedIds = new Set(validQuotes.map((quote: any) => quote.passageId));
  return { answer: data.answer, quotes: validQuotes, sources: sources.filter((source) => selectedIds.has(source.id)) };
}

/** Exact author-filtered retrieval without a dependency on one embedding/judging provider. */
export async function prepareComparisonGrounding(
  question: string, author: { id: string; name: string }, generate: GroundingGenerator, onEvent: AuditEventCallback,
  options: PrimaryRetrievalOptions = {},
): Promise<ComparisonGrounding> {
  const events: AuditedSearchResult["events"] = [];
  const emit = (detail: string, type: "table_search" | "search_complete" = "table_search") => {
    const event = { timestamp: Date.now(), type, detail };
    events.push(event);
    onEvent(event);
  };
  let expansion = "";
  try {
    expansion = await generate(
      "Produce at most 16 search keywords or short phrases for finding the named author's OWN writings relevant to the question. Translate modern vocabulary to the author's characteristic terminology where useful. Include nearby concepts and alternative spellings, not conclusions or proposed answers. Do not assume the author agrees with modern consensus. Return only the search terms.",
      `AUTHOR: ${author.name}\nQUESTION: ${question}${options.argumentHints ? `\nDERIVED RETRIEVAL HINTS (not primary evidence; use only to locate the original argument):\n${options.argumentHints.slice(0, 8000)}` : ""}`, 300,
    );
  } catch { /* Original lexical retrieval remains available if expansion fails. */ }
  const terms = comparisonTerms(question, expansion);
  if (!terms.length) throw new Error(`State the subject explicitly so ${author.name}'s writings can be searched.`);
  const names = comparisonAuthorNames(author.id, author.name);
  const namesSql = sql.join(names.map((name) => sql`${name}`), sql`, `);
  // Some imported "works" are plainly AI extraction output, not authored text.
  // Keep derived records out even when they were put into the texts table.
  const primaryWork = sql`COALESCE(t.title, '') !~* '(corpus[_ -]?analysis|let me continue reading|comprehensive extraction|extracted positions|extracted arguments)'
    AND LEFT(COALESCE(t.content, ''), 800) !~* '(let me continue reading the full document|now i have thoroughly read|# EXTRACTED POSITIONS|# EXTRACTED ARGUMENTS)'`;
  const authorFilter = sql`LOWER(c.thinker::text) IN (${namesSql}) AND LOWER(t.thinker::text) IN (${namesSql}) AND ${primaryWork}`;
  const matches = terms.map((term) => sql`c.chunk_text ILIKE ${`%${term}%`}`);
  const score = terms.map((term, index) => sql`CASE WHEN c.chunk_text ILIKE ${`%${term}%`} THEN ${index < 6 ? 3 : 1} ELSE 0 END`);
  emit(`Searching ${author.name}'s primary writings using ${terms.join(", ")}`);
  const result = await db.execute(sql`
    SELECT c.id::text, c.thinker, c.source_text_id, c.chunk_index, c.chunk_text,
           COALESCE(t.title, t.source_file, c.source_text_id::text) AS title
    FROM chunks c JOIN texts t ON t.id = c.source_text_id
    WHERE ${authorFilter} AND (${sql.join(matches, sql` OR `)})
    ORDER BY (${sql.join(score, sql` + `)}) DESC, c.source_text_id, c.chunk_index LIMIT 36
  `);
  const anchors = (result.rows || []) as any[];
  // A saved work need not have completed its old embedding/chunking job.
  // Search its actual text rather than treating absent chunks as absent writing.
  const unindexed = await db.execute(sql`
    SELECT t.id::text, t.thinker, t.content, COALESCE(t.title, t.source_file, t.id::text) AS title
    FROM texts t
    WHERE LOWER(t.thinker::text) IN (${namesSql}) AND ${primaryWork}
      AND NOT EXISTS (SELECT 1 FROM chunks indexed WHERE indexed.source_text_id = t.id)
      AND (${sql.join(terms.map((term) => sql`t.content ILIKE ${`%${term}%`}`), sql` OR `)})
    ORDER BY t.id LIMIT 8
  `);
  // Read each large text once. Repeated SQL substrings of compressed multi-MB
  // works cause repeated decompression and can turn one lookup into minutes.
  anchors.push(...selectUnindexedPassages((unindexed.rows || []) as unknown as UnindexedWork[], terms));
  // Recover semantic/compound-term hits too, but re-read them through the exact
  // author + work join. Supplied summaries and unverified text never become evidence.
  if (options.anchors?.length) {
    const seeded = await db.execute(sql`
      SELECT c.id::text, c.thinker, c.source_text_id, c.chunk_index, c.chunk_text,
             COALESCE(t.title, t.source_file, c.source_text_id::text) AS title
      FROM chunks c JOIN texts t ON t.id = c.source_text_id
      WHERE ${authorFilter} AND (${sql.join(options.anchors.slice(0, 40).map((anchor) =>
        sql`(c.source_text_id = ${anchor.sourceFile} AND c.chunk_index = ${anchor.chunkIndex})`), sql` OR `)})
      ORDER BY c.source_text_id, c.chunk_index
    `);
    const known = new Set(anchors.map((row) => row.id));
    for (const row of (seeded.rows || []) as any[]) {
      if (!known.has(row.id)) { anchors.push(row); known.add(row.id); }
    }
  }
  if (!anchors.length) throw new Error(`No relevant source passages were found for ${author.name}; no generic answer has been substituted.`);
  const indexedAnchors = anchors.filter((anchor) => !String(anchor.id).startsWith("text:")).slice(0, 14);
  const neighborhoods = indexedAnchors.length ? await db.execute(sql`
    SELECT DISTINCT c.id::text, c.thinker, c.source_text_id, c.chunk_index, c.chunk_text,
           COALESCE(t.title, t.source_file, c.source_text_id::text) AS title
    FROM chunks c JOIN texts t ON t.id = c.source_text_id
    WHERE ${authorFilter} AND (${sql.join(indexedAnchors.map((anchor) =>
      sql`(c.source_text_id = ${anchor.source_text_id} AND c.chunk_index BETWEEN ${Math.max(0, anchor.chunk_index - 1)} AND ${anchor.chunk_index + 1})`), sql` OR `)})
    ORDER BY c.source_text_id, c.chunk_index
  `) : { rows: [] };
  const sources: ComparisonSource[] = [];
  const seen = new Set<string>();
  for (const row of [...anchors, ...(neighborhoods.rows || []) as any[]]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    sources.push({ id: row.id, thinker: row.thinker, sourceId: row.source_text_id,
      title: row.title, index: row.chunk_index, text: row.chunk_text });
  }
  const sourcePrompt = sources.map((source) => `[${source.id}] ${source.title}, chunk ${source.index}\n${source.text}`).join("\n\n").slice(0, 110000);
  const raw = await generate(
    `Determine ${author.name}'s OWN position from primary passages, not today's general consensus. Distinguish what this author endorses from opponents' statements, fictional characters, editorial introductions, biographers, and hypotheses the author rejects. Do not attribute a prefatory writer's opinion to the author. Preserve polarity, quantifiers, and whether an account is biological, psychological, social, historical, or normative. A denial of innate differences is NOT a denial of all differences; equality is NOT sameness. Lead with the author's actual substantive thesis, including any differences the author explicitly posits, then give qualifications. Do not invent a stronger proposition by adding "wholly", "entirely", "purely", "every" or "universally" to the user's question and deny that instead. Do not force a yes/no conclusion beyond the sources. If passages disagree, describe the disagreement. Reconstruct the actual premises, distinctions, and inferential steps in the relevant passage, not merely a topical yes/no assertion. Do not accept an isolated occurrence of a keyword as evidence for a thesis. If a passage rejects an inference, preserve that rejection rather than repeating the inference as the author's view. Derive the answer from evidence, not stereotypes. Return ONLY JSON {"answer":"a detailed source-derived answer and supporting reasoning, or an honest statement of what cannot be established","quotes":[{"passageId":"exact supplied ID","text":"exact continuous text from that passage"}]}. Select at least 2 substantive quotations where available, retaining crucial qualifications. No invented or paraphrased quotations.`,
    `QUESTION: ${question}\n\nPRIMARY PASSAGES:\n${sourcePrompt}`, 2400,
  );
  let binding: ReturnType<typeof validateComparisonBinding>;
  try {
    binding = validateComparisonBinding(parseJson(raw), sources);
  } catch {
    // Repair selection by asking for IDs, not by weakening exact-text checks.
    // Models sometimes alter punctuation or paraphrase even when asked to copy.
    const candidates = sources.flatMap((source) => {
      const units = source.text.split(/\n\s*\n/).flatMap((paragraph) =>
        paragraph.length <= 1800 ? [paragraph.trim()]
          : paragraph.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()));
      return units.filter((text) => text.length >= 45 && text.length <= 1800)
        .map((text) => ({ passageId: source.id, text,
          score: terms.filter((term) => text.toLowerCase().includes(term)).length }))
        .sort((a, b) => b.score - a.score).slice(0, 3);
    }).sort((a, b) => b.score - a.score).slice(0, 60)
      .map((candidate, index) => ({ ...candidate, quoteId: `Q${index}` }));
    if (!candidates.length) throw new Error("No verifiable primary excerpts were available.");
    const repair = parseJson(await generate(
      `Derive ${author.name}'s actual answer and supporting argument ONLY from the supplied literal source excerpts. Distinguish the author's conclusions from positions they reject. Do not substitute generic knowledge. Return ONLY JSON {"answer":"source-supported thesis and reasoning, or what the evidence cannot establish","quoteIds":["Q0","Q1"]}. Select the IDs of at least two relevant excerpts where available. Do NOT copy or paraphrase excerpts: select their exact IDs.`,
      `QUESTION: ${question}\nEXCERPTS:\n${candidates.map((candidate) => `[${candidate.quoteId}] ${candidate.text}`).join("\n\n")}`, 2400,
    ));
    const selected = candidates.filter((candidate) =>
      Array.isArray(repair.quoteIds) && repair.quoteIds.includes(candidate.quoteId));
    binding = validateComparisonBinding({
      answer: repair.answer, quotes: selected.map(({ passageId, text }) => ({ passageId, text })),
    }, sources);
  }
  if (hasStrengthenedDenial(question, binding.answer)) {
    // A source-derived synopsis can itself contain the same evasive opening.
    // Rebuild only that synopsis, retaining independently verified quotations.
    binding.answer = await generate(
      "Restate the author's substantive thesis and supporting reasoning using ONLY the supplied evidence. Start with what the author positively claims, not an invented stronger proposition that the author denies. Never add 'wholly', 'entirely', 'completely', 'purely' or 'universally' to the user's question. Retain qualifications and relevant distinctions AFTER the substantive claim. Return only the revised synopsis.",
      `QUESTION: ${question}\nAUTHOR: ${author.name}\nREVISE THIS SYNOPSIS: ${binding.answer}\nVERIFIED EVIDENCE:\n${binding.sources.map((source) => source.text).join("\n\n")}`, 1400,
    );
    if (hasStrengthenedDenial(question, binding.answer)) throw new Error("The source-derived synopsis did not preserve the question.");
  }
  const retained = sources.filter((source) => binding.sources.some((chosen) =>
    chosen.sourceId === source.sourceId && Math.abs(chosen.index - source.index) <= 1));
  const context = retained.map((source) => `[${source.id}] ${source.title}, chunk ${source.index}\n${source.text}`).join("\n\n");
  const passages: PassageCandidate[] = binding.sources.map((source) => ({
    id: source.id, source: "chunks", text: source.text, sourceFile: source.title, chunkIndex: source.index,
  }));
  emit(`Selected ${passages.length} source passages for ${author.name}; ${binding.quotes.length} quotations matched their source text.`, "search_complete");
  return {
    binding: binding.answer, context, sources: retained,
    audit: {
      question, authorId: author.id, authorName: author.name, events,
      directAnswers: passages.map((passage) => ({ passage, isDirectAnswer: true,
        relevanceScore: 1, reasoning: "Selected for the source-derived answer; quotations verified against the passage." })),
      representativeQuotes: binding.quotes.map((quote) => {
        const source = sources.find((item) => item.id === quote.passageId)!;
        return { id: source.id, source: "quotes", text: quote.text, sourceFile: source.title, chunkIndex: source.index };
      }),
      alignmentResult: null, adjacentMaterial: [], searchComplete: true, answerType: "direct_aligned",
    },
  };
}

export function comparisonAnswerRules(name: string, grounding: ComparisonGrounding): string {
  return `AUTHOR-FIDELITY RULES — THESE OVERRIDE ANY CONFLICTING STYLE OR PERSONA INSTRUCTION:
Answer as ${name}, NOT as a generic contemporary adviser. The user asks for this author's position.
The source-derived answer fixes your thesis, distinctions, and reasoning. Expand and apply it, but do not reverse or sanitize it, import another thinker's views, or replace it with modern consensus.
Preserve distinctions between innate, psychological, social, historical, normative and observed claims. Do not collapse equality into sameness. Present controversial views honestly; attribution is not endorsement of their truth.
Lead with the author's actual positive thesis and reasoning. Do not open by denying a stronger claim invented by adding "wholly", "entirely", "purely", "every" or "universally" to the user's question. State the differences the author posits before explaining their scope or causes. Do not use qualifications to conceal the position.
Use only quotations copied exactly from the passages. Do not invent autobiographical claims.
If the sources cannot establish a particular claim, distinguish that uncertainty instead of attributing a generic substitute to the author.
Prior assistant responses are not evidence; correct earlier source-inconsistent statements rather than repeating them.

BINDING SOURCE-DERIVED ANSWER:
${grounding.binding}

GOVERNING PRIMARY PASSAGES:
${grounding.context}`;
}

export async function checkComparisonFidelity(
  name: string, question: string, answer: string, grounding: ComparisonGrounding, generate: GroundingGenerator,
): Promise<{ faithful: boolean; correction: string }> {
  if (hasStrengthenedDenial(question, answer)) {
    return { faithful: false, correction: "The opening evades the actual question by adding a stronger qualifier absent from it. Start with the author's substantive positive claim and supporting mechanism from the primary passages. Do NOT start with No followed by denial of a wholly/entirely/completely different or universal claim. State the author's asserted differences or other substantive position first, then qualify its causes and scope accurately." };
  }
  const result = parseJson(await generate(
    `Check ONLY author fidelity. Compare the answer attributed to ${name} against the binding answer and primary passages. The verbatim passages outrank the synopsis: reject an unsupported or contradicted synopsis too. Reject explicit contradictions, reversed theses/quantifiers, treating opponents' views as the author's, replacing historical author views with modern consensus, collapsing biological/social/normative distinctions, or evading the actual question by denying an invented stronger proposition (e.g. adding "wholly" or "entirely" absent from the question). Reject a generic answer that mentions the author or topic but omits the source's substantive argument or substitutes a standard textbook argument for it. Quotations must be literal excerpts, not invented paraphrases in quotation marks. The opening must not conceal differences or other controversial claims the author explicitly posits. Do not reject reasonable examples, accurate explanations or stylistic differences. Do not judge whether you agree with this author. Return ONLY JSON {"faithful":true/false,"correction":"specific contradiction and required correction, or empty string"}.`,
    `QUESTION: ${question}\nBINDING ANSWER: ${grounding.binding}\nPRIMARY PASSAGES:\n${grounding.context}\n\nANSWER TO CHECK:\n${answer}`, 850,
  ));
  if (typeof result.faithful !== "boolean") throw new Error("The author-fidelity check could not be completed.");
  return { faithful: result.faithful, correction: typeof result.correction === "string" ? result.correction : "" };
}
