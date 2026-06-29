import { db } from '../../db';
import { coherenceDocuments, coherenceChunks } from '@shared/schema';
import { eq, and } from 'drizzle-orm';

export interface CoherenceState {
  documentId: string;
  coherenceMode: string;
  globalState: Record<string, any>;
  chunks: Array<{
    chunkIndex: number;
    chunkText: string;
    evaluationResult: Record<string, any>;
    stateAfter: Record<string, any>;
  }>;
}

export async function readCoherenceState(documentId: string, coherenceMode: string): Promise<CoherenceState | null> {
  try {
    const [doc] = await db
      .select()
      .from(coherenceDocuments)
      .where(and(
        eq(coherenceDocuments.documentId, documentId),
        eq(coherenceDocuments.coherenceMode, coherenceMode)
      ))
      .limit(1);

    if (!doc) return null;

    const chunks = await db
      .select()
      .from(coherenceChunks)
      .where(and(
        eq(coherenceChunks.documentId, documentId),
        eq(coherenceChunks.coherenceMode, coherenceMode)
      ))
      .orderBy(coherenceChunks.chunkIndex);

    return {
      documentId,
      coherenceMode,
      globalState: doc.globalState as Record<string, any>,
      chunks: chunks.map(c => ({
        chunkIndex: c.chunkIndex,
        chunkText: c.chunkText,
        evaluationResult: c.evaluationResult as Record<string, any>,
        stateAfter: c.stateAfter as Record<string, any>,
      })),
    };
  } catch (error) {
    console.error('[CoherenceDatabase] Error reading state:', error);
    return null;
  }
}

export async function writeCoherenceState(
  documentId: string,
  coherenceMode: string,
  globalState: Record<string, any>
): Promise<void> {
  try {
    await db
      .insert(coherenceDocuments)
      .values({
        documentId,
        coherenceMode,
        globalState,
      })
      .onConflictDoUpdate({
        target: [coherenceDocuments.documentId, coherenceDocuments.coherenceMode],
        set: {
          globalState,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.error('[CoherenceDatabase] Error writing state:', error);
    throw error;
  }
}

export async function writeCoherenceChunk(
  documentId: string,
  coherenceMode: string,
  chunkIndex: number,
  chunkText: string,
  evaluationResult: Record<string, any>,
  stateAfter: Record<string, any>
): Promise<void> {
  try {
    await db
      .insert(coherenceChunks)
      .values({
        documentId,
        coherenceMode,
        chunkIndex,
        chunkText,
        evaluationResult,
        stateAfter,
      })
      .onConflictDoUpdate({
        target: [coherenceChunks.documentId, coherenceChunks.coherenceMode, coherenceChunks.chunkIndex],
        set: {
          chunkText,
          evaluationResult,
          stateAfter,
        },
      });
  } catch (error) {
    console.error('[CoherenceDatabase] Error writing chunk:', error);
    throw error;
  }
}
