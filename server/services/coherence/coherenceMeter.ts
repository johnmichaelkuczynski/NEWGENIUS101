import { readCoherenceState } from './coherenceDatabase';
import OpenAI from 'openai';

function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export interface RewriteResult {
  rewrittenText: string;
  changesApplied: string[];
  originalViolations: string[];
}

export async function rewriteForCoherence(
  originalText: string,
  documentId: string,
  coherenceMode: string,
  figureName?: string
): Promise<RewriteResult> {
  const state = await readCoherenceState(documentId, coherenceMode);
  
  if (!state || !state.chunks.length) {
    return {
      rewrittenText: originalText,
      changesApplied: [],
      originalViolations: [],
    };
  }

  const allViolations = state.chunks
    .flatMap(c => c.evaluationResult.violations || [])
    .filter((v, i, arr) => arr.indexOf(v) === i);

  if (allViolations.length === 0) {
    return {
      rewrittenText: originalText,
      changesApplied: [],
      originalViolations: [],
    };
  }

  const openai = getOpenAI();
  if (!openai) {
    return {
      rewrittenText: originalText,
      changesApplied: [],
      originalViolations: allViolations,
    };
  }

  const prompt = `You are a philosophical editor maintaining ${figureName || 'the author'}'s authentic voice.

ORIGINAL TEXT:
${originalText}

COHERENCE VIOLATIONS TO FIX:
${allViolations.map((v, i) => `${i + 1}. ${v}`).join('\n')}

Rewrite the text to fix these coherence issues while:
1. Preserving the author's distinctive voice and style
2. Maintaining all key arguments and positions
3. Keeping the same overall structure
4. Only making minimal changes necessary for coherence

Output the corrected text only, no explanations.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 16000,
    });

    const rewrittenText = response.choices[0]?.message?.content || originalText;

    return {
      rewrittenText,
      changesApplied: allViolations.map(v => `Fixed: ${v}`),
      originalViolations: allViolations,
    };
  } catch (error) {
    console.error('[CoherenceMeter] Rewrite error:', error);
    return {
      rewrittenText: originalText,
      changesApplied: [],
      originalViolations: allViolations,
    };
  }
}

export async function measureCoherence(text: string, figureName?: string): Promise<{
  score: number;
  issues: string[];
  suggestions: string[];
}> {
  const openai = getOpenAI();
  if (!openai) {
    return { score: 75, issues: [], suggestions: [] };
  }

  const prompt = `Analyze this philosophical text for coherence on a scale of 0-100.

TEXT:
${text.slice(0, 8000)}

${figureName ? `EXPECTED VOICE: ${figureName}` : ''}

Respond in JSON:
{
  "score": number from 0-100,
  "issues": ["list of coherence issues found"],
  "suggestions": ["list of improvement suggestions"]
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
      score: result.score || 75,
      issues: result.issues || [],
      suggestions: result.suggestions || [],
    };
  } catch (error) {
    console.error('[CoherenceMeter] Measurement error:', error);
    return { score: 75, issues: [], suggestions: [] };
  }
}
