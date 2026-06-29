// server/services/longFormGenerator.ts
//
// Two-tier skeleton long-form generation engine (Neurotext-style).
//
// Design overview:
//   - Tier 1 (master skeleton): central thesis, 5-15 logical sections, key
//     terms with stable definitions, commitment ledger (asserts/rejects/
//     assumes), and (for dialogue/debate/interview) a speaker pattern.
//   - Tier 2 (per-section sub-skeleton, only when targetWords >= TIER2_THRESHOLD):
//     each section is expanded into 2-6 chunk plans with sub-thesis, key
//     points, and forbidden repeats (so later chunks cannot restate earlier
//     claims verbatim).
//   - Generation: chunk-by-chunk with a rolling delta state — claims made,
//     phrases used, terms drift — that is injected into each next prompt as
//     an explicit "do not repeat" list.
//   - Stitch: section-level transition smoothing + final repetition sweep.
//
// All modes share the same engine. Mode-specific behaviour is concentrated
// in `getModeSpec`.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { db } from "../db";
import { coherentSessions, coherentChunks, stitchResults } from "../../shared/schema";
import { eq } from "drizzle-orm";

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const OPENAI_MODEL = "gpt-4o";

// Tier 2 (per-section sub-skeletons) only kicks in for big jobs.
const TIER2_THRESHOLD = 8000;
// Soft cap per chunk so individual LLM calls finish reliably.
const MAX_WORDS_PER_CHUNK = 1500;
const MIN_WORDS_PER_CHUNK = 600;
// Pause between chunks to be polite to upstream APIs (kept short).
const INTER_CHUNK_PAUSE_MS = 400;
// Hard ceiling.
const MAX_TARGET_WORDS = 50000;

export type LongFormMode = "paper" | "essay" | "dialogue" | "debate" | "interview";

export interface GroundingMaterial {
  quotes: string[];
  positions: string[];
  arguments: string[];
  chunks: string[];
}

export interface LongFormRequest {
  figureName: string;
  mode: LongFormMode;
  topic: string;
  targetWords: number;
  numberOfQuotes?: number;
  customInstructions?: string;
  // For dialogue / debate / interview: the second voice (philosopher name,
  // "Everyman", "Interviewer", etc.). Ignored for paper / essay.
  otherParticipant?: string;
  primaryMaterial: GroundingMaterial;
  // Used for debate when we want each side grounded in their own corpus.
  secondaryMaterial?: GroundingMaterial;
  // Optional cancellation signal — when aborted (e.g. SSE client disconnect)
  // the generator stops at the next chunk boundary and persists session as
  // "aborted".
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

export interface LongFormEvent {
  type:
    | "status"
    | "skeleton"
    | "section_skeleton"
    | "chunk_start"
    | "content"
    | "chunk_done"
    | "stitch"
    | "complete"
    | "error";
  data?: any;
}

export interface MasterSkeleton {
  mode: LongFormMode;
  thesis: string;
  sections: string[];
  keyTerms: Record<string, string>;
  commitments: { asserts: string[]; rejects: string[]; assumes: string[] };
  forbiddenTopics: string[];
  speakerPattern: string[]; // empty for paper/essay
  totalTargetWords: number;
}

interface SectionSkeleton {
  index: number;
  title: string;
  subThesis: string;
  keyPoints: string[];
  targetWords: number;
  numChunks: number;
  forbiddenRepeats: string[]; // claims already covered in earlier sections
}

interface ChunkPlan {
  globalIndex: number;
  sectionIndex: number;
  chunkInSection: number;
  totalInSection: number;
  position: "first" | "middle" | "final";
  targetWords: number;
  speaker?: string;
}

interface RollingState {
  claimsMade: string[]; // ~one short string per chunk, accumulated
  phrasesUsed: string[]; // notable phrases / openings to avoid repeating
  recentTail: string; // last ~1200 chars for explicit "continue from"
  outputs: string[]; // every chunk's text
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  opts: { json?: boolean; maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const maxTokens = opts.maxTokens ?? 4000;
  const temperature = opts.temperature ?? 0.6;
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
      console.error("[longFormGenerator] Anthropic call failed, trying OpenAI:", (err as Error).message);
      // fall through to OpenAI
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

async function* streamLLM(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature = 0.7,
  signal?: AbortSignal
): AsyncGenerator<string> {
  checkAbort(signal);
  if (anthropic) {
    try {
      const stream = await anthropic.messages.stream(
        {
          model: ANTHROPIC_MODEL,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        },
        signal ? { signal } : undefined
      );
      for await (const evt of stream) {
        checkAbort(signal);
        if (evt.type === "content_block_delta" && evt.delta.type === "text_delta") {
          yield evt.delta.text;
        }
      }
      return;
    } catch (err) {
      if (signal?.aborted) throw new AbortError();
      console.error("[longFormGenerator] Anthropic stream failed, falling back to OpenAI:", (err as Error).message);
    }
  }
  if (openai) {
    const stream = await openai.chat.completions.create(
      {
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: Math.min(maxTokens, 16000),
        temperature,
        stream: true,
      },
      signal ? { signal } : undefined
    );
    for await (const part of stream) {
      checkAbort(signal);
      const c = part.choices[0]?.delta?.content || "";
      if (c) yield c;
    }
    return;
  }
  throw new Error("No AI provider available for streaming.");
}

function safeJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return {};
      }
    }
    return {};
  }
}

// -----------------------------------------------------------------------------
// Mode specifications
// -----------------------------------------------------------------------------

interface ModeSpec {
  outlineGuidance: string;
  styleRules: string;
  speakers: string[]; // empty for monologue modes
  chunkFormatHint: string;
}

function getModeSpec(req: LongFormRequest): ModeSpec {
  const me = req.figureName;
  const other = (req.otherParticipant || "").trim();

  switch (req.mode) {
    case "dialogue":
      return {
        outlineGuidance: `Plan a philosophical dialogue between ${me} and ${other || "Everyman"}. Sections should be conversational beats (Opening exchange, First clarification, Pushback, Reformulation, Synthesis, Closing).`,
        styleRules: `Use the format "${me.toUpperCase()}: ..." and "${(other || "EVERYMAN").toUpperCase()}: ..." for each turn. Each turn 60-180 words. Real back-and-forth — every speaker reacts to the previous turn explicitly. ${me} answers from documented positions; ${other || "Everyman"} probes with common-sense objections and clarifying questions.`,
        speakers: [me, other || "Everyman"],
        chunkFormatHint: `Each chunk contains ~${"3-5"} alternating turns. Always start with a turn from a different speaker than the prior chunk's last turn.`,
      };

    case "debate":
      return {
        outlineGuidance: `Plan an intellectual debate between ${me} and ${other || "Opponent"}. Sections: Opening statements, Exchange 1 (core disagreement), Exchange 2 (deeper objection), Exchange 3 (reformulation), Cross-examination, Closing statements.`,
        styleRules: `Use "${me.toUpperCase()}: ..." and "${(other || "OPPONENT").toUpperCase()}: ...". Each speaker addresses the OTHER directly using "you" — not third person. Cross-reference the opponent's prior points. Equal time for both sides. No straw-manning.`,
        speakers: [me, other || "Opponent"],
        chunkFormatHint: `Each chunk = a single back-and-forth round (one turn per speaker, ~400-700 words each). Bridge to opponent's last claim explicitly.`,
      };

    case "interview":
      return {
        outlineGuidance: `Plan a deep interview with ${me}. Sections: Opening question, Core philosophy, Key concepts, Hard objections, Practical implications, Closing reflection.`,
        styleRules: `Use "INTERVIEWER: ..." and "${me.toUpperCase()}: ...". INTERVIEWER asks pointed, escalating questions (not softballs). ${me} answers in first person grounded in documented positions. 2-4 Q&A pairs per chunk.`,
        speakers: ["Interviewer", me],
        chunkFormatHint: `Each chunk = 2-4 question/answer pairs. Questions should build on the previous answer.`,
      };

    case "essay":
      return {
        outlineGuidance: `Plan a tight first-person essay by ${me}. Sections: thesis, primary argument, secondary argument, anticipated objection + reply, illustrative case, broader implication, closing.`,
        styleRules: `First person ("I argue...", "My view is..."). Short paragraphs (2-4 sentences). No throat-clearing, no "this essay will...". Open with the thesis in the first sentence. No hedging. Concrete examples.`,
        speakers: [],
        chunkFormatHint: `Each chunk continues directly from the previous paragraph, no section headers.`,
      };

    case "paper":
    default:
      return {
        outlineGuidance: `Plan a rigorous philosophical paper authored by ${me} in first person. Sections: thesis statement, key distinctions, primary argument, secondary argument(s), objections and replies, implications, conclusion.`,
        styleRules: `First person ("I argue...", "My view is..."). Short paragraphs. Decisive (no hedging). Use exact key terms as defined. Cite no sources you weren't given. State the thesis in the first sentence.`,
        speakers: [],
        chunkFormatHint: `Each chunk continues directly from the previous paragraph. Do not restate the thesis in every chunk.`,
      };
  }
}

// -----------------------------------------------------------------------------
// Tier 1: Master skeleton
// -----------------------------------------------------------------------------

function compactGrounding(material: GroundingMaterial, charBudget: number): string {
  const parts: string[] = [];
  if (material.positions.length) parts.push("POSITIONS:\n" + material.positions.slice(0, 12).join("\n"));
  if (material.arguments.length) parts.push("ARGUMENTS:\n" + material.arguments.slice(0, 8).join("\n"));
  if (material.quotes.length) parts.push("QUOTES:\n" + material.quotes.slice(0, 12).join("\n"));
  if (material.chunks.length) parts.push("PASSAGES:\n" + material.chunks.slice(0, 8).join("\n\n"));
  return parts.join("\n\n").slice(0, charBudget);
}

async function extractMasterSkeleton(req: LongFormRequest): Promise<MasterSkeleton> {
  const spec = getModeSpec(req);

  // Section count scales with target. Floor of MIN_WORDS_PER_CHUNK keeps the
  // chunk generator from over-running tiny targets — if target / 1200 < 2,
  // we plan a small number of sections so per-section words >= MIN per chunk.
  const targetSections = clamp(
    Math.max(2, Math.floor(req.targetWords / Math.max(MIN_WORDS_PER_CHUNK, 1200))),
    2,
    15
  );

  const grounding = compactGrounding(req.primaryMaterial, 9000);
  const secondary =
    req.secondaryMaterial && (req.mode === "debate" || req.mode === "dialogue")
      ? `\n\n=== ${(req.otherParticipant || "OTHER").toUpperCase()} MATERIAL ===\n${compactGrounding(req.secondaryMaterial, 5000)}`
      : "";

  const system = `You are planning a long-form ${req.mode} authored by ${req.figureName}.
Use ONLY the provided grounding material. Do not invent unsupported positions.

${spec.outlineGuidance}

Return EXACT JSON only with this shape:
{
  "thesis": "One sentence central claim or driving question.",
  "sections": ["Section 1 title - one line", "Section 2 title - one line", ...],
  "keyTerms": {"term": "definition as the author uses it", ...},
  "commitments": {
    "asserts": ["specific claims the author commits to"],
    "rejects": ["positions the author rejects"],
    "assumes": ["unstated background assumptions"]
  },
  "forbiddenTopics": ["topics that fall outside scope"],
  "speakerPattern": ${JSON.stringify(spec.speakers)}
}

You MUST produce ${targetSections} sections (one short title per section).`;

  const userPrompt = `MODE: ${req.mode}
TARGET TOTAL WORDS: ${req.targetWords}
${req.otherParticipant ? `OTHER PARTICIPANT: ${req.otherParticipant}` : ""}

TOPIC / PROMPT:
${req.topic}

${req.customInstructions ? `EXTRA INSTRUCTIONS:\n${req.customInstructions}\n` : ""}

=== ${req.figureName.toUpperCase()} MATERIAL ===
${grounding}${secondary}

Plan the structure now. Return ONLY the JSON object.`;

  const raw = await callLLM(system, userPrompt, { json: true, maxTokens: 2500, temperature: 0.4, signal: req.signal });
  const parsed = safeJson(raw);

  const sections: string[] = Array.isArray(parsed.sections) && parsed.sections.length > 0
    ? parsed.sections.map(String)
    : Array.from({ length: targetSections }, (_, i) => `Part ${i + 1}`);

  return {
    mode: req.mode,
    thesis: typeof parsed.thesis === "string" ? parsed.thesis : `A ${req.mode} on: ${req.topic.slice(0, 200)}`,
    sections,
    keyTerms: (parsed.keyTerms && typeof parsed.keyTerms === "object") ? parsed.keyTerms : {},
    commitments: {
      asserts: Array.isArray(parsed.commitments?.asserts) ? parsed.commitments.asserts.map(String) : [],
      rejects: Array.isArray(parsed.commitments?.rejects) ? parsed.commitments.rejects.map(String) : [],
      assumes: Array.isArray(parsed.commitments?.assumes) ? parsed.commitments.assumes.map(String) : [],
    },
    forbiddenTopics: Array.isArray(parsed.forbiddenTopics) ? parsed.forbiddenTopics.map(String) : [],
    speakerPattern: spec.speakers,
    totalTargetWords: req.targetWords,
  };
}

// -----------------------------------------------------------------------------
// Tier 2: Per-section sub-skeleton
// -----------------------------------------------------------------------------

function planChunksForSection(
  sectionIndex: number,
  sectionWords: number,
  speakers: string[],
  chunkInSectionStartSpeaker: number
): { numChunks: number; perChunkWords: number } {
  const numChunks = clamp(Math.ceil(sectionWords / MAX_WORDS_PER_CHUNK), 1, 6);
  const perChunkWords = Math.max(MIN_WORDS_PER_CHUNK, Math.ceil(sectionWords / numChunks));
  return { numChunks, perChunkWords };
}

async function buildSectionSkeleton(
  master: MasterSkeleton,
  sectionIndex: number,
  sectionTitle: string,
  sectionWords: number,
  alreadyCoveredClaims: string[],
  req: LongFormRequest
): Promise<SectionSkeleton> {
  const speakers = master.speakerPattern;
  const { numChunks, perChunkWords } = planChunksForSection(sectionIndex, sectionWords, speakers, sectionIndex);

  // Cheap heuristic skeleton when target is small (skip LLM round-trip).
  if (req.targetWords < TIER2_THRESHOLD) {
    return {
      index: sectionIndex,
      title: sectionTitle,
      subThesis: sectionTitle,
      keyPoints: [],
      targetWords: sectionWords,
      numChunks,
      forbiddenRepeats: alreadyCoveredClaims.slice(-25),
    };
  }

  const system = `You are planning ONE section of a long ${master.mode} authored by ${req.figureName}.
Use ONLY material consistent with the master skeleton.
Return EXACT JSON only:
{
  "subThesis": "What this section uniquely contributes (one sentence).",
  "keyPoints": ["distinct point 1", "distinct point 2", ...]
}
You MUST list ${clamp(numChunks * 2, 3, 10)} distinct key points. None may repeat the "already covered" list.`;

  const userPrompt = `MASTER THESIS: ${master.thesis}
ALL SECTIONS: ${master.sections.map((s, i) => `${i + 1}. ${s}`).join(" | ")}
KEY TERMS: ${Object.entries(master.keyTerms).slice(0, 12).map(([k, v]) => `${k}=${v}`).join("; ")}

ALREADY COVERED (do not repeat):
${alreadyCoveredClaims.slice(-25).map((c, i) => `- ${c}`).join("\n") || "(nothing yet)"}

CURRENT SECTION (${sectionIndex + 1}/${master.sections.length}):
${sectionTitle}

Plan this section's distinctive contribution. Return ONLY JSON.`;

  let parsed: any = {};
  try {
    const raw = await callLLM(system, userPrompt, { json: true, maxTokens: 1200, temperature: 0.4, signal: req.signal });
    parsed = safeJson(raw);
  } catch (err) {
    console.warn(`[longFormGenerator] Section skeleton fallback for section ${sectionIndex}:`, (err as Error).message);
  }

  return {
    index: sectionIndex,
    title: sectionTitle,
    subThesis: typeof parsed.subThesis === "string" ? parsed.subThesis : sectionTitle,
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(String) : [],
    targetWords: sectionWords,
    numChunks,
    forbiddenRepeats: alreadyCoveredClaims.slice(-25),
  };
}

// -----------------------------------------------------------------------------
// Chunk generation
// -----------------------------------------------------------------------------

function pickChunkGrounding(req: LongFormRequest, plan: ChunkPlan): string {
  // Stride through the grounding so different chunks see different material.
  const m = req.primaryMaterial;
  const stride = (arr: string[], take: number): string[] => {
    if (!arr.length) return [];
    const start = (plan.globalIndex * take) % arr.length;
    const out: string[] = [];
    for (let i = 0; i < take; i++) out.push(arr[(start + i) % arr.length]);
    return Array.from(new Set(out));
  };

  const parts: string[] = [];
  const positions = stride(m.positions, 6);
  const quotes = stride(m.quotes, 5);
  const chunks = stride(m.chunks, 3);
  const args = stride(m.arguments, 3);
  if (positions.length) parts.push("POSITIONS:\n" + positions.join("\n"));
  if (args.length) parts.push("ARGUMENTS:\n" + args.join("\n"));
  if (quotes.length) parts.push("QUOTES:\n" + quotes.join("\n"));
  if (chunks.length) parts.push("PASSAGES:\n" + chunks.join("\n\n"));

  // For debate, mix in opponent material when this chunk is the opponent's turn.
  if (req.mode === "debate" && req.secondaryMaterial && plan.speaker && plan.speaker !== req.figureName) {
    const opp = req.secondaryMaterial;
    const oppParts: string[] = [];
    if (opp.positions.length) oppParts.push("OPP POSITIONS:\n" + opp.positions.slice(0, 6).join("\n"));
    if (opp.quotes.length) oppParts.push("OPP QUOTES:\n" + opp.quotes.slice(0, 4).join("\n"));
    if (opp.chunks.length) oppParts.push("OPP PASSAGES:\n" + opp.chunks.slice(0, 2).join("\n\n"));
    if (oppParts.length) parts.unshift(oppParts.join("\n\n"));
  }

  return parts.join("\n\n").slice(0, 6500);
}

async function* generateChunkStream(
  req: LongFormRequest,
  master: MasterSkeleton,
  section: SectionSkeleton,
  plan: ChunkPlan,
  state: RollingState,
  spec: ModeSpec
): AsyncGenerator<string> {
  const grounding = pickChunkGrounding(req, plan);

  const repetitionGuard =
    state.claimsMade.length > 0
      ? `\n\nDO NOT REPEAT THESE CLAIMS (already stated in earlier chunks; build on them, don't restate):\n${state.claimsMade.slice(-30).map((c, i) => `- ${c}`).join("\n")}`
      : "";

  const phraseGuard =
    state.phrasesUsed.length > 0
      ? `\n\nDO NOT OPEN WITH OR REUSE THESE PHRASES VERBATIM:\n${state.phrasesUsed.slice(-15).map((p) => `- "${p}"`).join("\n")}`
      : "";

  const tail =
    state.recentTail.length > 0
      ? `\n\nIMMEDIATELY PRIOR TEXT (continue naturally from this — no recap):\n"...${state.recentTail.slice(-1200)}"`
      : "";

  const positionLabel =
    plan.position === "first"
      ? "OPENING CHUNK — state the thesis in the first sentence."
      : plan.position === "final"
      ? "FINAL CHUNK — synthesize and conclude. Reference the thesis without restating it verbatim."
      : "MIDDLE CHUNK — advance new content. No recap of prior chunks.";

  const speakerInstr = plan.speaker
    ? `\nTHIS CHUNK'S SPEAKER FOCUS: ${plan.speaker.toUpperCase()} (begins this chunk; alternation continues per mode).`
    : "";

  const quoteInstr =
    req.numberOfQuotes && req.numberOfQuotes > 0 && plan.position !== "first"
      ? `\nINCLUDE roughly ${Math.max(1, Math.round(req.numberOfQuotes / Math.max(1, master.sections.length)))} verbatim quote(s) from QUOTES above, integrated naturally.`
      : "";

  const system = `You are ${req.figureName}, generating chunk ${plan.globalIndex + 1} of a long ${master.mode}.

MASTER SKELETON (NEVER VIOLATE):
- THESIS: ${master.thesis}
- KEY TERMS: ${Object.entries(master.keyTerms).slice(0, 10).map(([k, v]) => `${k}=${v}`).join("; ") || "(none)"}
- ASSERTS: ${master.commitments.asserts.slice(0, 8).join("; ") || "(none)"}
- REJECTS: ${master.commitments.rejects.slice(0, 6).join("; ") || "(none)"}
- FORBIDDEN TOPICS: ${master.forbiddenTopics.slice(0, 6).join("; ") || "(none)"}

CURRENT SECTION (${section.index + 1}/${master.sections.length}): ${section.title}
SUB-THESIS: ${section.subThesis}
SECTION KEY POINTS TO COVER (only the ones not yet covered):
${section.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n") || "(use master skeleton)"}

POSITION: ${positionLabel}${speakerInstr}${quoteInstr}

STYLE:
${spec.styleRules}

FORMAT HINT: ${spec.chunkFormatHint}

GROUNDING (your only source — do not invent):
${grounding}
${repetitionGuard}${phraseGuard}${tail}

LENGTH: target ~${plan.targetWords} words for this chunk. Output ONLY the chunk text. No headers, no meta-commentary, no "Chunk N:" prefix.`;

  const userPrompt =
    plan.position === "first"
      ? `Begin the ${master.mode} now. ~${plan.targetWords} words.`
      : `Continue the ${master.mode} with the next ~${plan.targetWords} words. Do NOT recap prior chunks.`;

  const maxTokens = clamp(Math.ceil(plan.targetWords * 1.8) + 400, 1500, 8192);

  for await (const text of streamLLM(system, userPrompt, maxTokens, 0.7, req.signal)) {
    yield text;
  }
}

// -----------------------------------------------------------------------------
// Delta extraction (cheap, regex-based — no extra LLM hop per chunk)
// -----------------------------------------------------------------------------

function extractDelta(chunkText: string): { newClaims: string[]; phrases: string[] } {
  // Pull declarative-looking sentences as "claims" (cheap heuristic).
  const sentences = chunkText
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 220);

  // Heuristic: prefer sentences that look like assertions (start with I/We/The/...).
  const claims = sentences
    .filter((s) => /^(I |We |The |My |This |It |There |No |Yes |First|Second|Third|Therefore|Hence|Thus)/i.test(s))
    .slice(0, 4);

  // Distinctive 4-6 word openings to ban from the next chunk.
  const phrases = sentences.slice(0, 5).map((s) => s.split(/\s+/).slice(0, 6).join(" "));

  return { newClaims: claims, phrases };
}

// -----------------------------------------------------------------------------
// Final stitch / repetition sweep
// -----------------------------------------------------------------------------

async function finalStitch(
  master: MasterSkeleton,
  outputs: string[],
  signal?: AbortSignal
): Promise<{ report: string; conflicts: string[] }> {
  // We do NOT rewrite the entire output (would lose streamed text and balloon
  // tokens). We produce a brief coherence report the client can show.
  if (outputs.length < 2) return { report: "Single-chunk output; no stitch needed.", conflicts: [] };

  const previews = outputs
    .map((o, i) => `--- CHUNK ${i + 1} (head) ---\n${o.slice(0, 600)}\n--- CHUNK ${i + 1} (tail) ---\n${o.slice(-400)}`)
    .join("\n\n")
    .slice(0, 12000);

  const system = `You audit long-form ${master.mode} output for coherence problems.
Return EXACT JSON: {"conflicts": ["..."], "summary": "one-paragraph summary of overall coherence"}.
Look for: (1) restated theses, (2) terminology drift from key terms, (3) contradictions with the commitment ledger, (4) speaker imbalance${master.speakerPattern.length ? ` between ${master.speakerPattern.join(" and ")}` : ""}.`;

  const userPrompt = `MASTER:
THESIS: ${master.thesis}
KEY TERMS: ${Object.keys(master.keyTerms).join(", ")}
ASSERTS: ${master.commitments.asserts.join("; ")}
REJECTS: ${master.commitments.rejects.join("; ")}

CHUNKS:
${previews}

Return ONLY JSON.`;

  try {
    const raw = await callLLM(system, userPrompt, { json: true, maxTokens: 1200, temperature: 0.3, signal });
    const parsed = safeJson(raw);
    return {
      report: typeof parsed.summary === "string" ? parsed.summary : "Coherence audit completed.",
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.map(String) : [],
    };
  } catch (err) {
    console.warn("[longFormGenerator] Stitch audit failed:", (err as Error).message);
    return { report: "Stitch audit failed; output may have minor coherence issues.", conflicts: [] };
  }
}

// -----------------------------------------------------------------------------
// Main entry point
// -----------------------------------------------------------------------------

export async function* generateLongForm(req: LongFormRequest): AsyncGenerator<LongFormEvent> {
  // Basic validation / clamping.
  const targetWords = clamp(Math.round(req.targetWords) || 1500, 500, MAX_TARGET_WORDS);
  req = { ...req, targetWords };

  const startTs = Date.now();
  const spec = getModeSpec(req);

  yield { type: "status", data: `Building master skeleton for ${req.mode} (${targetWords} words)...` };

  // Persist a session row for observability.
  let sessionId: string | null = null;
  try {
    const [s] = await db
      .insert(coherentSessions)
      .values({
        thinker: req.figureName,
        topic: `[${req.mode.toUpperCase()}] ${req.topic.slice(0, 480)}`,
        status: "pending",
        totalChunks: 0,
        completedChunks: 0,
      })
      .returning({ id: coherentSessions.id });
    sessionId = s?.id ?? null;
  } catch (err) {
    console.warn("[longFormGenerator] Could not create session row:", (err as Error).message);
  }

  // State is declared up-front so the `finally` block can persist truthful
  // terminal status no matter where we exit (Tier-1 throw, abort, success).
  const state: RollingState = { claimsMade: [], phrasesUsed: [], recentTail: "", outputs: [] };
  let totalWords = 0;
  let failedChunks = 0;
  let succeededChunks = 0;
  let aborted = false;
  let plannedChunks = 0;
  let stitch: { report: string; conflicts: string[] } = { report: "Not run.", conflicts: [] };

  const persistTerminal = async (status: string) => {
    if (!sessionId) return;
    // Stitch insert and status update run in independent try blocks so a
    // stitch failure never prevents the truthful status from being written.
    if (state.outputs.length > 0) {
      try {
        const fullText = state.outputs.join("\n\n");
        await db.insert(stitchResults).values({
          sessionId,
          stitchedContent: fullText,
          wordCount: countWords(fullText),
          coherenceScore: stitch.conflicts.length === 0 ? 90 : 70,
          metadata: {
            processingTimeMs: Date.now() - startTs,
            chunksUsed: state.outputs.length,
            failedChunks,
            terminalStatus: status,
            model: anthropic ? ANTHROPIC_MODEL : OPENAI_MODEL,
          } as any,
        });
      } catch (err) {
        console.warn("[longFormGenerator] Stitch persist failed:", (err as Error).message);
      }
    }
    try {
      await db.update(coherentSessions).set({ status }).where(eq(coherentSessions.id, sessionId));
    } catch (err) {
      console.warn("[longFormGenerator] Status persist failed:", (err as Error).message);
    }
  };

  let tier1Failed = false;
  let tier1Error: string | null = null;

  try {
    // ----- Tier 1 -----
    let master: MasterSkeleton;
    try {
      master = await extractMasterSkeleton(req);
    } catch (err) {
      if (err instanceof AbortError || req.signal?.aborted) {
        aborted = true;
      } else {
        tier1Failed = true;
        tier1Error = (err as Error).message;
      }
      yield {
        type: "error",
        data: aborted
          ? "Aborted during skeleton extraction."
          : `Skeleton extraction failed: ${tier1Error}`,
      };
      return;
    }

    yield {
      type: "skeleton",
      data: {
        thesis: master.thesis,
        sectionCount: master.sections.length,
        sections: master.sections,
        keyTermCount: Object.keys(master.keyTerms).length,
        mode: master.mode,
        speakers: master.speakerPattern,
      },
    };

    if (sessionId) {
      try {
        await db
          .update(coherentSessions)
          .set({
            skeleton: {
              thesis: master.thesis,
              sections: master.sections.map((title) => ({ title, keyPoints: [] })),
              conclusion: "",
            } as any,
            status: "skeleton_complete",
          })
          .where(eq(coherentSessions.id, sessionId));
      } catch {}
    }

    // ----- Plan sections -----
    const sectionWordsBase = Math.floor(targetWords / master.sections.length);
    const remainder = targetWords - sectionWordsBase * master.sections.length;

    const sectionSkeletons: SectionSkeleton[] = [];
    const allChunkPlans: ChunkPlan[] = [];
    const claimsCovered: string[] = [];

    for (let si = 0; si < master.sections.length; si++) {
      if (req.signal?.aborted) {
        aborted = true;
        return;
      }
      const sectionWords = sectionWordsBase + (si === master.sections.length - 1 ? remainder : 0);

      yield { type: "status", data: `Tier 2: planning section ${si + 1}/${master.sections.length} (${sectionWords} words)...` };

      let section: SectionSkeleton;
      try {
        section = await buildSectionSkeleton(
          master,
          si,
          master.sections[si],
          sectionWords,
          claimsCovered,
          req
        );
      } catch (err) {
        if (err instanceof AbortError || req.signal?.aborted) {
          aborted = true;
          return;
        }
        throw err;
      }
      sectionSkeletons.push(section);
      claimsCovered.push(...section.keyPoints);

      yield {
        type: "section_skeleton",
        data: { index: si, title: section.title, subThesis: section.subThesis, numChunks: section.numChunks, keyPoints: section.keyPoints },
      };

      const perChunkWords = Math.max(MIN_WORDS_PER_CHUNK, Math.ceil(sectionWords / section.numChunks));
      for (let ci = 0; ci < section.numChunks; ci++) {
        const globalIndex = allChunkPlans.length;
        const speaker = master.speakerPattern.length
          ? master.speakerPattern[globalIndex % master.speakerPattern.length]
          : undefined;

        allChunkPlans.push({
          globalIndex,
          sectionIndex: si,
          chunkInSection: ci,
          totalInSection: section.numChunks,
          position:
            globalIndex === 0
              ? "first"
              : si === master.sections.length - 1 && ci === section.numChunks - 1
              ? "final"
              : "middle",
          targetWords: perChunkWords,
          speaker,
        });
      }
    }

    plannedChunks = allChunkPlans.length;

    if (sessionId) {
      try {
        await db
          .update(coherentSessions)
          .set({ totalChunks: plannedChunks, status: "generating" })
          .where(eq(coherentSessions.id, sessionId));
      } catch {}
    }

    // ----- Generation loop -----
    yield { type: "status", data: `Generating ${plannedChunks} chunks...` };

    for (const plan of allChunkPlans) {
    if (req.signal?.aborted) {
      aborted = true;
      break;
    }
    const section = sectionSkeletons[plan.sectionIndex];

    yield {
      type: "chunk_start",
      data: {
        index: plan.globalIndex,
        section: plan.sectionIndex,
        sectionTitle: section.title,
        targetWords: plan.targetWords,
        speaker: plan.speaker,
      },
    };

    let buf = "";
    try {
      for await (const piece of generateChunkStream(req, master, section, plan, state, spec)) {
        buf += piece;
        yield { type: "content", data: piece };
      }
    } catch (err) {
      if (err instanceof AbortError || req.signal?.aborted) {
        aborted = true;
        break;
      }
      failedChunks++;
      yield { type: "error", data: `Chunk ${plan.globalIndex + 1} failed: ${(err as Error).message}` };
      // Continue to next chunk rather than abort entire job.
      continue;
    }

    state.outputs.push(buf);
    state.recentTail = buf.slice(-1500);
    const delta = extractDelta(buf);
    state.claimsMade.push(...delta.newClaims);
    state.phrasesUsed.push(...delta.phrases);

    const chunkWords = countWords(buf);
    totalWords += chunkWords;
    succeededChunks++;

    if (sessionId) {
      try {
        await db.insert(coherentChunks).values({
          sessionId,
          sectionIndex: plan.sectionIndex,
          chunkIndex: plan.globalIndex,
          content: buf,
          delta: { addedConcepts: delta.newClaims, resolvedTensions: [], bridgesToNext: delta.phrases } as any,
        });
        await db
          .update(coherentSessions)
          .set({ completedChunks: succeededChunks })
          .where(eq(coherentSessions.id, sessionId));
      } catch (err) {
        console.warn("[longFormGenerator] Chunk persist failed:", (err as Error).message);
      }
    }

    yield {
      type: "chunk_done",
      data: {
        index: plan.globalIndex,
        words: chunkWords,
        totalWords,
        targetWords,
        progress: Math.min(1, totalWords / targetWords),
      },
    };

      if (plan.globalIndex < allChunkPlans.length - 1 && !req.signal?.aborted) {
        await new Promise((r) => setTimeout(r, INTER_CHUNK_PAUSE_MS));
      }
    } // end chunk loop

    // ----- Stitch (skipped on abort to fail fast) -----
    if (!aborted && state.outputs.length > 0) {
      stitch = { report: "Stitch skipped.", conflicts: [] };
      yield { type: "status", data: "Final coherence audit..." };
      try {
        stitch = await finalStitch(master, state.outputs, req.signal);
        yield { type: "stitch", data: stitch };
      } catch (err) {
        if (err instanceof AbortError || req.signal?.aborted) {
          aborted = true;
        } else {
          console.warn("[longFormGenerator] Stitch threw:", (err as Error).message);
        }
      }
    } else if (aborted) {
      stitch = { report: "Aborted before stitch.", conflicts: [] };
    }
  } catch (err) {
    // Any unexpected throw during the main pipeline.
    if (err instanceof AbortError || req.signal?.aborted) {
      aborted = true;
    } else {
      tier1Failed = tier1Failed || succeededChunks === 0;
      tier1Error = tier1Error || (err as Error).message;
      yield { type: "error", data: `Generator pipeline error: ${(err as Error).message}` };
    }
  } finally {
    // Decide truthful terminal status — runs on EVERY exit path including
    // Tier-1 throw, abort during planning, and normal completion.
    const terminalStatus = aborted
      ? "aborted"
      : succeededChunks === 0
      ? "failed"
      : failedChunks > 0 || (plannedChunks > 0 && succeededChunks < plannedChunks)
      ? "partial"
      : "completed";

    await persistTerminal(terminalStatus);

    yield {
      type: "complete",
      data: {
        sessionId,
        status: terminalStatus,
        failedChunks,
        succeededChunks,
        plannedChunks,
        totalWords,
        targetWords,
        chunks: state.outputs.length,
        durationMs: Date.now() - startTs,
        conflicts: stitch.conflicts,
        ...(tier1Error ? { error: tier1Error } : {}),
      },
    };
  }
}
