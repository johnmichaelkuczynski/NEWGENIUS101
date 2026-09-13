import { db } from "./db";
import { sql } from "drizzle-orm";
import OpenAI from "openai";
import { searchArgumentStatements } from "./vector-search";

// Lazy initialization to avoid crash if API key not set at startup
let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

export interface PassageCandidate {
  id: string;
  source: 'arguments' | 'positions' | 'quotes' | 'chunks';
  text: string;
  topic?: string;
  sourceFile?: string;
  chunkIndex?: number;
}

export interface DirectAnswer {
  passage: PassageCandidate;
  isDirectAnswer: boolean;
  relevanceScore: number;
  reasoning: string;
}

export interface AuditEvent {
  timestamp: number;
  type: 'query' | 'table_search' | 'passage_examined' | 'passage_accepted' | 'passage_rejected' | 
        'direct_answer_found' | 'alignment_check' | 'search_complete' | 'no_direct_answer' | 'error';
  detail: string;
  data?: any;
}

export interface AlignmentResult {
  aligned: boolean;
  conflicting: boolean;
  summary: string;
  conflictDescription?: string;
}

export interface AuditedSearchResult {
  question: string;
  authorId: string;
  authorName: string;
  events: AuditEvent[];
  directAnswers: DirectAnswer[];
  representativeQuotes: PassageCandidate[];
  alignmentResult: AlignmentResult | null;
  adjacentMaterial: PassageCandidate[];
  searchComplete: boolean;
  answerType: 'direct_aligned' | 'direct_conflicting' | 'indirect' | 'no_material';
}

export type AuditEventCallback = (event: AuditEvent) => void;

export async function auditedCorpusSearch(
  question: string,
  authorId: string,
  authorName: string,
  onEvent: AuditEventCallback
): Promise<AuditedSearchResult> {
  const events: AuditEvent[] = [];
  const directAnswers: DirectAnswer[] = [];
  let representativeQuotes: PassageCandidate[] = [];
  const adjacentMaterial: PassageCandidate[] = [];
  
  const emit = (event: Omit<AuditEvent, 'timestamp'>) => {
    const fullEvent: AuditEvent = { ...event, timestamp: Date.now() };
    events.push(fullEvent);
    onEvent(fullEvent);
  };

  emit({ type: 'query', detail: `Starting audited search for author: ${authorName}`, data: { question, authorId } });

  // Map figure IDs to canonical database thinker names
  const authorNameMap: Record<string, string> = {
    "kuczynski": "Kuczynski",
    "freud": "Freud",
    "nietzsche": "Nietzsche",
    "marx": "Marx",
    "berkeley": "George Berkeley",
    "james": "William James",
    "allen": "James Allen",
    "dostoevsky": "Dostoevsky",
    "plato": "Plato",
    "spinoza": "Spinoza",
    "russell": "Russell",
    "galileo": "Galileo",
    "bacon": "Bacon",
    "leibniz": "Leibniz",
    "aristotle": "Aristotle",
    "kant": "Kant",
    "darwin": "Darwin",
    "bergson": "Bergson",
    "schopenhauer": "Schopenhauer",
    "jung": "Jung",
    "aesop": "Aesop",
    "newton": "Newton",
    "goldman": "Emma Goldman",
    "lebon": "Gustave Le Bon",
    "dworkin": "Andrea Dworkin",
    "whewell": "William Whewell",
    "hegel": "Hegel",
    "hume": "Hume",
    "locke": "Locke",
    "hobbes": "Hobbes",
    "descartes": "Descartes",
    "voltaire": "Voltaire",
    "rousseau": "Rousseau",
    "tocqueville": "Tocqueville",
    "smith": "Adam Smith",
    "mises": "Mises",
    "veblen": "Veblen",
    "poe": "Poe",
    "dewey": "Dewey",
    "reich": "Wilhelm Reich",
    "adler": "Adler",
    "confucius": "Confucius",
    "engels": "Engels",
    "gardner": "Martin Gardner"
  };
  
  // Use mapped name for database queries, fall back to authorName or authorId
  const dbThinkerName = authorNameMap[authorId.toLowerCase()] || authorName || authorId;

  try {
    // STEP 0: Search the structured premise/conclusion corpus first. These
    // records encode the author's actual arguments and must outrank isolated
    // quotations or randomly selected position summaries.
    emit({ type: 'table_search', detail: 'Searching structured ARGUMENTS corpus...', data: { table: 'arguments' } });
    const structuredArguments = await searchArgumentStatements(
      dbThinkerName,
      question,
      40,
    );
    const argumentCandidates: PassageCandidate[] = structuredArguments.map(
      (argument, index) => ({
        id: `argument-${index + 1}`,
        source: 'arguments',
        topic: argument.sourceSection || undefined,
        sourceFile: argument.sourceDocument || undefined,
        text: `Premises: ${argument.premises.join(' | ')}\nConclusion: ${argument.conclusion}`,
      }),
    );
    emit({
      type: 'table_search',
      detail: `Found ${argumentCandidates.length} ranked structured arguments`,
      data: { count: argumentCandidates.length },
    });
    const argumentJudgments = await judgeBatch(question, argumentCandidates);
    for (let i = 0; i < argumentCandidates.length; i++) {
      const candidate = argumentCandidates[i];
      const judgment = argumentJudgments[i];
      emit({
        type: 'passage_examined',
        detail: `Examining structured argument: "${candidate.text.substring(0, 100)}..."`,
        data: { id: candidate.id, topic: candidate.topic },
      });
      if (judgment.isDirectAnswer && judgment.relevanceScore >= 0.6) {
        directAnswers.push({ passage: candidate, ...judgment });
        emit({
          type: 'direct_answer_found',
          detail: `STRUCTURED DIRECT ANSWER #${directAnswers.length}: "${candidate.text.substring(0, 100)}..."`,
          data: { answerNumber: directAnswers.length, reasoning: judgment.reasoning },
        });
        if (directAnswers.length >= 8) break;
      } else {
        adjacentMaterial.push(candidate);
      }
    }

    // STEP 1: Search POSITIONS table first
    emit({ type: 'table_search', detail: 'Searching POSITIONS table...', data: { table: 'positions' } });
    
    const positionsQuery = sql`
      SELECT id::text, thinker, position_text, topic 
      FROM positions 
      WHERE thinker ILIKE ${'%' + dbThinkerName + '%'}
      ORDER BY RANDOM()
      LIMIT 30
    `;
    emit({ type: 'query', detail: `SQL: SELECT FROM positions WHERE thinker ILIKE '%${dbThinkerName}%'`, data: { sql: positionsQuery.toString() } });
    
    const positionsResult = await db.execute(positionsQuery);
    const positions = (positionsResult.rows || []) as Array<{id: string, thinker: string, position_text: string, topic: string | null}>;
    
    emit({ type: 'table_search', detail: `Found ${positions.length} position statements`, data: { count: positions.length } });

    // Examine each position for direct answers (judged concurrently)
    const positionCandidates: PassageCandidate[] = positions.map(pos => ({
      id: pos.id,
      source: 'positions',
      text: pos.position_text,
      topic: pos.topic || undefined
    }));
    for (const candidate of positionCandidates) {
      emit({ type: 'passage_examined', detail: `Examining position: "${candidate.text.substring(0, 80)}..."`, data: { id: candidate.id, topic: candidate.topic } });
    }
    const positionJudgments = await judgeBatch(question, positionCandidates);
    for (let i = 0; i < positionCandidates.length; i++) {
      const candidate = positionCandidates[i];
      const judgment = positionJudgments[i];
      if (judgment.isDirectAnswer && judgment.relevanceScore >= 0.7) {
        directAnswers.push({ passage: candidate, ...judgment });
        emit({ type: 'direct_answer_found', detail: `DIRECT ANSWER #${directAnswers.length}: "${candidate.text.substring(0, 100)}..."`, data: { answerNumber: directAnswers.length, reasoning: judgment.reasoning } });
        if (directAnswers.length >= 3) break;
      } else {
        emit({ type: 'passage_rejected', detail: `Rejected: ${judgment.reasoning}`, data: { id: candidate.id, reason: judgment.reasoning } });
        adjacentMaterial.push(candidate);
      }
    }

    const embeddingResponse = await getOpenAI().embeddings.create({
      model: "text-embedding-ada-002",
      input: question,
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // STEP 2: Search source-linked representative quotations by semantic relevance.
    if (directAnswers.length < 20) {
      emit({ type: 'table_search', detail: 'Searching QUOTES table...', data: { table: 'quotes' } });
      
      const quotesQuery = sql`
        SELECT q.id::text, q.thinker, q.quote_text, q.topic,
               COALESCE(t.title, t.source_file) AS source_title,
               q.embedding <=> ${JSON.stringify(queryEmbedding)}::vector AS distance
        FROM quotes q
        JOIN texts t ON t.id = q.source_text_id
        WHERE q.thinker ILIKE ${'%' + dbThinkerName + '%'}
          AND q.embedding IS NOT NULL
        ORDER BY distance
        LIMIT 40
      `;
      emit({ type: 'query', detail: `SQL: SELECT FROM quotes WHERE thinker ILIKE '%${dbThinkerName}%'`, data: { sql: quotesQuery.toString() } });
      
      const quotesResult = await db.execute(quotesQuery);
      const quotes = (quotesResult.rows || []) as Array<{
        id: string;
        thinker: string;
        quote_text: string;
        topic: string | null;
        source_title: string;
      }>;
      
      emit({ type: 'table_search', detail: `Found ${quotes.length} quotes`, data: { count: quotes.length } });

      const quoteCandidates: PassageCandidate[] = quotes.map(quote => ({
        id: quote.id,
        source: 'quotes',
        text: quote.quote_text,
        topic: quote.topic || undefined,
        sourceFile: quote.source_title,
      }));
      representativeQuotes = quoteCandidates.slice(0, 20);
      for (const candidate of quoteCandidates) {
        emit({ type: 'passage_examined', detail: `Examining quote: "${candidate.text.substring(0, 80)}..."`, data: { id: candidate.id } });
      }
      const quoteJudgments = await judgeBatch(question, quoteCandidates);
      for (let i = 0; i < quoteCandidates.length; i++) {
        if (directAnswers.length >= 20) break;
        const candidate = quoteCandidates[i];
        const judgment = quoteJudgments[i];
        if (judgment.isDirectAnswer && judgment.relevanceScore >= 0.7) {
          directAnswers.push({ passage: candidate, ...judgment });
          emit({ type: 'direct_answer_found', detail: `DIRECT ANSWER #${directAnswers.length}: "${candidate.text.substring(0, 100)}..."`, data: { answerNumber: directAnswers.length, reasoning: judgment.reasoning } });
        } else {
          emit({ type: 'passage_rejected', detail: `Rejected: ${judgment.reasoning}`, data: { id: candidate.id, reason: judgment.reasoning } });
          adjacentMaterial.push(candidate);
        }
      }
    }

    // STEP 3: Always search full works so diagnostics can cite named works and
    // provide multiple representative verbatim passages.
    if (directAnswers.length < 20) {
      emit({ type: 'table_search', detail: 'Searching CHUNKS table (full works)...', data: { table: 'chunks' } });
      
      // Use embedding search for chunks to find semantically relevant content
      const chunksQuery = sql`
        SELECT c.id::text, c.thinker, c.chunk_text, c.source_text_id, c.chunk_index,
               COALESCE(t.title, t.source_file, c.source_text_id::text) AS source_title,
               c.embedding <=> ${JSON.stringify(queryEmbedding)}::vector as distance
        FROM chunks c
        LEFT JOIN texts t ON t.id = c.source_text_id
        WHERE c.thinker ILIKE ${'%' + dbThinkerName + '%'}
          AND c.embedding IS NOT NULL
        ORDER BY distance
        LIMIT 40
      `;
      emit({ type: 'query', detail: `SQL: SELECT FROM chunks WHERE thinker ILIKE '%${dbThinkerName}%' ORDER BY embedding distance`, data: { table: 'chunks' } });
      
      const chunksResult = await db.execute(chunksQuery);
      const chunks = (chunksResult.rows || []) as Array<{
        id: string;
        thinker: string;
        chunk_text: string;
        source_text_id: string;
        source_title: string;
        chunk_index: number;
        distance: number;
      }>;
      
      emit({ type: 'table_search', detail: `Found ${chunks.length} chunks from full works`, data: { count: chunks.length } });

      const chunkCandidates: PassageCandidate[] = chunks.map(chunk => ({
        id: chunk.id,
        source: 'chunks',
        text: chunk.chunk_text,
        sourceFile: chunk.source_title,
        chunkIndex: chunk.chunk_index
      }));
      for (let i = 0; i < chunkCandidates.length; i++) {
        const candidate = chunkCandidates[i];
        emit({ type: 'passage_examined', detail: `Examining chunk from "${candidate.sourceFile}": "${candidate.text.substring(0, 60)}..."`, data: { id: candidate.id, sourceFile: candidate.sourceFile, distance: chunks[i].distance } });
      }
      const chunkJudgments = await judgeBatch(question, chunkCandidates);
      for (let i = 0; i < chunkCandidates.length; i++) {
        if (directAnswers.length >= 20) break;
        const candidate = chunkCandidates[i];
        const judgment = chunkJudgments[i];
        if (judgment.isDirectAnswer && judgment.relevanceScore >= 0.6) {
          directAnswers.push({ passage: candidate, ...judgment });
          emit({ type: 'direct_answer_found', detail: `DIRECT ANSWER #${directAnswers.length} from "${candidate.sourceFile}"`, data: { answerNumber: directAnswers.length, reasoning: judgment.reasoning } });
        } else {
          emit({ type: 'passage_rejected', detail: `Rejected: ${judgment.reasoning}`, data: { id: candidate.id, reason: judgment.reasoning } });
          if (adjacentMaterial.length < 10) {
            adjacentMaterial.push(candidate);
          }
        }
      }
    }

    // STEP 4: ALIGNMENT CHECK
    let alignmentResult: AlignmentResult | null = null;
    let answerType: AuditedSearchResult['answerType'] = 'no_material';
    
    const fullWorkDirectAnswers = directAnswers.filter(
      (item) => item.passage.source === 'chunks',
    );
    const governingAnswers = fullWorkDirectAnswers.length > 0
      ? fullWorkDirectAnswers
      : directAnswers;

    if (governingAnswers.length >= 3) {
      emit({ type: 'alignment_check', detail: 'Checking alignment of 3 primary-source answers...', data: { count: governingAnswers.length } });
      
      alignmentResult = await checkAlignment(question, governingAnswers.slice(0, 3));
      
      if (alignmentResult.aligned) {
        emit({ type: 'alignment_check', detail: 'ALIGNED: All 3 answers agree. Proceeding to generate response.', data: alignmentResult });
        answerType = 'direct_aligned';
      } else {
        emit({ type: 'alignment_check', detail: `CONFLICTING: ${alignmentResult.conflictDescription}. Will present all 3 separately.`, data: alignmentResult });
        answerType = 'direct_conflicting';
      }
    } else if (governingAnswers.length > 0) {
      emit({ type: 'alignment_check', detail: `Found only ${governingAnswers.length} direct primary-source answer(s). Using available evidence.`, data: { count: governingAnswers.length } });
      answerType = 'direct_aligned';
    } else if (adjacentMaterial.length > 0) {
      emit({ type: 'no_direct_answer', detail: 'No direct answers found. Will use adjacent material cautiously.', data: { adjacentCount: adjacentMaterial.length } });
      answerType = 'indirect';
    } else {
      emit({ type: 'no_direct_answer', detail: 'No relevant material found in corpus.', data: {} });
      answerType = 'no_material';
    }

    emit({ type: 'search_complete', detail: `Search complete. Found ${directAnswers.length} direct answers, ${adjacentMaterial.length} adjacent passages.`, data: { directCount: directAnswers.length, adjacentCount: adjacentMaterial.length, answerType } });

    return {
      question,
      authorId,
      authorName,
      events,
      directAnswers,
      representativeQuotes,
      alignmentResult,
      adjacentMaterial: adjacentMaterial.slice(0, 5),
      searchComplete: true,
      answerType
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', detail: `Search error: ${errorMsg}`, data: { error: errorMsg } });
    
    return {
      question,
      authorId,
      authorName,
      events,
      directAnswers,
      representativeQuotes,
      alignmentResult: null,
      adjacentMaterial,
      searchComplete: false,
      answerType: 'no_material'
    };
  }
}

// Judge many candidates concurrently (bounded) instead of one-at-a-time.
// This is the main performance lever: serial judging of ~30-90 passages was
// the cause of multi-minute response times.
async function judgeBatch(
  question: string,
  candidates: PassageCandidate[],
  concurrency = 12
): Promise<Array<{isDirectAnswer: boolean, relevanceScore: number, reasoning: string}>> {
  const results: Array<{isDirectAnswer: boolean, relevanceScore: number, reasoning: string}> = new Array(candidates.length);
  let next = 0;
  async function worker() {
    while (next < candidates.length) {
      const i = next++;
      results[i] = await judgeDirectAnswer(question, candidates[i].text);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function judgeDirectAnswer(question: string, passage: string): Promise<{isDirectAnswer: boolean, relevanceScore: number, reasoning: string}> {
  try {
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content: `You are a strict primary-source relevance judge. Given a QUESTION and a PASSAGE, determine:
1. Does this passage state the AUTHOR'S ENDORSED direct answer to the question?
An objection, quotation of another person, hypothetical, abandoned earlier belief, view introduced only to be rejected, or statement whose negation the author ultimately endorses is NOT an endorsed direct answer.
Use the passage's argumentative context, including contrast words and explicit conclusions. Merely mentioning or clearly formulating a view does not mean the author endorses it.
2. Relevance score 0.0-1.0 (1.0 = perfectly on-point direct answer)
3. Brief reasoning

Respond ONLY in JSON format:
{"isDirectAnswer": true/false, "relevanceScore": 0.0-1.0, "reasoning": "brief explanation"}`
        },
        {
          role: "user",
          content: `QUESTION: ${question}\n\nPASSAGE: ${passage.substring(0, 1500)}`
        }
      ]
    });

    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return {
      isDirectAnswer: parsed.isDirectAnswer || false,
      relevanceScore: parsed.relevanceScore || 0,
      reasoning: parsed.reasoning || 'Unable to determine'
    };
  } catch (error) {
    return { isDirectAnswer: false, relevanceScore: 0, reasoning: 'Judgment failed' };
  }
}

async function checkAlignment(question: string, answers: DirectAnswer[]): Promise<AlignmentResult> {
  try {
    const answersText = answers.map((a, i) => `Answer ${i + 1}: "${a.passage.text.substring(0, 1500)}"`).join('\n\n');
    
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: `You are a strict logical contradiction judge. Given a QUESTION and 3 endorsed ANSWER passages from the same author, determine whether they can all be true together.

Mark CONFLICTING only if one passage affirms a proposition P and another passage denies P, with the same meaning, scope, time, and qualifications.

The following are ALIGNED, not conflicting:
- different arguments for the same conclusion
- different aspects, implications, examples, or levels of detail
- a general rule and a qualified application of that rule
- absolute wording in one passage and explicit limiting detail in another, unless the claims logically exclude each other
- complementary causal, logical, epistemic, or metaphysical explanations

Do not equate "different" with "contradictory." If you cannot quote the specific P and not-P claims, mark aligned.

Respond ONLY in JSON format:
{"aligned": true/false, "conflicting": true/false, "summary": "brief summary", "conflictDescription": "if conflicting, quote the P and not-P claims"}`
        },
        {
          role: "user",
          content: `QUESTION: ${question}\n\n${answersText}`
        }
      ]
    });

    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return {
      aligned: parsed.aligned || false,
      conflicting: parsed.conflicting || false,
      summary: parsed.summary || '',
      conflictDescription: parsed.conflictDescription
    };
  } catch (error) {
    return { aligned: true, conflicting: false, summary: 'Alignment check failed - treating as aligned' };
  }
}

export function generateAuditReport(result: AuditedSearchResult): string {
  const lines: string[] = [];
  
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('                    AUDIT REPORT');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`Question: ${result.question}`);
  lines.push(`Author: ${result.authorName} (${result.authorId})`);
  lines.push(`Timestamp: ${new Date().toISOString()}`);
  lines.push(`Answer Type: ${result.answerType}`);
  lines.push('');
  
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('                    EXECUTION TRACE');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');
  
  for (const event of result.events) {
    const time = new Date(event.timestamp).toISOString().substring(11, 23);
    lines.push(`[${time}] ${event.type.toUpperCase()}: ${event.detail}`);
    if (event.data && Object.keys(event.data).length > 0) {
      lines.push(`           Data: ${JSON.stringify(event.data)}`);
    }
  }
  
  lines.push('');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('                    DIRECT ANSWERS FOUND');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');
  
  if (result.directAnswers.length === 0) {
    lines.push('No direct answers found in corpus.');
  } else {
    for (let i = 0; i < result.directAnswers.length; i++) {
      const da = result.directAnswers[i];
      lines.push(`DIRECT ANSWER #${i + 1}`);
      lines.push(`  Source: ${da.passage.source} (ID: ${da.passage.id})`);
      if (da.passage.topic) lines.push(`  Topic: ${da.passage.topic}`);
      if (da.passage.sourceFile) lines.push(`  File: ${da.passage.sourceFile}`);
      lines.push(`  Relevance: ${(da.relevanceScore * 100).toFixed(0)}%`);
      lines.push(`  Reasoning: ${da.reasoning}`);
      lines.push(`  Text: "${da.passage.text.substring(0, 500)}${da.passage.text.length > 500 ? '...' : ''}"`);
      lines.push('');
    }
  }
  
  if (result.alignmentResult) {
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('                    ALIGNMENT CHECK');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('');
    lines.push(`Result: ${result.alignmentResult.aligned ? 'ALIGNED' : 'CONFLICTING'}`);
    lines.push(`Summary: ${result.alignmentResult.summary}`);
    if (result.alignmentResult.conflictDescription) {
      lines.push(`Conflict: ${result.alignmentResult.conflictDescription}`);
    }
    lines.push('');
  }
  
  if (result.adjacentMaterial.length > 0) {
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('                    ADJACENT MATERIAL');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('');
    for (const adj of result.adjacentMaterial.slice(0, 5)) {
      lines.push(`[${adj.source}] ${adj.text.substring(0, 200)}...`);
      lines.push('');
    }
  }
  
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('                    END OF AUDIT REPORT');
  lines.push('═══════════════════════════════════════════════════════════════');
  
  return lines.join('\n');
}

export function buildPromptFromAuditResult(result: AuditedSearchResult): { systemPrompt: string; contextPrompt: string } {
  let systemPrompt = '';
  let contextPrompt = '';
  const fullWorkAnswers = result.directAnswers.filter(
    (item) => item.passage.source === 'chunks',
  );
  const governingAnswers = fullWorkAnswers.length > 0
    ? fullWorkAnswers
    : result.directAnswers;
  
  if (result.answerType === 'direct_aligned') {
    systemPrompt = `You are ${result.authorName}. You have been asked a question and your corpus has been searched.
The search found ${result.directAnswers.length} direct answer(s) that ALIGN.

YOUR ROLE IS LIMITED:
- Phrase the answer in your authentic voice
- Use the exact evidence provided below
- Do NOT invent content beyond what is given
- Do NOT smooth over or add qualifications not in the source

Respond as ${result.authorName}, grounding every claim in the passages below.`;

    contextPrompt = `DIRECT ANSWERS FROM YOUR CORPUS:\n\n`;
    for (let i = 0; i < governingAnswers.length; i++) {
      const da = governingAnswers[i];
      contextPrompt += `[${da.passage.source.toUpperCase()} ${i + 1}]: "${da.passage.text}"\n\n`;
    }
  } else if (result.answerType === 'direct_conflicting') {
    systemPrompt = `You are ${result.authorName}. You have been asked a question and your corpus has been searched.
The search found ${result.directAnswers.length} direct answers that CONFLICT with each other.

CRITICAL RULE - NO SYNTHESIS:
You must NOT reconcile or smooth over these disagreements.
You must present ALL ${result.directAnswers.length} answers separately and honestly.
Say: "I found different answers in my work. Here they are."

Do NOT invent a unified position. Present the conflict truthfully.`;

    contextPrompt = `CONFLICTING ANSWERS FROM YOUR CORPUS:\n\n`;
    for (let i = 0; i < governingAnswers.length; i++) {
      const da = governingAnswers[i];
      contextPrompt += `[ANSWER ${i + 1} - ${da.passage.source}]: "${da.passage.text}"\n\n`;
    }
    if (result.alignmentResult?.conflictDescription) {
      contextPrompt += `CONFLICT DESCRIPTION: ${result.alignmentResult.conflictDescription}\n\n`;
    }
  } else if (result.answerType === 'indirect') {
    systemPrompt = `You are ${result.authorName}. You have been asked a question and your corpus has been searched.
The corpus contains related material but NO direct answer to the question.

MANDATORY SOURCE-FAITHFUL RESPONSE:
- Do NOT answer the question on ${result.authorName}'s behalf
- Do NOT infer a position from general themes, style, or unrelated works
- Do NOT convert adjacent material into a supposed direct answer
- State plainly that the indexed corpus does not contain a direct answer
- You may identify the material below only as related, never as the answer
- Keep the response brief`;

    contextPrompt = `RELATED MATERIAL FROM YOUR CORPUS:\n\n`;
    for (const adj of result.adjacentMaterial) {
      contextPrompt += `[${adj.source}]: "${adj.text.substring(0, 800)}"\n\n`;
    }
  } else {
    systemPrompt = `The indexed corpus contains no material supporting an answer from ${result.authorName}.

MANDATORY RESPONSE:
- State plainly that the indexed corpus does not contain an answer
- Do NOT answer from model knowledge
- Do NOT imitate ${result.authorName}'s voice
- Do NOT infer or invent a position
- Keep the response brief`;
    contextPrompt = ``;
  }
  
  return { systemPrompt, contextPrompt };
}
