// server/services/reconstructionEngine.ts
//
// Cross-Chunk Coherence (CC) Reconstruction Engine.
// 3-pass architecture for transforming long input documents:
//   PASS 1: Extract global skeleton (thesis, outline, key terms, commitments)
//   PASS 2: Chunk-by-chunk processing with skeleton + length enforcement
//   PASS 3: Stitch pass — review delta reports, flag conflicts
//
// All intermediate state persisted to Neon Postgres
// (reconstruction_jobs + reconstruction_chunks).
// Resumable from any phase.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { db } from "../db";
import { reconstructionJobs, reconstructionChunks } from "../../shared/schema";
import { eq, and, asc, sql } from "drizzle-orm";

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const OPENAI_MODEL = "gpt-4o";

const INPUT_CHUNK_WORDS = 500;
const INTER_CHUNK_DELAY_MS = 2500;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LengthMode =
  | "heavy_compression"   // ratio < 0.4
  | "light_compression"   // 0.4–0.85
  | "preserve"            // 0.85–1.15
  | "light_expansion"     // 1.15–2.0
  | "heavy_expansion";    // > 2.0

export interface GlobalSkeleton {
  thesis: string;
  outline: string[];
  keyTerms: Record<string, string>;
  commitments: {
    asserts: string[];
    rejects: string[];
    assumes: string[];
  };
  entities: string[];
}

export interface ChunkDelta {
  newClaims: string[];
  termsUsed: string[];
  conflicts: string[];
}

export interface ReconstructionEvent {
  type:
    | "status"
    | "job_init"
    | "skeleton"
    | "chunk_start"
    | "chunk_done"
    | "chunk_retry"
    | "stitch"
    | "complete"
    | "error";
  data?: any;
}

export interface ReconstructionRequest {
  originalText: string;
  customInstructions?: string;
  userId?: string;
  signal?: AbortSignal;
}

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new AbortError());
      };
      if (signal.aborted) {
        clearTimeout(t);
        reject(new AbortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Length parsing & mode
// ─────────────────────────────────────────────────────────────────────────────

export function parseTargetLength(
  instructions: string,
  inputWords: number
): { targetMin: number; targetMax: number } {
  const text = (instructions || "").toLowerCase();

  // Explicit range: "X to Y words", "X-Y words"
  const rangeMatch = text.match(/(\d[\d,]*)\s*(?:to|[-–])\s*(\d[\d,]*)\s*words?/);
  if (rangeMatch) {
    return {
      targetMin: parseInt(rangeMatch[1].replace(/,/g, ""), 10),
      targetMax: parseInt(rangeMatch[2].replace(/,/g, ""), 10),
    };
  }

  // Single target: "5000 words", "about 5000 words"
  const singleMatch = text.match(/(?:about|approximately|roughly|~|target[:\s]+)?\s*(\d[\d,]{2,})\s*words?/);
  if (singleMatch) {
    const n = parseInt(singleMatch[1].replace(/,/g, ""), 10);
    return { targetMin: Math.floor(n * 0.9), targetMax: Math.ceil(n * 1.1) };
  }

  // Verbal cues
  if (/\b(half|cut in half|50%)\b/.test(text)) {
    const m = Math.floor(inputWords / 2);
    return { targetMin: Math.floor(m * 0.85), targetMax: Math.ceil(m * 1.15) };
  }
  if (/\b(double|2x|twice)\b/.test(text)) {
    const m = inputWords * 2;
    return { targetMin: Math.floor(m * 0.9), targetMax: Math.ceil(m * 1.1) };
  }
  if (/\b(triple|3x)\b/.test(text)) {
    const m = inputWords * 3;
    return { targetMin: Math.floor(m * 0.9), targetMax: Math.ceil(m * 1.1) };
  }
  if (/\b(compress|shorten|condense|summarize)\b/.test(text)) {
    const m = Math.floor(inputWords * 0.5);
    return { targetMin: Math.floor(m * 0.8), targetMax: Math.ceil(m * 1.2) };
  }
  if (/\b(expand|elaborate|enrich|lengthen)\b/.test(text)) {
    const m = Math.floor(inputWords * 1.5);
    return { targetMin: Math.floor(m * 0.85), targetMax: Math.ceil(m * 1.15) };
  }

  // Default: preserve length (±15%)
  return { targetMin: Math.floor(inputWords * 0.85), targetMax: Math.ceil(inputWords * 1.15) };
}

export function getLengthMode(ratio: number): LengthMode {
  if (ratio < 0.4) return "heavy_compression";
  if (ratio < 0.85) return "light_compression";
  if (ratio <= 1.15) return "preserve";
  if (ratio <= 2.0) return "light_expansion";
  return "heavy_expansion";
}

function getLengthGuidance(mode: LengthMode): string {
  switch (mode) {
    case "heavy_compression":
      return `LENGTH MODE: HEAVY COMPRESSION. Distill aggressively to core claims only. Drop examples, repetition, and tangential material. Keep only the essential argument and key terminology.`;
    case "light_compression":
      return `LENGTH MODE: LIGHT COMPRESSION. Tighten prose. Remove redundancy and weaker examples. Preserve all major claims and at least one example per claim.`;
    case "preserve":
      return `LENGTH MODE: PRESERVE LENGTH. Maintain roughly the same length. Rewrite for clarity and coherence without adding or removing substantive content.`;
    case "light_expansion":
      return `LENGTH MODE: LIGHT EXPANSION. Add substantive elaboration: extra examples, clearer transitions, expanded implications. No filler or padding — every added sentence must add information.`;
    case "heavy_expansion":
      return `LENGTH MODE: HEAVY EXPANSION. Substantially elaborate each claim with detailed examples, counterarguments and replies, and full implications. No padding — added material must be informationally dense.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM helpers
// ─────────────────────────────────────────────────────────────────────────────

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  opts: { json?: boolean; maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const maxTokens = opts.maxTokens ?? 4000;
  const temperature = opts.temperature ?? 0.4;
  checkAbort(opts.signal);

  if (anthropic) {
    try {
      const res = await anthropic.messages.create(
        {
          model: ANTHROPIC_MODEL,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        },
        opts.signal ? { signal: opts.signal } : undefined
      );
      return res.content[0]?.type === "text" ? res.content[0].text : "";
    } catch (err) {
      if (opts.signal?.aborted) throw new AbortError();
      console.warn("[reconstruction] Anthropic call failed, trying OpenAI:", (err as Error).message);
    }
  }
  if (openai) {
    const res = await openai.chat.completions.create(
      {
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: Math.min(maxTokens, 16000),
        temperature,
        response_format: opts.json ? { type: "json_object" } : undefined,
      },
      opts.signal ? { signal: opts.signal } : undefined
    );
    return res.choices[0]?.message?.content || "";
  }
  throw new Error("No AI provider available (set ANTHROPIC_API_KEY or OPENAI_API_KEY).");
}

function safeJson(raw: string): any {
  try { return JSON.parse(raw); } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunking
// ─────────────────────────────────────────────────────────────────────────────

function splitIntoChunks(text: string, targetWords: number): string[] {
  // Respect paragraph boundaries. Break at paragraph ends. Never mid-sentence.
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf: string[] = [];
  let bufWords = 0;

  for (const p of paragraphs) {
    const pWords = countWords(p);
    // Single paragraph larger than target → split on sentence boundaries
    if (pWords > targetWords * 1.6) {
      if (buf.length) {
        chunks.push(buf.join("\n\n"));
        buf = [];
        bufWords = 0;
      }
      const sentences = p.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [p];
      let sBuf: string[] = [];
      let sWords = 0;
      for (const s of sentences) {
        const sw = countWords(s);
        if (sWords + sw > targetWords && sBuf.length) {
          chunks.push(sBuf.join("").trim());
          sBuf = [];
          sWords = 0;
        }
        sBuf.push(s);
        sWords += sw;
      }
      if (sBuf.length) chunks.push(sBuf.join("").trim());
      continue;
    }

    if (bufWords + pWords > targetWords && buf.length) {
      chunks.push(buf.join("\n\n"));
      buf = [p];
      bufWords = pWords;
    } else {
      buf.push(p);
      bufWords += pWords;
    }
  }
  if (buf.length) chunks.push(buf.join("\n\n"));
  return chunks.length ? chunks : [text.trim()];
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 1: Skeleton extraction
// ─────────────────────────────────────────────────────────────────────────────

async function extractSkeleton(
  originalText: string,
  signal?: AbortSignal
): Promise<GlobalSkeleton> {
  const system = `You are extracting a structural skeleton from a document.
This skeleton will constrain coherent processing of every section.
Be precise. Preserve exact terminology. Errors here propagate everywhere.

Return EXACT JSON only with this shape:
{
  "thesis": "1-3 sentence central argument or purpose",
  "outline": ["section 1 — purpose", "section 2 — purpose", ...],
  "keyTerms": {"TERM": "definition as used in document", ...},
  "commitments": {
    "asserts": ["specific claims the document commits to"],
    "rejects": ["positions the document rejects"],
    "assumes": ["unstated background assumptions"]
  },
  "entities": ["people / orgs / technical names requiring consistent reference"]
}

8-20 outline entries. Keep total output under 2000 tokens.`;

  // Cap input passed to skeleton call. For very long docs, sample head + middle + tail.
  const MAX_SKELETON_INPUT_CHARS = 60000;
  let docInput: string;
  if (originalText.length <= MAX_SKELETON_INPUT_CHARS) {
    docInput = originalText;
  } else {
    const slice = Math.floor(MAX_SKELETON_INPUT_CHARS / 3);
    const mid = Math.floor(originalText.length / 2);
    docInput =
      originalText.slice(0, slice) +
      "\n\n[...middle...]\n\n" +
      originalText.slice(mid - slice / 2, mid + slice / 2) +
      "\n\n[...]\n\n" +
      originalText.slice(-slice);
  }

  const raw = await callLLM(
    system,
    `DOCUMENT TEXT:\n\n${docInput}\n\nReturn ONLY the JSON object.`,
    { json: true, maxTokens: 3000, temperature: 0.3, signal }
  );
  const parsed = safeJson(raw);

  return {
    thesis: typeof parsed.thesis === "string" ? parsed.thesis : "Document thesis unavailable.",
    outline: Array.isArray(parsed.outline) ? parsed.outline.map(String) : [],
    keyTerms: (parsed.keyTerms && typeof parsed.keyTerms === "object") ? parsed.keyTerms : {},
    commitments: {
      asserts: Array.isArray(parsed.commitments?.asserts) ? parsed.commitments.asserts.map(String) : [],
      rejects: Array.isArray(parsed.commitments?.rejects) ? parsed.commitments.rejects.map(String) : [],
      assumes: Array.isArray(parsed.commitments?.assumes) ? parsed.commitments.assumes.map(String) : [],
    },
    entities: Array.isArray(parsed.entities) ? parsed.entities.map(String) : [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 2: Per-chunk processing
// ─────────────────────────────────────────────────────────────────────────────

function buildSkeletonContext(s: GlobalSkeleton): string {
  return [
    `THESIS: ${s.thesis}`,
    `OUTLINE:\n${s.outline.map((o, i) => `${i + 1}. ${o}`).join("\n")}`,
    `KEY TERMS:\n${Object.entries(s.keyTerms).slice(0, 20).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "(none)"}`,
    `ASSERTS:\n${s.commitments.asserts.slice(0, 12).map(c => `- ${c}`).join("\n") || "(none)"}`,
    `REJECTS:\n${s.commitments.rejects.slice(0, 8).map(c => `- ${c}`).join("\n") || "(none)"}`,
    `ASSUMES:\n${s.commitments.assumes.slice(0, 8).map(c => `- ${c}`).join("\n") || "(none)"}`,
    `ENTITIES: ${s.entities.slice(0, 20).join(", ") || "(none)"}`,
  ].join("\n\n");
}

function buildChunkPrompt(args: {
  chunkText: string;
  chunkIndex: number;
  totalChunks: number;
  chunkInputWords: number;
  targetWords: number;
  minWords: number;
  maxWords: number;
  lengthGuidance: string;
  skeleton: GlobalSkeleton;
  customInstructions: string;
}): { system: string; user: string } {
  const system = `You are processing ONE chunk of a larger document. You must maintain coherence
with the document's established structure and commitments — defined in the
GLOBAL SKELETON below. Never silently contradict the skeleton.

GLOBAL SKELETON (HONOR THIS):
${buildSkeletonContext(args.skeleton)}

CUSTOM INSTRUCTIONS (user-supplied transformation goal):
${args.customInstructions || "(none — produce a coherent rewrite that preserves meaning)"}

*** OUTPUT LENGTH REQUIREMENT ***
This is chunk ${args.chunkIndex + 1} of ${args.totalChunks}.
Original chunk length: ${args.chunkInputWords} words.
YOUR OUTPUT MUST BE: ${args.minWords}–${args.maxWords} words (target ~${args.targetWords}).
This is a HARD requirement. Count your words before finalizing.

${args.lengthGuidance}
*** END LENGTH REQUIREMENT ***

CONSTRAINTS:
- Do NOT contradict any commitment in the skeleton.
- Use KEY TERMS exactly as defined.
- If you detect a conflict between this chunk's content and the skeleton,
  produce the closest adjacent repair that preserves intent, AND flag it
  in DELTA_REPORT under "conflicts".
- Never refuse. Always produce processed text plus delta.
- Output ONLY in the format below. No preamble.`;

  const user = `CHUNK TEXT:
${args.chunkText}

Respond in exactly this format:

PROCESSED_TEXT:
[Your reconstructed chunk here — ${args.minWords}–${args.maxWords} words]

WORD_COUNT: [actual integer count]

DELTA_REPORT:
- new_claims: [comma-separated list of new claims introduced, or "none"]
- terms_used: [comma-separated KEY TERMS from skeleton that you used, or "none"]
- conflicts: [any conflicts with skeleton with proposed repair, or "none"]`;

  return { system, user };
}

function parseChunkResponse(raw: string): { processed: string; delta: ChunkDelta } {
  // Extract PROCESSED_TEXT block (everything between the marker and WORD_COUNT/DELTA_REPORT)
  const procMatch = raw.match(/PROCESSED_TEXT:\s*([\s\S]*?)(?:\n\s*WORD_COUNT:|\n\s*DELTA_REPORT:|$)/i);
  let processed = procMatch ? procMatch[1].trim() : raw.trim();

  const deltaMatch = raw.match(/DELTA_REPORT:\s*([\s\S]*)$/i);
  const deltaBlock = deltaMatch ? deltaMatch[1] : "";

  const parseField = (name: string): string[] => {
    const re = new RegExp(`${name}\\s*:\\s*\\[?([^\\n\\]]*)\\]?`, "i");
    const m = deltaBlock.match(re);
    if (!m) return [];
    const v = m[1].trim();
    if (!v || v.toLowerCase() === "none") return [];
    return v.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  };

  return {
    processed,
    delta: {
      newClaims: parseField("new_claims"),
      termsUsed: parseField("terms_used"),
      conflicts: parseField("conflicts"),
    },
  };
}

function buildRetryPrompt(args: {
  previousOutput: string;
  actualWords: number;
  targetWords: number;
  minWords: number;
  maxWords: number;
  needsExpansion: boolean;
}): { system: string; user: string } {
  const delta = Math.abs(args.targetWords - args.actualWords);
  const verb = args.needsExpansion ? "ADD approximately " : "REMOVE approximately ";
  const how = args.needsExpansion
    ? "Add additional examples, clearer explanations, elaboration on implications, and bridging sentences. No filler — every addition must be substantive."
    : "Remove weaker examples, redundancy, and verbose phrasings. Preserve all key claims.";

  const system = `You are revising your previous output to hit a word count target.`;
  const user = `Previous output was ${args.actualWords} words. Target is ${args.minWords}–${args.maxWords} words (~${args.targetWords}).
You need to ${verb}${delta} words.

${how}

PREVIOUS OUTPUT:
${args.previousOutput}

Return ONLY the revised text. No commentary, no markers.`;
  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 3: Stitch / coherence audit
// ─────────────────────────────────────────────────────────────────────────────

async function stitchPass(
  skeleton: GlobalSkeleton,
  deltas: { index: number; delta: ChunkDelta; words: number }[],
  signal?: AbortSignal
): Promise<{ conflictsFound: string[]; repairPlan: string[]; summary: string }> {
  const system = `You audit a set of processed chunks for cross-chunk coherence.
Review the delta reports against the global skeleton. Identify:
1. CONTRADICTIONS between chunks or with the skeleton
2. TERM DRIFT (key terms used inconsistently)
3. REDUNDANCIES (multiple chunks making the same point unnecessarily)
4. GAPS (skeleton commitments absent from the chunks)

Return EXACT JSON: {"conflicts_found": ["..."], "repair_plan": ["..."], "summary": "one paragraph"}`;

  const user = `GLOBAL SKELETON:
${buildSkeletonContext(skeleton)}

CHUNK DELTA REPORTS (${deltas.length} chunks):
${deltas.map(d => `Chunk ${d.index + 1} (${d.words} words):
  new_claims: ${d.delta.newClaims.join("; ") || "(none)"}
  terms_used: ${d.delta.termsUsed.join("; ") || "(none)"}
  conflicts:  ${d.delta.conflicts.join("; ") || "(none)"}`).join("\n\n")}

Return ONLY the JSON object.`;

  try {
    const raw = await callLLM(system, user, { json: true, maxTokens: 2000, temperature: 0.3, signal });
    const parsed = safeJson(raw);
    return {
      conflictsFound: Array.isArray(parsed.conflicts_found) ? parsed.conflicts_found.map(String) : [],
      repairPlan: Array.isArray(parsed.repair_plan) ? parsed.repair_plan.map(String) : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "Stitch audit completed.",
    };
  } catch (err) {
    return {
      conflictsFound: [],
      repairPlan: [],
      summary: `Stitch audit failed: ${(err as Error).message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1: Initialize job (split, compute length, create rows)
// ─────────────────────────────────────────────────────────────────────────────

async function initializeJob(req: ReconstructionRequest): Promise<string> {
  const totalInputWords = countWords(req.originalText);
  const { targetMin, targetMax } = parseTargetLength(req.customInstructions || "", totalInputWords);
  const targetMid = Math.floor((targetMin + targetMax) / 2);
  const lengthRatio = targetMid / Math.max(totalInputWords, 1);
  const lengthMode = getLengthMode(lengthRatio);

  const chunks = splitIntoChunks(req.originalText, INPUT_CHUNK_WORDS);
  const numChunks = chunks.length;
  const chunkTargetWords = Math.ceil(targetMid / Math.max(numChunks, 1));

  const [job] = await db.insert(reconstructionJobs).values({
    userId: req.userId || null,
    status: "pending",
    originalText: req.originalText,
    customInstructions: req.customInstructions || "",
    totalInputWords,
    targetMinWords: targetMin,
    targetMaxWords: targetMax,
    targetMidWords: targetMid,
    lengthRatio: lengthRatio.toFixed(4),
    lengthMode,
    numChunks,
    chunkTargetWords,
    currentChunk: 0,
  }).returning({ id: reconstructionJobs.id });

  const jobId = job.id;

  // Insert chunk rows
  const chunkRows = chunks.map((text, i) => {
    const chunkInputWords = countWords(text);
    const target = Math.max(20, Math.ceil(chunkInputWords * lengthRatio));
    return {
      jobId,
      chunkIndex: i,
      status: "pending" as const,
      chunkInputText: text,
      chunkInputWords,
      targetWords: target,
      minWords: Math.max(10, Math.floor(target * 0.85)),
      maxWords: Math.ceil(target * 1.15),
      retryCount: 0,
    };
  });

  // Batch insert in groups of 100 to avoid oversized statements
  for (let i = 0; i < chunkRows.length; i += 100) {
    await db.insert(reconstructionChunks).values(chunkRows.slice(i, i + 100));
  }

  return jobId;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATION
// ─────────────────────────────────────────────────────────────────────────────

export async function* runReconstruction(
  req: ReconstructionRequest
): AsyncGenerator<ReconstructionEvent> {
  let jobId: string | null = null;
  const startTs = Date.now();

  try {
    // ─── PHASE 1: Init ──────────────────────────────────────────────────────
    yield { type: "status", data: "Initializing job — counting words, planning chunks..." };
    jobId = await initializeJob(req);
    const [job] = await db.select().from(reconstructionJobs).where(eq(reconstructionJobs.id, jobId));
    yield {
      type: "job_init",
      data: {
        jobId,
        totalInputWords: job.totalInputWords,
        targetMinWords: job.targetMinWords,
        targetMaxWords: job.targetMaxWords,
        lengthMode: job.lengthMode,
        lengthRatio: parseFloat(job.lengthRatio),
        numChunks: job.numChunks,
        chunkTargetWords: job.chunkTargetWords,
      },
    };

    yield* runJob(jobId, req.signal);
  } catch (err) {
    if (err instanceof AbortError || req.signal?.aborted) {
      if (jobId) {
        await db.update(reconstructionJobs)
          .set({ status: "failed", errorMessage: "Aborted by client", updatedAt: new Date() })
          .where(eq(reconstructionJobs.id, jobId));
      }
      yield { type: "error", data: "Aborted." };
      return;
    }
    if (jobId) {
      await db.update(reconstructionJobs)
        .set({ status: "failed", errorMessage: (err as Error).message, updatedAt: new Date() })
        .where(eq(reconstructionJobs.id, jobId));
    }
    yield { type: "error", data: `Reconstruction failed: ${(err as Error).message}` };
  }
}

// Run (or resume) all phases of an existing job.
export async function* runJob(
  jobId: string,
  signal?: AbortSignal
): AsyncGenerator<ReconstructionEvent> {
  const [job] = await db.select().from(reconstructionJobs).where(eq(reconstructionJobs.id, jobId));
  if (!job) throw new Error(`Job ${jobId} not found`);

  // ─── PHASE 2: Skeleton ────────────────────────────────────────────────────
  let skeleton: GlobalSkeleton;
  if (!job.globalSkeleton || job.status === "pending") {
    yield { type: "status", data: "PASS 1: Extracting global skeleton..." };
    await db.update(reconstructionJobs)
      .set({ status: "skeleton_extraction", updatedAt: new Date() })
      .where(eq(reconstructionJobs.id, jobId));

    skeleton = await extractSkeleton(job.originalText, signal);
    await db.update(reconstructionJobs)
      .set({ globalSkeleton: skeleton as any, updatedAt: new Date() })
      .where(eq(reconstructionJobs.id, jobId));

    yield { type: "skeleton", data: skeleton };
    await sleep(1500, signal);
  } else {
    skeleton = job.globalSkeleton as GlobalSkeleton;
    yield { type: "skeleton", data: skeleton };
  }

  // ─── PHASE 3: Chunk-by-chunk processing ───────────────────────────────────
  yield { type: "status", data: `PASS 2: Processing ${job.numChunks} chunks (${job.lengthMode})...` };
  await db.update(reconstructionJobs)
    .set({ status: "chunk_processing", updatedAt: new Date() })
    .where(eq(reconstructionJobs.id, jobId));

  const lengthGuidance = getLengthGuidance(job.lengthMode as LengthMode);

  // Reclaim stale chunks: stuck `processing` (orphaned by abort/crash) and
  // `failed` chunks that haven't exceeded retry budget. Allows resume to make progress.
  await db.update(reconstructionChunks)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(
      eq(reconstructionChunks.jobId, jobId),
      sql`${reconstructionChunks.status} IN ('processing','failed')`,
    ));

  // Process each pending chunk strictly sequentially. Already-complete chunks
  // (from a prior resume) are skipped automatically.
  while (true) {
    checkAbort(signal);

    // Atomic claim: only one caller wins. Returns the claimed chunk row or none.
    const claimed = await db.execute<typeof reconstructionChunks.$inferSelect>(sql`
      UPDATE reconstruction_chunks
      SET status = 'processing', updated_at = now()
      WHERE id = (
        SELECT id FROM reconstruction_chunks
        WHERE job_id = ${jobId} AND status = 'pending'
        ORDER BY chunk_index ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    const rows = (claimed as any).rows ?? (claimed as any);
    if (!rows || rows.length === 0) break;
    const raw0 = rows[0];
    // Normalize snake_case → camelCase fields we use below.
    const chunk = {
      id: raw0.id,
      chunkIndex: raw0.chunk_index ?? raw0.chunkIndex,
      chunkInputText: raw0.chunk_input_text ?? raw0.chunkInputText,
      chunkInputWords: raw0.chunk_input_words ?? raw0.chunkInputWords,
      targetWords: raw0.target_words ?? raw0.targetWords,
      minWords: raw0.min_words ?? raw0.minWords,
      maxWords: raw0.max_words ?? raw0.maxWords,
      retryCount: raw0.retry_count ?? raw0.retryCount ?? 0,
    } as any;

    yield {
      type: "chunk_start",
      data: {
        index: chunk.chunkIndex,
        total: job.numChunks,
        inputWords: chunk.chunkInputWords,
        targetWords: chunk.targetWords,
        minWords: chunk.minWords,
        maxWords: chunk.maxWords,
      },
    };

    try {
      const { system, user } = buildChunkPrompt({
        chunkText: chunk.chunkInputText,
        chunkIndex: chunk.chunkIndex,
        totalChunks: job.numChunks,
        chunkInputWords: chunk.chunkInputWords,
        targetWords: chunk.targetWords,
        minWords: chunk.minWords,
        maxWords: chunk.maxWords,
        lengthGuidance,
        skeleton,
        customInstructions: job.customInstructions || "",
      });

      const maxTokens = Math.min(8000, Math.ceil(chunk.maxWords * 2) + 500);
      const raw = await callLLM(system, user, { maxTokens, temperature: 0.5, signal });
      let { processed, delta } = parseChunkResponse(raw);
      let actualWords = countWords(processed);

      console.log(`[reconstruction] Chunk ${chunk.chunkIndex + 1}/${job.numChunks}: target=${chunk.targetWords}, actual=${actualWords}`);

      // Retry once if dramatically out of range
      const tooShort = actualWords < chunk.minWords * 0.8;
      const tooLong = actualWords > chunk.maxWords * 1.2;
      if ((tooShort || tooLong) && (chunk.retryCount ?? 0) < 1) {
        yield {
          type: "chunk_retry",
          data: { index: chunk.chunkIndex, actualWords, reason: tooShort ? "too_short" : "too_long" },
        };
        await sleep(1500, signal);
        const retryPrompts = buildRetryPrompt({
          previousOutput: processed,
          actualWords,
          targetWords: chunk.targetWords,
          minWords: chunk.minWords,
          maxWords: chunk.maxWords,
          needsExpansion: tooShort,
        });
        const retryRaw = await callLLM(retryPrompts.system, retryPrompts.user, {
          maxTokens,
          temperature: 0.5,
          signal,
        });
        processed = retryRaw.trim();
        actualWords = countWords(processed);
        await db.update(reconstructionChunks)
          .set({ retryCount: (chunk.retryCount ?? 0) + 1 })
          .where(eq(reconstructionChunks.id, chunk.id));
      }

      await db.update(reconstructionChunks).set({
        status: "complete",
        chunkOutputText: processed,
        actualWords,
        chunkDelta: delta as any,
        updatedAt: new Date(),
      }).where(eq(reconstructionChunks.id, chunk.id));

      await db.update(reconstructionJobs)
        .set({ currentChunk: chunk.chunkIndex + 1, updatedAt: new Date() })
        .where(eq(reconstructionJobs.id, jobId));

      yield {
        type: "chunk_done",
        data: {
          index: chunk.chunkIndex,
          total: job.numChunks,
          actualWords,
          targetWords: chunk.targetWords,
          delta,
          outputText: processed,
        },
      };
    } catch (err) {
      if (err instanceof AbortError || signal?.aborted) {
        // Reset claimed-but-unfinished chunk so resume can pick it up.
        try {
          await db.update(reconstructionChunks)
            .set({ status: "pending", updatedAt: new Date() })
            .where(eq(reconstructionChunks.id, chunk.id));
        } catch {}
        throw err;
      }
      await db.update(reconstructionChunks).set({
        status: "failed",
        errorMessage: (err as Error).message,
        updatedAt: new Date(),
      }).where(eq(reconstructionChunks.id, chunk.id));
      yield { type: "error", data: `Chunk ${chunk.chunkIndex + 1} failed: ${(err as Error).message}` };
      // Continue to next chunk rather than abort entire job.
    }

    await sleep(INTER_CHUNK_DELAY_MS, signal);
  }

  // ─── PHASE 4: Stitch ──────────────────────────────────────────────────────
  yield { type: "status", data: "PASS 3: Stitching — coherence audit..." };
  await db.update(reconstructionJobs)
    .set({ status: "stitching", updatedAt: new Date() })
    .where(eq(reconstructionJobs.id, jobId));

  const completedChunks = await db.select().from(reconstructionChunks)
    .where(and(eq(reconstructionChunks.jobId, jobId), eq(reconstructionChunks.status, "complete")))
    .orderBy(asc(reconstructionChunks.chunkIndex));

  // Guard: do not mark job complete if any chunks are missing. Mark as failed
  // and surface the gap so the caller can resume.
  if (completedChunks.length < job.numChunks) {
    const failedCount = job.numChunks - completedChunks.length;
    await db.update(reconstructionJobs).set({
      status: "failed",
      errorMessage: `Incomplete: ${failedCount}/${job.numChunks} chunks did not complete. Resume to retry.`,
      updatedAt: new Date(),
    }).where(eq(reconstructionJobs.id, jobId));
    yield {
      type: "error",
      data: `Job incomplete: ${failedCount}/${job.numChunks} chunks failed or skipped. Use resume to retry.`,
    };
    return;
  }

  const deltas = completedChunks.map(c => ({
    index: c.chunkIndex,
    delta: (c.chunkDelta as ChunkDelta) || { newClaims: [], termsUsed: [], conflicts: [] },
    words: c.actualWords || 0,
  }));

  const stitchResult = await stitchPass(skeleton, deltas, signal);
  yield { type: "stitch", data: stitchResult };

  // ─── Assemble final output ────────────────────────────────────────────────
  const finalOutput = completedChunks.map(c => c.chunkOutputText || "").join("\n\n");
  const finalWordCount = countWords(finalOutput);

  await db.update(reconstructionJobs).set({
    status: "complete",
    finalOutput,
    finalWordCount,
    stitchReport: stitchResult as any,
    updatedAt: new Date(),
  }).where(eq(reconstructionJobs.id, jobId));

  yield {
    type: "complete",
    data: {
      jobId,
      finalWordCount,
      targetMinWords: job.targetMinWords,
      targetMaxWords: job.targetMaxWords,
      completedChunks: completedChunks.length,
      totalChunks: job.numChunks,
      stitchSummary: stitchResult.summary,
      conflictsFound: stitchResult.conflictsFound.length,
    },
  };
}

// Resume an interrupted job from wherever it left off.
export async function* resumeReconstruction(
  jobId: string,
  signal?: AbortSignal
): AsyncGenerator<ReconstructionEvent> {
  const [job] = await db.select().from(reconstructionJobs).where(eq(reconstructionJobs.id, jobId));
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status === "complete") {
    yield {
      type: "complete",
      data: {
        jobId,
        finalWordCount: job.finalWordCount,
        targetMinWords: job.targetMinWords,
        targetMaxWords: job.targetMaxWords,
        completedChunks: job.numChunks,
        totalChunks: job.numChunks,
        stitchSummary: "Job already complete.",
        conflictsFound: 0,
      },
    };
    return;
  }
  yield { type: "status", data: `Resuming job ${jobId} from status: ${job.status}` };
  yield* runJob(jobId, signal);
}
