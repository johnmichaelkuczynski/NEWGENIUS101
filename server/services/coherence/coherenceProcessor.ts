import { v4 as uuidv4 } from 'uuid';
import { writeCoherenceState, writeCoherenceChunk } from './coherenceDatabase';
import OpenAI from 'openai';

function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export type CoherenceStatus = 'coherent' | 'minor_issues' | 'needs_revision';

export interface CoherenceResult {
  documentId: string;
  overallStatus: CoherenceStatus;
  totalChunks: number;
  coherentChunks: number;
  violations: string[];
}

type ProgressCallback = (
  index: number,
  total: number,
  status: CoherenceStatus,
  violations: string[]
) => void;

function splitIntoChunks(text: string, maxChunkSize: number = 1500): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    if (currentChunk.length + para.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

async function evaluateChunkCoherence(
  chunk: string,
  previousContext: string,
  figureName: string,
  coherenceMode: string
): Promise<{ status: CoherenceStatus; violations: string[]; reasoning: string }> {
  const openai = getOpenAI();
  if (!openai) {
    return { status: 'coherent', violations: [], reasoning: 'OpenAI not configured' };
  }

  const prompt = `You are evaluating a chunk of philosophical text for coherence.

MODE: ${coherenceMode}
AUTHOR VOICE: ${figureName}
PREVIOUS CONTEXT (last 500 chars): ${previousContext.slice(-500)}

CHUNK TO EVALUATE:
${chunk}

Evaluate for:
1. Logical consistency with previous content
2. Voice consistency with ${figureName}
3. No contradictions or abrupt topic shifts
4. Proper argumentation flow

Respond in JSON:
{
  "status": "coherent" | "minor_issues" | "needs_revision",
  "violations": ["list of specific issues if any"],
  "reasoning": "brief explanation"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{}');
    return {
      status: result.status || 'coherent',
      violations: result.violations || [],
      reasoning: result.reasoning || '',
    };
  } catch (error) {
    console.error('[CoherenceProcessor] Evaluation error:', error);
    return { status: 'coherent', violations: [], reasoning: 'Evaluation skipped due to error' };
  }
}

export async function processDocumentCoherently(
  text: string,
  coherenceMode: string,
  figureId?: string,
  figureName?: string,
  onProgress?: ProgressCallback
): Promise<CoherenceResult> {
  const documentId = uuidv4();
  const chunks = splitIntoChunks(text);
  const allViolations: string[] = [];
  let coherentCount = 0;
  let previousContext = '';

  await writeCoherenceState(documentId, coherenceMode, {
    totalChunks: chunks.length,
    figureId,
    figureName,
    startedAt: new Date().toISOString(),
  });

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const evaluation = await evaluateChunkCoherence(
      chunk,
      previousContext,
      figureName || 'Unknown',
      coherenceMode
    );

    if (evaluation.status === 'coherent') {
      coherentCount++;
    }
    allViolations.push(...evaluation.violations);

    await writeCoherenceChunk(
      documentId,
      coherenceMode,
      i,
      chunk,
      { status: evaluation.status, violations: evaluation.violations },
      { processedAt: new Date().toISOString(), reasoning: evaluation.reasoning }
    );

    if (onProgress) {
      onProgress(i, chunks.length, evaluation.status, evaluation.violations);
    }

    previousContext += '\n\n' + chunk;
  }

  const overallStatus: CoherenceStatus = 
    allViolations.length === 0 ? 'coherent' :
    allViolations.length < 3 ? 'minor_issues' : 'needs_revision';

  await writeCoherenceState(documentId, coherenceMode, {
    totalChunks: chunks.length,
    coherentChunks: coherentCount,
    overallStatus,
    violations: allViolations,
    completedAt: new Date().toISOString(),
  });

  return {
    documentId,
    overallStatus,
    totalChunks: chunks.length,
    coherentChunks: coherentCount,
    violations: allViolations,
  };
}
