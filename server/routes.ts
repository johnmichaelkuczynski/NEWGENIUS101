import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { z } from "zod";
import { setupAuth, isAdmin } from "./auth";
import { hasHighestTierAccess, isPermanentOwner } from "./access-control";
import { createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from "./api-keys";
import { isParadoxQuery, searchParadoxes, formatParadoxesContext } from "./paradoxes-client";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { buildSystemPrompt, intensityToTemperature, buildIntensityGuidance } from "./prompt-builder";
import { findRelevantVerse } from "./bible-verses";
import { findRelevantChunks, searchPhilosophicalChunks, searchTextChunks, searchPositions, searchArgumentStatements, getArgumentsForThinker, getSourceChunkNeighborhoods, normalizeAuthorName, type StructuredChunk, type StructuredPosition } from "./vector-search";
import {
  insertPersonaSettingsSchema,
  insertGoalSchema,
  thinkerQuotes,
  positions,
  argumentStatements,
  insertArgumentStatementSchema,
  uniqueVisitors,
  anonUsage,
} from "@shared/schema";
import { db, pool } from "./db";
import { eq, ilike, sql } from "drizzle-orm";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { verifyZhiAuth } from "./internal-auth";
import { verifyAristotleApiKey } from "./aristotle-api-key";
import { verifyDarwinApiKey } from "./darwin-api-key";
import { verifyPlatoApiKey } from "./plato-api-key";
import { verifySartreApiKey } from "./sartre-api-key";
import { verifyNietzscheApiKey } from "./nietzsche-api-key";
import { verifyEmmaGoldmanApiKey } from "./emma-goldman-api-key";
import { verifyAdamSmithApiKey } from "./adam-smith-api-key";
import { verifyConfuciusApiKey } from "./confucius-api-key";
import { verifyRussellApiKey } from "./russell-api-key";
import { verifyMardenApiKey } from "./marden-api-key";
import { verifyGardnerApiKey } from "./gardner-api-key";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import * as mammoth from "mammoth";
import { authorAssetsCache } from "./author-assets-cache";
import { auditedCorpusSearch, generateAuditReport, buildPromptFromAuditResult, type AuditEvent, type AuditedSearchResult } from "./audited-search";
import { philosopherCoherenceService } from "./PhilosopherCoherenceService";
import { processDocumentCoherently, rewriteForCoherence, readCoherenceState } from './services/coherence';
import { v4 as uuidv4 } from 'uuid';
import { 
  extractGlobalSkeleton, 
  initializeReconstructionJob, 
  updateJobSkeleton,
  createChunkRecords,
  processChunkWithSkeleton,
  updateChunkResult,
  performGlobalStitch,
  assembleOutput,
  splitIntoChunks,
  type GlobalSkeleton 
} from './services/semanticSkeleton';
import {
  generateLongForm,
  type LongFormMode,
  type GroundingMaterial,
} from './services/longFormGenerator';
import {
  runReconstruction,
  resumeReconstruction,
} from './services/reconstructionEngine';
import { prepareSourceQuotation } from "./services/paperQuotation";

// Get __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Wrapper around pdf-parse v2 (class-based API) to preserve the legacy call style
async function pdfParse(buffer: Buffer): Promise<{ text: string }> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return { text: result.text };
  } finally {
    await parser.destroy();
  }
}

// NOTE: Papers are now stored in vector database
// RAG system retrieves only relevant chunks (see vector-search.ts)

// Helper function to verify quotes against source papers
function verifyQuotes(text: string, sourcePapers: string): { verified: number; total: number; fabricated: string[] } {
  // Extract ALL quotes (removed minimum length requirement per architect feedback)
  const quoteMatches = text.match(/"([^"]+)"/g) || [];
  const quotes = quoteMatches.map(q => q.slice(1, -1)); // Remove quote marks
  
  const fabricatedQuotes: string[] = [];
  let verifiedCount = 0;
  
  // Comprehensive normalization function
  function normalize(str: string): string {
    return str
      .replace(/\s+/g, ' ')              // Normalize whitespace
      .replace(/[—–−]/g, '-')            // Em-dash, en-dash, minus → hyphen
      .replace(/\s*-\s*/g, ' - ')        // Normalize spaces around hyphens
      .replace(/[""]/g, '"')             // Smart quotes → standard quotes
      .replace(/['']/g, "'")             // Smart apostrophes → standard
      .replace(/[…]/g, '...')            // Ellipsis → three dots
      .replace(/[•·]/g, '*')             // Bullets → asterisk
      .replace(/\.{2,}/g, '')            // Remove ellipses (per architect: breaks matching)
      .replace(/\s+/g, ' ')              // Normalize whitespace again (after hyphen fix)
      .trim()
      .toLowerCase();
  }
  
  const normalizedPapers = normalize(sourcePapers);
  
  for (const quote of quotes) {
    // Skip very short quotes (< 10 chars) - likely not substantive philosophical quotes
    if (quote.trim().length < 10) continue;
    
    const normalizedQuote = normalize(quote);
    
    // Check for exact match
    if (normalizedPapers.includes(normalizedQuote)) {
      verifiedCount++;
      continue;
    }
    
    // Check for 70% match (in case of minor variations)
    const words = normalizedQuote.split(' ');
    if (words.length >= 3) { // Lowered from 5 to 3 for shorter quotes
      const chunkSize = Math.max(3, Math.floor(words.length * 0.7)); // Lowered from 5 to 3
      let found = false;
      
      for (let i = 0; i <= words.length - chunkSize; i++) {
        const chunk = words.slice(i, i + chunkSize).join(' ');
        if (normalizedPapers.includes(chunk)) {
          found = true;
          verifiedCount++;
          break;
        }
      }
      
      if (!found) {
        fabricatedQuotes.push(quote.substring(0, 100));
      }
    } else {
      // Very short quotes (< 3 words) - must match exactly
      fabricatedQuotes.push(quote.substring(0, 100));
    }
  }
  
  return {
    verified: verifiedCount,
    total: quotes.length,
    fabricated: fabricatedQuotes,
  };
}

// Initialize AI clients
const openai = process.env.OPENAI_API_KEY ? new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
}) : null;

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
}) : null;

// Evaluate a chunk of text for coherence - uses whatever AI is available
async function evaluateChunkForCoherence(
  chunkText: string,
  previousContext: string,
  figureName: string
): Promise<{ status: string; violations: string[] }> {
  const prompt = `Evaluate this chunk for coherence with prior context.

AUTHOR: ${figureName}
PREVIOUS CONTEXT (last 500 chars): ${previousContext.slice(-500)}
CHUNK TO EVALUATE: ${chunkText.slice(0, 1500)}

Check for:
1. Logical consistency
2. Voice consistency with ${figureName}
3. No contradictions or abrupt shifts
4. Proper flow

Respond JSON only:
{"status":"coherent"|"minor_issues"|"needs_revision","violations":["list issues or empty"]}`;

  try {
    if (anthropic) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '{}';
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return { status: parsed.status || 'coherent', violations: parsed.violations || [] };
      }
    } else if (openai) {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
      });
      const text = response.choices[0]?.message?.content || '{}';
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return { status: parsed.status || 'coherent', violations: parsed.violations || [] };
      }
    }
  } catch (e) {
    console.error('[evaluateChunkForCoherence] Error:', e);
  }
  return { status: 'coherent', violations: [] };
}

// Model configuration for fallback ordering
const MODEL_CONFIG: Record<string, { provider: string; model: string }> = {
  deepseek: { provider: "deepseek", model: "deepseek-chat" },
  openai: { provider: "openai", model: "gpt-4o" },
  anthropic: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
  perplexity: { provider: "perplexity", model: "sonar" },
  grok: { provider: "grok", model: "grok-3" },
  venice: { provider: "venice", model: "llama-3.3-70b" },
  // Legacy mappings for backward compatibility
  zhi1: { provider: "openai", model: "gpt-4o" },
  zhi2: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
  zhi3: { provider: "deepseek", model: "deepseek-chat" },
  zhi4: { provider: "perplexity", model: "sonar" },
  zhi5: { provider: "grok", model: "grok-3" },
  zhi6: { provider: "venice", model: "llama-3.3-70b" },
};

// Fallback order: if one fails, try next in sequence (DeepSeek first)
const FALLBACK_ORDER = ["deepseek", "openai", "grok", "anthropic", "perplexity", "venice"];

// Get fallback models starting from a given model
function getFallbackModels(startModel: string): string[] {
  const startIndex = FALLBACK_ORDER.indexOf(startModel);
  if (startIndex === -1) return FALLBACK_ORDER;
  
  // Return models starting from startModel, then wrap around
  const fallbacks = [
    ...FALLBACK_ORDER.slice(startIndex),
    ...FALLBACK_ORDER.slice(0, startIndex)
  ];
  return fallbacks;
}

// Check if a provider's API key is available
function isProviderAvailable(provider: string): boolean {
  switch (provider) {
    case "openai": return !!process.env.OPENAI_API_KEY;
    case "anthropic": return !!process.env.ANTHROPIC_API_KEY;
    case "deepseek": return !!process.env.DEEPSEEK_API_KEY;
    case "perplexity": return !!process.env.PERPLEXITY_API_KEY;
    case "grok": return !!process.env.GROK_API_KEY;
    case "venice": return !!process.env.VENICE_API_KEY;
    default: return false;
  }
}

// Get OpenAI-compatible client for a provider
function getOpenAIClient(provider: string): OpenAI | null {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
    case "deepseek":
      return process.env.DEEPSEEK_API_KEY ? new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/v1",
      }) : null;
    case "perplexity":
      return process.env.PERPLEXITY_API_KEY ? new OpenAI({
        apiKey: process.env.PERPLEXITY_API_KEY,
        baseURL: "https://api.perplexity.ai",
      }) : null;
    case "grok":
      return process.env.GROK_API_KEY ? new OpenAI({
        apiKey: process.env.GROK_API_KEY,
        baseURL: "https://api.x.ai/v1",
      }) : null;
    case "venice":
      return process.env.VENICE_API_KEY ? new OpenAI({
        apiKey: process.env.VENICE_API_KEY,
        baseURL: "https://api.venice.ai/api/v1",
      }) : null;
    default:
      return null;
  }
}

// -------------------------------------------------------------------
// Provider-agnostic helpers for dialogue / interview generators.
// Always tries DeepSeek first (less restrictive content policy),
// then OpenAI, then Claude as a last resort.
// -------------------------------------------------------------------
const GENERATION_PROVIDER_ORDER = ["deepseek", "openai", "anthropic", "grok", "venice"];

/** Non-streaming: call an LLM and return the full response text. */
async function callLLMPlan(system: string, user: string, maxTokens: number, temperature = 0.5): Promise<string> {
  const providers = GENERATION_PROVIDER_ORDER.filter(isProviderAvailable);
  if (providers.length === 0) throw new Error("No AI provider configured");
  let lastErr: any;
  for (const provider of providers) {
    try {
      if (provider === "anthropic" && anthropic) {
        const r = await anthropic.messages.create({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: maxTokens,
          temperature,
          system,
          messages: [{ role: "user", content: user }],
        });
        return r.content[0]?.type === "text" ? r.content[0].text : "";
      }
      const client = getOpenAIClient(provider);
      if (!client) continue;
      const model = MODEL_CONFIG[provider]?.model ?? "deepseek-chat";
      const r = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      });
      return r.choices[0]?.message?.content ?? "";
    } catch (err) {
      console.warn(`[callLLMPlan] ${provider} failed:`, (err as Error).message);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("All providers failed");
}

/** Streaming: yields text delta strings; tries DeepSeek → OpenAI → Claude. */
async function* streamLLMText(
  system: string,
  user: string,
  maxTokens: number,
  temperature = 0.7
): AsyncGenerator<string> {
  const providers = GENERATION_PROVIDER_ORDER.filter(isProviderAvailable);
  if (providers.length === 0) throw new Error("No AI provider configured");
  let lastErr: any;
  for (const provider of providers) {
    try {
      if (provider === "anthropic" && anthropic) {
        const stream = await anthropic.messages.stream({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: maxTokens,
          temperature,
          system,
          messages: [{ role: "user", content: user }],
        });
        let gotContent = false;
        for await (const chunk of stream) {
          if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
            const t = chunk.delta.text;
            if (t) {
              gotContent = true;
              yield t;
            }
          }
        }
        if (gotContent) return;
        console.warn(`[streamLLMText] ${provider} produced no content, trying next provider`);
        continue;
      }

      const client = getOpenAIClient(provider);
      if (!client) continue;
      const model = MODEL_CONFIG[provider]?.model ?? "deepseek-chat";
      const stream = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      });
      let gotContent = false;
      for await (const chunk of stream) {
        const t = chunk.choices[0]?.delta?.content ?? "";
        if (t) { gotContent = true; yield t; }
      }
      if (gotContent) return;
      console.warn(`[streamLLMText] ${provider} produced no content, trying next provider`);
    } catch (err) {
      console.warn(`[streamLLMText] ${provider} failed:`, (err as Error).message);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("All providers failed");
}
// -------------------------------------------------------------------

// Stream a completion with automatic provider fallback.
// Tries each available provider in FALLBACK_ORDER (starting at startProvider).
// If a provider errors BEFORE producing any text, it transparently moves to the
// next provider. Streams text deltas as SSE `content` events and returns the full text.
async function streamWithFallback(opts: {
  res: any;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature?: number;
  startProvider?: string;
  onContent?: (text: string) => void;
  emitContent?: boolean;
}): Promise<string> {
  const {
    res,
    systemPrompt,
    userPrompt,
    maxTokens,
    temperature = 0.7,
    startProvider = "anthropic",
    onContent,
    emitContent = true,
  } = opts;
  const order = getFallbackModels(startProvider).filter(isProviderAvailable);
  if (order.length === 0) throw new Error("No AI provider configured");

  let lastErr: any = null;
  for (const provider of order) {
    let acc = "";
    try {
      if (provider === "anthropic") {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
        const stream = await client.messages.stream({
          model: MODEL_CONFIG.anthropic.model,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        });
        for await (const chunk of stream) {
          if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
            const c = chunk.delta.text;
            acc += c;
            onContent?.(c);
            if (emitContent) {
              res.write(`data: ${JSON.stringify({ content: c })}\n\n`);
              res.flush?.();
            }
          }
        }
      } else {
        const client = getOpenAIClient(provider);
        if (!client) continue;
        const model = MODEL_CONFIG[provider]?.model;
        if (!model) continue;
        const stream = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: maxTokens,
          temperature,
          stream: true,
        });
        for await (const chunk of stream) {
          const c = chunk.choices[0]?.delta?.content || "";
          if (c) {
            acc += c;
            onContent?.(c);
              if (emitContent) {
                res.write(`data: ${JSON.stringify({ content: c })}\n\n`);
                res.flush?.();
              }
          }
        }
      }

      if (acc.trim().length > 0) {
        if (provider !== startProvider) {
          console.log(`[streamWithFallback] succeeded on fallback provider: ${provider}`);
        }
        return acc;
      }
      lastErr = new Error(`Provider ${provider} returned empty response`);
      console.warn(`[streamWithFallback] ${provider} returned empty, trying next provider`);
    } catch (err) {
      lastErr = err;
      // If we already streamed partial text, don't retry (would duplicate output).
      if (acc.trim().length > 0) {
        console.error(`[streamWithFallback] ${provider} failed mid-stream, returning partial:`, (err as Error).message);
        return acc;
      }
      console.error(`[streamWithFallback] ${provider} failed, trying next provider:`, (err as Error).message);
    }
  }
  throw lastErr || new Error("All AI providers failed");
}

// Helper to get or create session ID and guest user
async function getSessionId(req: any): Promise<string> {
  if (!req.session.userId) {
    req.session.userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    // Create guest user in database to satisfy foreign key constraints
    await storage.upsertUser({
      id: req.session.userId,
      email: `${req.session.userId}@guest.local`,
      firstName: "Guest",
      lastName: "User",
      profileImageUrl: null,
    });
  }
  return req.session.userId;
}

import express from "express";
import path from "path";
import { runSelfTest } from "./services/selfTest";
import { runSyntheticUserTest } from "./services/syntheticUserTest";
import { runAccuracyTest } from "./services/accuracyTest";
import { runThinkerProbeTest } from "./services/thinkerProbeTest";
import {
  runKuczynskiDiagnostic1,
  runKuczynskiDiagnostic2,
  runKuczynskiDiagnostic3,
  runKuczynskiDiagnostic4,
  runKuczynskiDiagnostic5,
  runKuczynskiDiagnostic6,
  runKuczynskiDiagnostic7,
  runKuczynskiDiagnostic8,
  runKuczynskiDiagnostic9,
  runKuczynskiDiagnostic10,
} from "./services/kuczynskiDiagnostic";

export async function registerRoutes(app: Express): Promise<Server> {
  // Validate SESSION_SECRET is set
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET environment variable is required for secure session management");
  }

  // Serve attached_assets folder for avatar images
  app.use('/attached_assets', express.static(path.join(process.cwd(), 'attached_assets')));

  // Sessions + Google OAuth: canonical implementation in server/auth.ts.
  // Guest sessions (getSessionId) ride on the same session middleware.
  setupAuth(app);

  const ANONYMOUS_OPERATION_LIMIT = 4;
  const SIGNED_IN_OPERATION_LIMIT = 17;
  const meteredOperationPaths = [
    /^\/api\/chat\/stream$/,
    /^\/api\/figures\/[^/]+\/chat$/,
    /^\/api\/figures\/[^/]+\/write-paper$/,
    /^\/api\/figures\/[^/]+\/rewrite-paper$/,
    /^\/api\/model-builder$/,
    /^\/api\/quotes\/generate$/,
    /^\/api\/positions\/generate$/,
    /^\/api\/arguments\/generate$/,
    /^\/api\/dialogue-creator$/,
    /^\/api\/interview-creator$/,
    /^\/api\/debate\/generate$/,
    /^\/api\/generate-strict-outline$/,
    /^\/api\/full-document-generator$/,
  ];

  const getUsageState = async (req: any) => {
    const authenticated = !!(req.isAuthenticated?.() && req.user?.id);
    const permanentOwner = authenticated && isPermanentOwner(req.user);
    const identityKey = authenticated
      ? `google:${req.user.id}`
      : `anonymous:${req.sessionID}`;
    const limit = authenticated ? SIGNED_IN_OPERATION_LIMIT : ANONYMOUS_OPERATION_LIMIT;
    const result = await pool.query(
      "SELECT operations_used, full_access FROM operation_usage WHERE identity_key = $1",
      [identityKey],
    );
    const operationsUsed = Number(result.rows[0]?.operations_used || 0);
    const fullAccess = hasHighestTierAccess(
      authenticated ? req.user : null,
      result.rows[0]?.full_access === true,
    );
    return {
      authenticated,
      identityKey,
      operationsUsed,
      remaining: fullAccess ? null : Math.max(0, limit - operationsUsed),
      limit,
      fullAccess,
      permanentOwner,
      tier: permanentOwner ? "owner" : fullAccess ? "full" : authenticated ? "signed_in" : "anonymous",
      unlimitedCredits: fullAccess,
      accessLevel: fullAccess
        ? "full"
        : operationsUsed >= limit
        ? authenticated ? "payment" : "login"
        : "available",
    };
  };

  app.get("/api/usage/status", async (req: any, res) => {
    try {
      res.json(await getUsageState(req));
    } catch {
      const permanentOwner = !!(
        req.isAuthenticated?.()
        && req.user?.id
        && isPermanentOwner(req.user)
      );
      res.json({
        authenticated: !!req.isAuthenticated?.(),
        operationsUsed: 0,
        remaining: permanentOwner
          ? null
          : req.isAuthenticated?.() ? SIGNED_IN_OPERATION_LIMIT : ANONYMOUS_OPERATION_LIMIT,
        limit: req.isAuthenticated?.() ? SIGNED_IN_OPERATION_LIMIT : ANONYMOUS_OPERATION_LIMIT,
        fullAccess: permanentOwner,
        permanentOwner,
        tier: permanentOwner ? "owner" : req.isAuthenticated?.() ? "signed_in" : "anonymous",
        unlimitedCredits: permanentOwner,
        accessLevel: permanentOwner ? "full" : "available",
      });
    }
  });

  const instructionDocumentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
  });

  app.post(
    "/api/documents/extract-text",
    instructionDocumentUpload.single("file"),
    async (req: any, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: "Choose a document to upload." });
        const ext = req.file.originalname.split(".").pop()?.toLowerCase() || "";
        let text = "";
        if (ext === "txt" || ext === "md") {
          text = req.file.buffer.toString("utf8");
        } else if (ext === "pdf") {
          text = (await pdfParse(req.file.buffer)).text;
        } else if (ext === "doc" || ext === "docx") {
          text = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
        } else {
          return res.status(400).json({ error: "Use a TXT, Markdown, PDF, DOC, or DOCX document." });
        }
        if (!text.trim()) return res.status(400).json({ error: "No readable text was found in that document." });
        res.json({ text: text.trim(), filename: req.file.originalname });
      } catch (error) {
        console.error("[Instruction Upload] extraction failed:", error);
        res.status(400).json({ error: "That document could not be read. Try another supported file." });
      }
    },
  );

  app.use(async (req: any, res, next) => {
    if (
      req.method !== "POST"
      || !meteredOperationPaths.some((pattern) => pattern.test(req.path))
      || req.get("x-internal-diagnostic") === process.env.SESSION_SECRET
    ) {
      return next();
    }
    try {
      const state = await getUsageState(req);
      if (state.fullAccess) return next();
      const reservation = await pool.query(
        `INSERT INTO operation_usage (identity_key, operations_used, updated_at)
         VALUES ($1, 1, NOW())
         ON CONFLICT (identity_key) DO UPDATE
         SET operations_used = operation_usage.operations_used + 1, updated_at = NOW()
         WHERE operation_usage.operations_used < $2
         RETURNING operations_used`,
        [state.identityKey, state.limit],
      );
      if (reservation.rowCount) {
        let restored = false;
        res.on("finish", () => {
          if (restored || res.statusCode < 400) return;
          restored = true;
          pool.query(
            `UPDATE operation_usage
             SET operations_used = GREATEST(0, operations_used - 1), updated_at = NOW()
             WHERE identity_key = $1`,
            [state.identityKey],
          ).catch((error) => console.error("[Usage Gate] Could not restore failed operation:", error));
        });
        return next();
      }

      return res.status(200).json({
        accessRequired: state.authenticated ? "payment" : "google_login",
        title: state.authenticated ? "Unlock full access" : "Continue with Google",
        message: state.authenticated
          ? "You have completed your signed-in preview. Full access is available with a subscription."
          : "Your four-operation preview is complete. Continue with Google for seventeen more operations.",
        actionUrl: state.authenticated ? null : "/api/auth/google",
      });
    } catch (error) {
      console.error("[Usage Gate] Continuing after metering problem:", error);
      return next();
    }
  });

  // FREE TIER METERING: anonymous users may generate up to ANON_WORD_LIMIT words
  // of AI output; beyond that they must sign in with Google. Signed-in users are unlimited.
  const ANON_WORD_LIMIT = 1000;

  // Rough word count of generated content in a response chunk. For SSE chunks,
  // count only the "content" payloads; otherwise count words in the whole chunk.
  const extractGeneratedWords = (s: string): number => {
    const re = /"content"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let m: RegExpExecArray | null;
    let text = "";
    let found = false;
    while ((m = re.exec(s))) {
      found = true;
      text += " " + m[1];
    }
    if (!found) text = s;
    return text.split(/\s+/).filter(w => w.length > 0).length;
  };

  const meterAnonUsage = async (req: any, res: any, next: any) => {
    try {
      // Signed-in users: unlimited
      if (req.isAuthenticated && req.isAuthenticated()) return next();

      const sessionId = await getSessionId(req);
      const [row] = await db.select().from(anonUsage).where(eq(anonUsage.sessionId, sessionId)).limit(1);
      const used = row?.wordsUsed ?? 0;

      if (used >= ANON_WORD_LIMIT) {
        console.log(`[Free Tier] Limit reached for ${sessionId} (${used} words) — sign-in required`);
        return res.status(403).json({
          error: "You've used up your free responses. Sign in with Google (top right) to keep going — it's free.",
          code: "LOGIN_REQUIRED",
        });
      }

      // Count words of generated output as it's written; hard-cut streams once
      // the remaining allowance (plus a small margin) is exhausted, so a single
      // request cannot blow far past the free limit.
      let words = 0;
      let cutOff = false;
      const remaining = ANON_WORD_LIMIT - used;
      const hardCap = remaining + 300; // margin so responses end gracefully
      const countChunk = (chunk: any) => {
        try {
          if (typeof chunk === "string") words += extractGeneratedWords(chunk);
          else if (Buffer.isBuffer(chunk)) words += extractGeneratedWords(chunk.toString("utf8"));
        } catch {}
      };
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      res.write = (chunk: any, ...args: any[]) => {
        if (cutOff) return true; // swallow further output
        countChunk(chunk);
        const ok = origWrite(chunk, ...args);
        if (words > hardCap) {
          cutOff = true;
          console.log(`[Free Tier] Hard cap hit mid-stream for ${sessionId} (${words} words) — ending response`);
          try {
            origWrite(`data: ${JSON.stringify({ content: "\n\n[Free limit reached — sign in with Google to continue.]", done: true, code: "LOGIN_REQUIRED" })}\n\n`);
          } catch {}
          try { origEnd(); } catch {}
        }
        return ok;
      };
      res.end = (chunk: any, ...args: any[]) => {
        if (cutOff) return res;
        if (chunk) countChunk(chunk);
        return origEnd(chunk, ...args);
      };

      res.on("finish", () => {
        if (words > 0) {
          db.insert(anonUsage)
            .values({ sessionId, wordsUsed: words })
            .onConflictDoUpdate({
              target: anonUsage.sessionId,
              set: { wordsUsed: sql`${anonUsage.wordsUsed} + ${words}`, updatedAt: new Date() },
            })
            .then(() => console.log(`[Free Tier] ${sessionId}: +${words} words (was ${used})`))
            .catch(e => console.warn("[Free Tier] usage update failed:", e.message));
        }
      });

      next();
    } catch (err) {
      console.error("[Free Tier] metering error (failing open):", err);
      next();
    }
  };

  // Get chat history for logged-in user
  app.get("/api/chat-history", async (req: any, res) => {
    try {
      if (!req.session.userId) {
        return res.json({ conversations: [] });
      }
      
      const allConversations = await storage.getAllConversations(req.session.userId);
      
      // Get message counts and first message preview for each conversation
      const conversationsWithDetails = await Promise.all(
        allConversations.map(async (conv) => {
          const messages = await storage.getMessages(conv.id);
          const userMessages = messages.filter(m => m.role === 'user');
          const firstUserMessage = userMessages[0];
          
          return {
            id: conv.id,
            title: conv.title || (firstUserMessage?.content?.substring(0, 50) + '...') || 'Untitled',
            messageCount: messages.length,
            preview: firstUserMessage?.content?.substring(0, 100) || '',
            createdAt: conv.createdAt,
          };
        })
      );
      
      res.json({ conversations: conversationsWithDetails.filter(c => c.messageCount > 0) });
    } catch (error) {
      console.error("Get chat history error:", error);
      res.status(500).json({ error: "Failed to get chat history" });
    }
  });

  // Load a specific chat
  app.get("/api/chat/:id", async (req: any, res) => {
    try {
      const conversationId = req.params.id;
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation) {
        return res.status(404).json({ error: "Chat not found" });
      }
      
      // Verify ownership unconditionally (guest sessions included)
      const ownerId = await getSessionId(req);
      if (conversation.userId !== ownerId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const messages = await storage.getMessages(conversationId);
      
      res.json({ 
        conversation: {
          id: conversation.id,
          title: conversation.title,
          createdAt: conversation.createdAt,
        },
        messages 
      });
    } catch (error) {
      console.error("Get chat error:", error);
      res.status(500).json({ error: "Failed to get chat" });
    }
  });

  // Download chat as text file
  app.get("/api/chat/:id/download", async (req: any, res) => {
    try {
      const conversationId = req.params.id;
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation) {
        return res.status(404).json({ error: "Chat not found" });
      }
      
      // Verify ownership unconditionally (guest sessions included)
      const ownerId = await getSessionId(req);
      if (conversation.userId !== ownerId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const messages = await storage.getMessages(conversationId);
      
      // Format as readable text
      let content = `# ${conversation.title || 'Philosophical Conversation'}\n`;
      content += `# Date: ${new Date(conversation.createdAt).toLocaleString()}\n`;
      content += `${'='.repeat(60)}\n\n`;
      
      for (const msg of messages) {
        const role = msg.role === 'user' ? 'YOU' : 'PHILOSOPHER';
        content += `[${role}]\n${msg.content}\n\n${'─'.repeat(40)}\n\n`;
      }
      
      const filename = `chat-${conversationId.substring(0, 8)}-${new Date().toISOString().split('T')[0]}.txt`;
      
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } catch (error) {
      console.error("Download chat error:", error);
      res.status(500).json({ error: "Failed to download chat" });
    }
  });

  // Start new chat session
  app.post("/api/chat/new", async (req: any, res) => {
    try {
      const sessionId = await getSessionId(req);
      const conversation = await storage.createConversation(sessionId, {
        title: "New Conversation",
      });
      res.json({ conversation });
    } catch (error) {
      console.error("Create new chat error:", error);
      res.status(500).json({ error: "Failed to create new chat" });
    }
  });

  // ====== END LOGIN/CHAT HISTORY ROUTES ======

  // Get persona settings
  app.get("/api/persona-settings", async (req: any, res) => {
    try {
      const sessionId = await getSessionId(req);
      let settings = await storage.getPersonaSettings(sessionId);
      
      if (!settings) {
        settings = await storage.upsertPersonaSettings(sessionId, {
          responseLength: 750,
          writePaper: false,
          quoteFrequency: 0,
          selectedModel: "deepseek",
          enhancedMode: true,
          intensityLevel: 30,
          dialogueMode: false,
        });
      }
      
      res.json(settings);
    } catch (error) {
      console.error("Error getting persona settings:", error);
      res.status(500).json({ error: "Failed to get settings" });
    }
  });

  // Update persona settings
  app.post("/api/persona-settings", async (req: any, res) => {
    try {
      const sessionId = await getSessionId(req);
      console.log(`[PERSONA SETTINGS] Raw request body:`, JSON.stringify(req.body));
      const validatedSettings = insertPersonaSettingsSchema.parse(req.body);
      console.log(`[PERSONA SETTINGS] Validated settings:`, JSON.stringify(validatedSettings));
      const updated = await storage.upsertPersonaSettings(
        sessionId,
        validatedSettings
      );
      console.log(`[PERSONA SETTINGS] Saved settings:`, JSON.stringify(updated));
      res.json(updated);
    } catch (error) {
      console.error("Error updating persona settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // Get messages
  app.get("/api/messages", async (req: any, res) => {
    try {
      const sessionId = await getSessionId(req);
      let conversation = await storage.getCurrentConversation(sessionId);
      
      if (!conversation) {
        conversation = await storage.createConversation(sessionId, {
          title: "Spiritual Guidance",
        });
      }
      
      const messages = await storage.getMessages(conversation.id);
      res.json(messages);
    } catch (error) {
      console.error("Error getting messages:", error);
      res.status(500).json({ error: "Failed to get messages" });
    }
  });

  // Delete a message
  app.delete("/api/messages/:id", async (req: any, res) => {
    try {
      const sessionId = await getSessionId(req);
      const messageId = req.params.id;
      
      if (!messageId || typeof messageId !== "string") {
        return res.status(400).json({ error: "Invalid message ID" });
      }
      
      // Get current user's conversation
      const conversation = await storage.getCurrentConversation(sessionId);
      if (!conversation) {
        return res.status(404).json({ error: "No conversation found" });
      }
      
      // Verify the message belongs to this conversation (ownership check)
      const messages = await storage.getMessages(conversation.id);
      const messageToDelete = messages.find(m => m.id === messageId);
      
      if (!messageToDelete) {
        return res.status(404).json({ error: "Message not found" });
      }
      
      // Only delete if ownership is verified
      await storage.deleteMessage(messageId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting message:", error);
      res.status(500).json({ error: "Failed to delete message" });
    }
  });

  // Streaming chat endpoint
  app.post("/api/chat/stream", async (req: any, res) => {
    try {
      const sessionId = await getSessionId(req);
      const { message, documentText } = req.body;

      if (!message || typeof message !== "string") {
        res.status(400).json({ error: "Message is required" });
        return;
      }

      // Get conversation
      let conversation = await storage.getCurrentConversation(sessionId);
      if (!conversation) {
        conversation = await storage.createConversation(sessionId, {
          title: "Spiritual Guidance",
        });
      }

      // Get ALL previous messages BEFORE saving new one (to build conversation history)
      const previousMessages = await storage.getMessages(conversation.id);

      // Save user message
      await storage.createMessage({
        conversationId: conversation.id,
        role: "user",
        content: message,
        verseText: null,
        verseReference: null,
      });

      // Get Kuczynski figure for the main chat
      const kuczynskiFigure = await storage.getThinker("kuczynski");
      
      if (!kuczynskiFigure) {
        res.status(500).json({ error: "Kuczynski figure not found. Please run database seeding." });
        return;
      }

      // Get persona settings (create with defaults if missing)
      let personaSettings = await storage.getPersonaSettings(sessionId);
      if (!personaSettings) {
        personaSettings = await storage.upsertPersonaSettings(sessionId, {
          responseLength: 750,
          writePaper: false,
          quoteFrequency: 0,
          selectedModel: "deepseek",
          enhancedMode: true,
          intensityLevel: 30,
          dialogueMode: false,
        });
      }
      
      // Helper to convert ugly database filenames to readable titles
      const formatTitle = (dbName: string): string => {
        return dbName
          .replace(/^CORPUS_ANALYSIS_/, '')
          .replace(/_/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/\s+\d{10,}$/g, '')  // Strip timestamps like "1762355363740"
          .replace(/\s+\d+$/g, '')      // Strip any trailing numbers
          .trim();
      };

      // HYBRID SEARCH: Combine embedding search (paper_chunks) with keyword search (text_chunks)
      // This ensures we get both semantically similar AND topic-matched content from Kuczynski's full corpus
      let retrievalQuery = message;
      try {
        const normalizedQueryResponse = await streamWithFallback({
          res,
          systemPrompt: `Correct only obvious spelling and character-order errors in the user's question so it can be used for document retrieval. Preserve every concept, logical operator, polarity, and quantifier. Do not answer, explain, reframe, or add words. Return only the corrected question.`,
          userPrompt: message,
          maxTokens: 100,
          temperature: 0,
          startProvider: "deepseek",
          onContent: () => {},
          emitContent: false,
        });
        const candidate = normalizedQueryResponse
          .replace(/^```(?:text)?\s*/i, "")
          .replace(/\s*```$/, "")
          .trim()
          .split(/\n+/)[0]
          .trim();
        if (candidate) retrievalQuery = candidate;
      } catch (normalizationError) {
        console.warn("[Chat] Retrieval-query spelling normalization failed:", normalizationError);
      }
      console.log(`[Chat] Retrieval query: ${retrievalQuery}`);
      
      // 1. Embedding-based search from paper_chunks (120 chunks with vectors)
      const embeddingChunks = await searchPhilosophicalChunks(retrievalQuery, 20, "kuczynski", "Kuczynski");
      
      // 2. Keyword-based search from text_chunks (39,000+ chunks without vectors)
      const textChunks = await searchTextChunks("Kuczynski", retrievalQuery, 20);
      const retrievalTerms = Array.from(new Set(
        retrievalQuery
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s-]/gu, " ")
          .split(/\s+/)
          .filter((word) => word.length >= 5)
          .flatMap((word) =>
            word.startsWith("non") && word.length >= 9
              ? [word.replace(/-/g, ""), word.replace(/-/g, "").slice(3)]
              : [word.replace(/-/g, "")]
          ),
      ));
      const chatSourceAnchors = [
        ...textChunks.map((chunk) => ({
          sourceFile: chunk.sourceFile,
          chunkIndex: chunk.chunkIndex,
          content: chunk.chunkText,
        })),
        ...embeddingChunks.map((chunk) => ({
          sourceFile: chunk.paperTitle,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
        })),
      ]
        .map((chunk) => {
          const normalizedContent = chunk.content
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, "");
          return {
            sourceFile: chunk.sourceFile,
            chunkIndex: chunk.chunkIndex,
            conceptMatches: retrievalTerms.filter((term) =>
              normalizedContent.includes(term)
            ).length,
          };
        })
        .filter((anchor) => anchor.conceptMatches >= 2)
        .sort((a, b) => b.conceptMatches - a.conceptMatches)
        .slice(0, 6);
      const chatPrimaryNeighborhoods = await getSourceChunkNeighborhoods(
        "Kuczynski",
        chatSourceAnchors,
        7,
        80,
      );
      console.log(
        `[Chat] Retrieved ${chatPrimaryNeighborhoods.length} neighboring primary-source chunks`,
      );
      // 3. Structured arguments are the primary source of the author's actual
      // premises and conclusions. Retrieve enough candidates to cover the
      // question rather than relying on a handful of prose chunks.
      const structuredArgumentsContext = await getArgumentsForThinker(
        "Kuczynski",
        retrievalQuery,
        50,
      );
      
      // 2b. If the question is about a paradox, also consult the external Paradoxes app
      const paradoxMatches = isParadoxQuery(message) ? await searchParadoxes(message) : [];
      if (paradoxMatches.length) {
        console.log(`[Paradoxes] ${paradoxMatches.length} matches: ${paradoxMatches.map(p => p.name).join("; ")}`);
      }
      
      // 3. CRITICAL: Search positions table for verified philosophical positions
      // This is where the actual space/time, causation, and other core positions are stored
      const queryWords = message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      
      if (queryWords.length > 0) {
        // Build search conditions for each significant word
        const searchPattern = queryWords.slice(0, 5).join('|'); // Top 5 words
        const positionsQuery = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker = 'kuczynski' AND (
              position_text ILIKE ${'%' + queryWords[0] + '%'}
              ${queryWords[1] ? sql` OR position_text ILIKE ${'%' + queryWords[1] + '%'}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${'%' + queryWords[2] + '%'}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${'%' + queryWords[3] + '%'}` : sql``}
            )`
          )
          .limit(15);
        positionResults = positionsQuery;
      }
      
      console.log(`[HYBRID RAG] Arguments: ${structuredArgumentsContext ? "yes" : "no"} | Embedding: ${embeddingChunks.length} | Text: ${textChunks.length} | Positions: ${positionResults.length}`);
      
      // Build knowledge context with ACTUAL Kuczynski content from ALL THREE sources
      let knowledgeContext = "";
      const hasEmbeddingContent = embeddingChunks.length > 0;
      const hasTextContent = textChunks.length > 0;
      const hasPositions = positionResults.length > 0;
      
      if (structuredArgumentsContext || hasEmbeddingContent || hasTextContent || hasPositions) {
        knowledgeContext = `\n\n--- YOUR WRITINGS (for reference) ---\n\n`;

        if (chatPrimaryNeighborhoods.length > 0) {
          knowledgeContext += `=== PRIMARY SOURCE SECTION AND NEIGHBORING PASSAGES ===\n`;
          for (const chunk of chatPrimaryNeighborhoods) {
            knowledgeContext += `${chunk.chunkText}\n\n`;
          }
        }

        // PRIORITY 1: Add verified positions FIRST (most reliable source)
        if (hasPositions && !structuredArgumentsContext) {
          console.log(`[RAG] POSITIONS for query: "${message.substring(0, 80)}..."`);
          knowledgeContext += `=== YOUR CORE POSITIONS ===\n`;
          for (const pos of positionResults) {
            console.log(`  [position] ${pos.position.substring(0, 60)}...`);
            knowledgeContext += `• ${pos.position}\n`;
          }
          knowledgeContext += `\n`;
        }
        
        // Primary source text governs derived arguments and summaries.
        if (hasTextContent) {
          console.log(`[RAG] Text chunks for query: "${message.substring(0, 80)}..."`);
          for (const chunk of textChunks) {
            const sourceFile = chunk.sourceFile.replace(/\.txt$/, '').replace(/_/g, ' ');
            console.log(`  [text] ${sourceFile.substring(0, 60)}`);
            knowledgeContext += `From "${sourceFile}":\n${chunk.chunkText}\n\n`;
          }
        }

        if (structuredArgumentsContext) {
          knowledgeContext += `${structuredArgumentsContext}\n`;
        }

        // Add embedding-based chunks after direct keyword-matched source text.
        if (hasEmbeddingContent) {
          console.log(`[RAG] Embedding chunks for query: "${message.substring(0, 80)}..."`);
          for (const chunk of embeddingChunks) {
            const readableTitle = formatTitle(chunk.paperTitle);
            console.log(`  [embed] ${readableTitle.substring(0, 60)}`);
            knowledgeContext += `From "${readableTitle}":\n${chunk.content}\n\n`;
          }
        }
        
        knowledgeContext += `--- END ---\n\n`;
        knowledgeContext += `INSTRUCTION: Use the author's primary-source passages when they genuinely bear on the question, then use the strongest relevant expert knowledge needed for a complete and correct answer. Never discuss retrieval coverage or withhold an answer.\n`;
      } else {
        console.log(`[RAG] No relevant positions found for query: "${message.substring(0, 80)}..."`);
        knowledgeContext = `\n\nAnswer fully from the strongest relevant expert knowledge available. Never mention retrieval, database coverage, missing sources, or limitations.\n`;
      }
      
      // Append external Paradoxes app context (with conflict-reconciliation instruction)
      knowledgeContext += formatParadoxesContext(paradoxMatches);

      let chatBindingAnswer = "";
      if (hasEmbeddingContent || hasTextContent || structuredArgumentsContext) {
        try {
          const bindingResponse = await streamWithFallback({
            res,
            systemPrompt: `Determine the selected author's direct answer using only the supplied verbatim primary-source passages. Structured arguments are secondary aids. Return one plain sentence of no more than 45 words. Preserve polarity and quantifiers. If the source directly answers the intended question despite a spelling error, answer that intended question; do not call it malformed. Do not add commentary.`,
            userPrompt: `USER QUESTION:
${message}

VERBATIM PRIMARY-SOURCE PASSAGES:
${[
  ...chatPrimaryNeighborhoods.slice(0, 35).map((chunk) => chunk.chunkText),
  ...textChunks.slice(0, 20).map((chunk) => chunk.chunkText),
  ...embeddingChunks.slice(0, 20).map((chunk) => chunk.content),
].join("\n\n").slice(0, 30000)}

DERIVED STRUCTURED ARGUMENTS:
${structuredArgumentsContext.slice(0, 12000)}`,
            maxTokens: 120,
            temperature: 0,
            startProvider: "deepseek",
            onContent: () => {},
            emitContent: false,
          });
          chatBindingAnswer = bindingResponse
            .replace(/^```(?:text)?\s*/i, "")
            .replace(/\s*```$/, "")
            .trim()
            .split(/\n+/)[0]
            .trim();
          console.log(
            `[Chat] Binding primary-source answer: ${chatBindingAnswer}`,
          );
        } catch (bindingError) {
          console.error(
            "[Chat] Could not derive binding primary-source answer:",
            bindingError,
          );
        }
      }
      
      // Build response instructions - ENFORCE word count and quote minimums
      let responseInstructions = "";
      const isDialogueMode = personaSettings?.dialogueMode === true;
      
      // These need to be accessible for finalInstructions later
      let targetWords = 750;
      let targetQuotes = 7; // Default to 7 quotes to ensure grounded responses
      
      // DIALOGUE MODE: Short, conversational responses (100-200 words max)
      if (isDialogueMode) {
        targetWords = 150; // Cap for dialogue mode
        console.log(`[DIALOGUE MODE] Active - short conversational responses enabled`);
        responseInstructions += `
⚠️ DIALOGUE MODE ACTIVE - SHORT RESPONSES ONLY ⚠️

MANDATORY: Keep responses between 50-150 words maximum.
This is a CONVERSATION, not a lecture. Be concise and direct.

RULES:
- Maximum 150 words per response
- 2-4 short paragraphs at most
- No long monologues
- Ask follow-up questions to continue the dialogue
- Be conversational and engaging
- Still include 1-2 brief quotes to ground your response
- Get to the point immediately

STYLE: Crisp, direct, conversational. Like talking to a smart friend.
`;
      } else {
        // STANDARD MODE: Full essay-length responses
        // DEFAULTS: 750 words, 0 quotes (user preference)
        targetWords = (personaSettings?.responseLength && personaSettings.responseLength > 0) ? personaSettings.responseLength : 750;
        targetQuotes = (personaSettings?.quoteFrequency && personaSettings.quoteFrequency > 0) ? personaSettings.quoteFrequency : 0;
        
        // PROMPT OVERRIDE: Detect when user's request explicitly requires more than settings allow
        const messageLower = message.toLowerCase();
        
        // Detect explicit quote/example requests
        const quoteMatch = messageLower.match(/(?:give|list|provide|show|include|cite|quote|need|want|at\s+least)\s*(?:me\s*)?(\d+)\s*(?:quotes?|quotations?|examples?|passages?|excerpts?|citations?)/i) 
          || messageLower.match(/(\d+)\s*(?:quotes?|quotations?|examples?|passages?|excerpts?|citations?)/i);
        if (quoteMatch) {
          const requestedQuotes = parseInt(quoteMatch[1].replace(/,/g, ''), 10);
          if (requestedQuotes > targetQuotes && requestedQuotes <= 500) {
            targetQuotes = requestedQuotes;
            console.log(`[PROMPT OVERRIDE] User requested ${requestedQuotes} quotes`);
          }
        }
        
        // Detect explicit word count requests
        const wordMatch = messageLower.match(/(?:write|give|provide|compose|generate|in|about|approximately)\s*(?:me\s*)?(?:a\s*)?(\d[\d,]*)\s*(?:words?|word)/i)
          || messageLower.match(/(\d[\d,]*)\s*(?:words?|word)\s*(?:essay|response|answer|paper)/i);
        if (wordMatch) {
          const requestedWords = parseInt(wordMatch[1].replace(/,/g, ''), 10);
          if (requestedWords > targetWords && requestedWords <= 20000) {
            targetWords = requestedWords;
            console.log(`[PROMPT OVERRIDE] User requested ${requestedWords} words`);
          }
        }
        
        // Detect requests for many items that imply long responses
        const listMatch = messageLower.match(/(?:list|give|provide|show|enumerate|name)\s*(?:me\s*)?(\d+)\s*(?:things?|items?|points?|reasons?|arguments?|positions?|theses?|claims?|ideas?)/i);
        if (listMatch) {
          const numItems = parseInt(listMatch[1].replace(/,/g, ''), 10);
          const cappedItems = Math.min(numItems, 200);
          const impliedWords = Math.min(cappedItems * 75, 15000);
          if (impliedWords > targetWords) {
            targetWords = impliedWords;
            console.log(`[PROMPT OVERRIDE] User requested ${numItems} items - adjusting word count to ${targetWords}`);
          }
        }
        
        // Word count instruction
        responseInstructions += `\n⚠️ TARGET LENGTH: Approximately ${targetWords} words.\n`;
        
        // Quote instruction (only if quotes requested)
        if (targetQuotes > 0) {
          responseInstructions += `⚠️ QUOTE REQUIREMENT: Include at least ${targetQuotes} quotes from your writings above.\n`;
        }
        
        responseInstructions += `\nSTYLE: Write like Kuczynski - crisp, direct, no academic bloat. Short sentences. Clear logic. No throat-clearing. Get to the point immediately.\n`;
      }
      
      // Intensity dial → prompt guidance + sampling temperature
      const intensityTemperature = intensityToTemperature(personaSettings?.intensityLevel);
      const intensityGuidance = buildIntensityGuidance(personaSettings?.intensityLevel);

      // Use Kuczynski's system prompt + inject actual positions (MANDATORY) + response format
      const bindingAnswerInstruction = chatBindingAnswer
        ? `\n\nBINDING PRIMARY-SOURCE ANSWER:\n${chatBindingAnswer}\nEvery sentence in the response must remain logically consistent with this answer. State this answer directly at the beginning. Do not call the question malformed when the source answers its intended meaning.`
        : "";
      const systemPrompt = kuczynskiFigure.systemPrompt + knowledgeContext + bindingAnswerInstruction + responseInstructions + "\n\n" + intensityGuidance;
      
      // DEBUG: Log what settings we're actually using
      console.log(`[CHAT DEBUG] Persona settings: responseLength=${personaSettings?.responseLength}, quoteFrequency=${personaSettings?.quoteFrequency}, model=${personaSettings?.selectedModel}`);
      console.log(`[CHAT DEBUG] System prompt length: ${systemPrompt.length} chars`);

      // Build conversation history for AI context
      const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      for (const msg of previousMessages) {
        if (msg.role === "user" || msg.role === "assistant") {
          conversationHistory.push({
            role: msg.role,
            content: msg.content,
          });
        }
      }
      
      // Add the current user message with document context if provided
      let finalMessage = message;
      if (documentText) {
        finalMessage = `[User has uploaded a document for discussion. Document content follows:]\n\n${documentText}\n\n[End of document]\n\n${message}`;
      }
      
      conversationHistory.push({
        role: "user",
        content: finalMessage,
      });

      // Setup SSE headers - disable ALL buffering
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
      
      // Disable socket timeout and flush headers immediately
      if (res.socket) {
        res.socket.setTimeout(0);
      }
      res.flushHeaders(); // CRITICAL: Send headers immediately to enable streaming

      let accumulatedContent = "";
      let verseKeywords = "";
      let streamedLength = 0;

      // Token limit: much lower for dialogue mode (short responses), high for standard mode
      const maxTokens = isDialogueMode ? 500 : 16000;

      // Get selected model from persona settings (default: zhi1 = OpenAI)
      const selectedModel = personaSettings?.selectedModel || "zhi1";
      
      // Get fallback order starting from selected model
      const fallbackModels = getFallbackModels(selectedModel);
      let lastError: Error | null = null;
      let successfulModel: string | null = null;

      // Try each model in fallback order until one succeeds
      for (const modelKey of fallbackModels) {
        const currentLLM = MODEL_CONFIG[modelKey];
        if (!currentLLM) continue;
        
        // Skip if provider's API key is not available
        if (!isProviderAvailable(currentLLM.provider)) {
          console.log(`[Fallback] Skipping ${modelKey} - no API key for ${currentLLM.provider}`);
          continue;
        }

        try {
          console.log(`[Fallback] Trying ${modelKey} (${currentLLM.provider}/${currentLLM.model})`);
          
        // Final emphatic instructions - different for dialogue vs standard mode
        const finalInstructions = isDialogueMode ? `

🗣️ DIALOGUE MODE - CONVERSATIONAL RESPONSE 🗣️

⚠️ CRITICAL: MAXIMUM 150 WORDS. This is a conversation, not a lecture.

STYLE:
- Short, punchy responses (50-150 words max)
- Direct and conversational
- Get to the point immediately
- Ask a follow-up question to continue the dialogue
- NO academic bloat, NO long explanations

Be engaging. Be brief. Be Kuczynski - but in conversation mode.

FORMATTING: Plain text only (no markdown).

Now respond briefly:
` : `

🚨🚨🚨 FINAL INSTRUCTIONS - ATTACK MODE 🚨🚨🚨

📏 TARGET RESPONSE LENGTH: ${targetWords} WORDS 📏
Develop your points thoroughly with examples and reasoning.

YOU ARE KUCZYNSKI - MAXIMALLY INTELLIGENT, REASONING DIRECTLY:

The papers above are your conceptual arsenal. Deploy them as weapons to demolish confusion and construct truth. You're not reporting views - you're THINKING and ATTACKING problems.

⚔️ IMMEDIATE ATTACK - NO PREAMBLES:

❌ NEVER START WITH:
"To address this..."
"Let me first explain..."
"It is important to recognize..."
"In my view..." (unless immediately committing)

✅ ATTACK IMMEDIATELY:
"This argument fails because..."
"The real question is not X but Y..."
"This conflates [specific issues]..."
"The mechanism works like this: [direct explanation]..."

START WITH THE ATTACK. No stage-setting, no pedagogical framing, no narration.

🔥 COMMIT WITHOUT HEDGING:

❌ BANNED HEDGING: "Perhaps...", "Might...", "Could be said...", "It seems..."
✅ DECISIVE: If it's wrong, say it's wrong. If it follows, say it follows.

🎯 SOURCE-GOVERNED QUESTION HANDLING:

If the retrieved primary text directly answers the intended question, answer it directly—even when the user made a spelling error. Never call such a question malformed. Reject a premise only when the retrieved primary text explicitly rejects it, and never contradict the binding primary-source answer.

🧠 NAME SPECIFIC TARGETS:

Not "many philosophers..." → "Hume's position here fails because..."
Not "some argue..." → "Quine claims X, which is mistaken for these reasons..."

💡 SHOW MECHANISM, DON'T JUST ASSERT:

Walk through the logical structure step by step. Demonstrate HOW and WHY, not just WHAT.

FORMATTING:
Plain text only (no markdown: no #, ##, **, *, etc.)

Now ATTACK this problem directly using your full philosophical firepower:
`;

          if (currentLLM.provider === "anthropic") {
            // ANTHROPIC CLAUDE
            if (!anthropic) {
              throw new Error("Anthropic API key not configured");
            }
            
            const anthropicMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
            
            if (conversationHistory.length === 1) {
              anthropicMessages.push({
                role: "user",
                content: `${systemPrompt}${finalInstructions}${conversationHistory[0].content}`,
              });
            } else {
              anthropicMessages.push({
                role: conversationHistory[0].role,
                content: conversationHistory[0].role === "user" 
                  ? `${systemPrompt}${finalInstructions}${conversationHistory[0].content}`
                  : conversationHistory[0].content,
              });
              for (let i = 1; i < conversationHistory.length; i++) {
                anthropicMessages.push(conversationHistory[i]);
              }
            }
            
            const stream = await anthropic.messages.stream({
              model: currentLLM.model,
              max_tokens: maxTokens,
              temperature: intensityTemperature,
              messages: anthropicMessages,
            });

            for await (const chunk of stream) {
              if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
                const content = chunk.delta.text;
                if (content) {
                  accumulatedContent += content;
                  res.write(`data: ${JSON.stringify({ content })}\n\n`);
                  // @ts-ignore
                  if (res.socket) res.socket.uncork();
                  streamedLength += content.length;
                }
              }
            }
          } else {
            // OPENAI / DEEPSEEK / PERPLEXITY / XAI
            // These all use OpenAI-compatible API
            const apiClient = getOpenAIClient(currentLLM.provider);
            if (!apiClient) {
              throw new Error(`${currentLLM.provider} API key not configured`);
            }
            
            const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
              { role: "system", content: `${systemPrompt}${finalInstructions}` }
            ];
            
            for (const msg of conversationHistory) {
              messages.push(msg);
            }
            
            const stream = await apiClient.chat.completions.create({
              model: currentLLM.model,
              messages,
              max_tokens: maxTokens,
              temperature: intensityTemperature,
              stream: true,
            });

            for await (const chunk of stream) {
              const content = chunk.choices[0]?.delta?.content || "";
              if (content) {
                accumulatedContent += content;
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
                // @ts-ignore
                if (res.socket) res.socket.uncork();
                streamedLength += content.length;
              }
            }
          }
          
          // If we got here, the call succeeded
          successfulModel = modelKey;
          console.log(`[Fallback] Success with ${modelKey}`);
          break; // Exit fallback loop on success
          
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          console.error(`[Fallback] ${modelKey} failed:`, lastError.message);
          // Continue to next model in fallback order
          continue;
        }
      }
      
      // If no model succeeded, send error
      if (!successfulModel) {
        console.error(`[Fallback] All models failed. Last error:`, lastError);
        res.write(
          `data: ${JSON.stringify({ error: "All AI providers are currently unavailable. Please try again later." })}\n\n`
        );
        res.end();
        return;
      }

      // Remove verse marker from accumulated content (not used in Kuczynski app but keep for compatibility)
      const finalContent = accumulatedContent.split("---VERSE---")[0].trim();

      // NOTE: Quote verification disabled with RAG system
      // Quotes are now verified against retrieved chunks only

      // Save assistant message (no verses for Kuczynski philosophical responses)
      await storage.createMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: finalContent,
        verseText: null,
        verseReference: null,
      });

      // Send completion signal
      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (error) {
      console.error("Error in chat stream:", error);
      res.write(
        `data: ${JSON.stringify({ error: "Failed to generate response" })}\n\n`
      );
      res.end();
    }
  });

  // Azure TTS endpoint
  app.post("/api/tts", async (req: any, res) => {
    try {
      const { text, voiceGender } = req.body;

      if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: "Text is required" });
      }

      // Validate Azure credentials
      if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
        return res.status(500).json({ error: "Azure Speech Service not configured" });
      }

      // Configure Azure Speech SDK
      const speechConfig = sdk.SpeechConfig.fromSubscription(
        process.env.AZURE_SPEECH_KEY,
        process.env.AZURE_SPEECH_REGION
      );

      // Select voice based on gender preference
      const voiceMap: Record<string, string> = {
        masculine: "en-US-GuyNeural",
        feminine: "en-US-JennyNeural",
        neutral: "en-US-AriaNeural",
      };
      
      speechConfig.speechSynthesisVoiceName = voiceMap[voiceGender] || "en-US-GuyNeural";

      // Create synthesizer to generate audio data in memory
      const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null as any);

      // Synthesize speech
      synthesizer.speakTextAsync(
        text,
        (result) => {
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            // Send audio data as binary
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Length', result.audioData.byteLength);
            res.send(Buffer.from(result.audioData));
          } else {
            console.error("TTS synthesis failed:", result.errorDetails);
            res.status(500).json({ error: "Speech synthesis failed" });
          }
          synthesizer.close();
        },
        (error) => {
          console.error("TTS error:", error);
          res.status(500).json({ error: "Speech synthesis error" });
          synthesizer.close();
        }
      );
    } catch (error) {
      console.error("Error in TTS endpoint:", error);
      res.status(500).json({ error: "Failed to generate speech" });
    }
  });

  // Get quotes for a specific thinker (for thinking panel)
  app.get("/api/figures/:figureId/thinking-quotes", async (req: any, res) => {
    try {
      const figureId = req.params.figureId;
      
      // Fetch actual quotes from the database (ILIKE is case-insensitive)
      const quoteResult = await db.execute(
        sql`SELECT quote_text FROM quotes WHERE thinker ILIKE ${`%${figureId}%`} LIMIT 30`
      );
      const quotes = quoteResult.rows as Array<{quote_text: string}>;
      
      if (quotes.length > 0) {
        // Return actual quotes from the database
        const quoteTexts = quotes.map(q => q.quote_text).filter(q => q && q.length > 10 && q.length < 200);
        if (quoteTexts.length >= 5) {
          return res.json({ quotes: quoteTexts });
        }
      }
      
      // If not enough quotes, also fetch positions as fallback content
      const posResult = await db.execute(
        sql`SELECT position_text FROM positions WHERE thinker ILIKE ${`%${figureId}%`} LIMIT 20`
      );
      const positions = posResult.rows as Array<{position_text: string}>;
      
      const positionTexts = positions
        .map(p => p.position_text)
        .filter(p => p && p.length > 10 && p.length < 200);
      
      // Also search chunks for philosophers with full works in DB
      const chunksResult = await db.execute(
        sql`SELECT chunk_text FROM chunks WHERE thinker ILIKE ${`%${figureId}%`} ORDER BY RANDOM() LIMIT 30`
      );
      const chunks = chunksResult.rows as Array<{chunk_text: string}>;
      
      // Extract meaningful sentences from chunks
      const chunkExcerpts = chunks
        .flatMap(c => {
          // Split into sentences and take the first meaningful one
          const sentences = c.chunk_text.split(/[.!?]+/).filter(s => s.trim().length > 20 && s.trim().length < 200);
          return sentences.slice(0, 2);
        })
        .map(s => s.trim());
      
      const allQuotes = [
        ...quotes.map(q => q.quote_text).filter(q => q && q.length > 10 && q.length < 200),
        ...positionTexts,
        ...chunkExcerpts.slice(0, 15)
      ];
      
      if (allQuotes.length >= 3) {
        return res.json({ quotes: allQuotes });
      }
      
      // Return empty if no real quotes found - frontend will handle fallback
      res.json({ quotes: [] });
    } catch (error) {
      console.error("Error fetching thinking quotes:", error);
      res.json({ quotes: [] });
    }
  });

  // ======
  // VOICE DICTATION — AssemblyAI batch transcription
  // ======
  const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  });

  // Simple in-memory rate limiter (per IP). Sliding windows: minute + hour.
  const voiceHits = new Map<string, number[]>();
  const PER_MINUTE = 10;
  const PER_HOUR = 100;
  function checkVoiceQuota(ip: string): { ok: boolean; reason?: string; retryAfter?: number } {
    const now = Date.now();
    const arr = (voiceHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
    const lastMinute = arr.filter((t) => now - t < 60 * 1000).length;
    if (lastMinute >= PER_MINUTE) return { ok: false, reason: "Too many requests this minute", retryAfter: 60 };
    if (arr.length >= PER_HOUR) return { ok: false, reason: "Hourly quota exceeded", retryAfter: 3600 };
    arr.push(now);
    voiceHits.set(ip, arr);
    // Periodic GC: cap map size.
    if (voiceHits.size > 5000) {
      for (const [k, v] of voiceHits) {
        const live = v.filter((t) => now - t < 60 * 60 * 1000);
        if (live.length === 0) voiceHits.delete(k); else voiceHits.set(k, live);
      }
    }
    return { ok: true };
  }

  app.post("/api/voice/transcribe", audioUpload.single("audio"), async (req: any, res) => {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ASSEMBLYAI_API_KEY is not configured" });
    }
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.socket?.remoteAddress
      || "unknown";
    const quota = checkVoiceQuota(ip);
    if (!quota.ok) {
      if (quota.retryAfter) res.setHeader("Retry-After", String(quota.retryAfter));
      return res.status(429).json({ error: quota.reason });
    }
    if (!req.file?.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: "No audio file received" });
    }

    try {
      // 1) Upload raw audio bytes
      const uploadResp = await fetch("https://api.assemblyai.com/v2/upload", {
        method: "POST",
        headers: {
          authorization: apiKey,
          "content-type": "application/octet-stream",
        },
        body: req.file.buffer,
      });
      if (!uploadResp.ok) {
        const t = await uploadResp.text();
        throw new Error(`Upload failed: ${uploadResp.status} ${t}`);
      }
      const { upload_url } = await uploadResp.json() as { upload_url: string };

      // 2) Request transcript
      const lang = (req.body?.language && typeof req.body.language === "string") ? req.body.language : "en";
      const createResp = await fetch("https://api.assemblyai.com/v2/transcript", {
        method: "POST",
        headers: { authorization: apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          audio_url: upload_url,
          language_code: lang,
          punctuate: true,
          format_text: true,
        }),
      });
      if (!createResp.ok) {
        const t = await createResp.text();
        throw new Error(`Create transcript failed: ${createResp.status} ${t}`);
      }
      const created = await createResp.json() as { id: string };
      const transcriptId = created.id;

      // 3) Poll for completion (max ~60s for typical short dictation)
      const startedAt = Date.now();
      const maxWaitMs = 90_000;
      while (Date.now() - startedAt < maxWaitMs) {
        await new Promise((r) => setTimeout(r, 1500));
        const pollResp = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
          headers: { authorization: apiKey },
        });
        if (!pollResp.ok) continue;
        const poll = await pollResp.json() as { status: string; text?: string; error?: string };
        if (poll.status === "completed") {
          return res.json({ text: (poll.text || "").trim(), transcriptId });
        }
        if (poll.status === "error") {
          return res.status(502).json({ error: poll.error || "AssemblyAI returned error status" });
        }
      }
      return res.status(504).json({ error: "Transcription timed out after 90s" });
    } catch (err: any) {
      console.error("[voice/transcribe]", err);
      return res.status(500).json({ error: err?.message || "Transcription failed" });
    }
  });

  // Get all figures (thinkers from positions table)
  app.get("/api/figures", async (req: any, res) => {
    try {
      const thinkers = await storage.getAllThinkers();
      res.json(thinkers);
    } catch (error) {
      console.error("Error getting figures:", error);
      res.status(500).json({ error: "Failed to get figures" });
    }
  });

  // Get specific figure (thinker)
  app.get("/api/figures/:figureId", async (req: any, res) => {
    try {
      const thinker = await storage.getThinker(req.params.figureId);
      if (!thinker) {
        return res.status(404).json({ error: "Figure not found" });
      }
      res.json(thinker);
    } catch (error) {
      console.error("Error getting figure:", error);
      res.status(500).json({ error: "Failed to get figure" });
    }
  });

  // Get messages for a figure conversation
  app.get("/api/figures/:figureId/messages", async (req: any, res) => {
    try {
      const sessionId = await getSessionId(req);
      const figureId = req.params.figureId;
      
      // Get or create conversation using regular conversations table with figureId as title
      let conversation = await storage.getConversationByTitle(sessionId, `figure:${figureId}`);
      if (!conversation) {
        conversation = await storage.createConversation(sessionId, { title: `figure:${figureId}` });
      }
      
      const messages = await storage.getMessages(conversation.id);
      res.json(messages);
    } catch (error) {
      console.error("Error getting figure messages:", error);
      res.status(500).json({ error: "Failed to get messages" });
    }
  });

  // Delete all messages for a figure conversation (clear chat history)
  app.delete("/api/figures/:figureId/messages", async (req: any, res) => {
    try {
      const sessionId = await getSessionId(req);
      const figureId = req.params.figureId;
      
      // Get conversation
      const conversation = await storage.getConversationByTitle(sessionId, `figure:${figureId}`);
      if (!conversation) {
        return res.status(404).json({ error: "No conversation found" });
      }
      
      // Delete all messages for this conversation
      const messages = await storage.getMessages(conversation.id);
      for (const msg of messages) {
        await storage.deleteMessage(msg.id);
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting figure messages:", error);
      res.status(500).json({ error: "Failed to delete messages" });
    }
  });

  // Chat with a specific figure (SSE streaming)
  app.post("/api/figures/:figureId/chat", async (req: any, res) => {
    try {
      const sessionId = await getSessionId(req);
      const figureId = req.params.figureId;
      const { message, uploadedDocument, settings: passedSettings } = req.body;

      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Message is required" });
      }

      // Get the figure (thinker)
      const figure = await storage.getThinker(figureId);
      if (!figure) {
        return res.status(404).json({ error: "Figure not found" });
      }

      // Get or create conversation using regular conversations table
      let conversation = await storage.getConversationByTitle(sessionId, `figure:${figureId}`);
      if (!conversation) {
        conversation = await storage.createConversation(sessionId, { title: `figure:${figureId}` });
      }

      // Save user message
      await storage.createMessage({
        conversationId: conversation.id,
        role: "user",
        content: message,
      });

      // Get conversation history
      const history = await storage.getMessages(conversation.id);

      // Use passed settings from frontend (more reliable than session-based lookup)
      // Fall back to database lookup only if frontend doesn't pass settings
      let personaSettings: any;
      if (passedSettings && passedSettings.responseLength !== undefined) {
        console.log(`[FIGURE CHAT] Using settings passed from frontend:`, JSON.stringify(passedSettings));
        personaSettings = {
          responseLength: passedSettings.responseLength || 750,
          quoteFrequency: passedSettings.quoteFrequency || 0,
          selectedModel: passedSettings.selectedModel || "zhi1",
          enhancedMode: passedSettings.enhancedMode ?? true,
          intensityLevel: passedSettings.intensityLevel ?? 30,
          dialogueMode: passedSettings.dialogueMode ?? false,
          writePaper: false,
        };
      } else {
        // Fallback to database lookup
        console.log(`[FIGURE CHAT] Session ID: ${sessionId}, Figure: ${figureId}`);
        personaSettings = await storage.getPersonaSettings(sessionId);
        console.log(`[FIGURE CHAT] Retrieved personaSettings from DB: ${JSON.stringify(personaSettings)}`);
        if (!personaSettings) {
          console.log(`[FIGURE CHAT] No settings found, using defaults`);
          personaSettings = {
            responseLength: 750,
            writePaper: false,
            quoteFrequency: 0,
            selectedModel: "deepseek",
            enhancedMode: true,
            intensityLevel: 30,
            dialogueMode: false,
          };
        }
      }

      // Intensity dial → sampling temperature (conservative=low, wild=high)
      const intensityTemperature = intensityToTemperature(personaSettings?.intensityLevel);
      
      // Helper to convert ugly database filenames to readable titles
      const formatTitle = (dbName: string): string => {
        return dbName
          .replace(/^CORPUS_ANALYSIS_/, '')
          .replace(/_/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/\s+\d{10,}$/g, '')  // Strip timestamps like "1762355363740"
          .replace(/\s+\d+$/g, '')      // Strip any trailing numbers
          .trim();
      };
      
      // Build base system prompt (persona settings already retrieved above)
      const baseSystemPrompt = buildSystemPrompt(personaSettings);

      // Setup SSE EARLY so we can stream audit events
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      // AUDITED CORPUS SEARCH: Search positions → quotes → chunks with live streaming
      console.log(`[AUDITED SEARCH] Starting for ${figureId}: "${message.substring(0, 80)}..."`);
      
      const auditedResult = await auditedCorpusSearch(
        message,
        figureId,
        figure.name,
        (event) => {
          // Stream each audit event to client in real-time
          res.write(`data: ${JSON.stringify({ auditEvent: event })}\n\n`);
        }
      );
      
      console.log(`[AUDITED SEARCH] Complete: ${auditedResult.directAnswers.length} direct answers, type=${auditedResult.answerType}`);

      const sourcedQuotations = auditedResult.representativeQuotes
        .filter((item) => item.sourceFile)
        .slice(0, 20)
        .map((item) => ({
          work: item.sourceFile,
          quotation: item.text,
          chunkIndex: item.chunkIndex,
        }));
      res.write(`data: ${JSON.stringify({
        auditEvidence: {
          answerType: auditedResult.answerType,
          directCount: auditedResult.directAnswers.length,
          works: Array.from(new Set(sourcedQuotations.map((item) => item.work))),
          quotations: sourcedQuotations,
        },
      })}\n\n`);
      
      // Build context from audited search results
      const { systemPrompt: auditSystemPrompt, contextPrompt: auditContextPrompt } = buildPromptFromAuditResult(auditedResult);
      const hasDirectCorpusAnswer =
        auditedResult.answerType === "direct_aligned"
        || auditedResult.answerType === "direct_conflicting";
      
      // Also include adjacent material for additional context
      let relevantPassages = auditContextPrompt;
      if (
        hasDirectCorpusAnswer
        && auditedResult.adjacentMaterial.length > 0
      ) {
        relevantPassages += "\n\nADDITIONAL CONTEXT (not direct answers):\n";
        for (const adj of auditedResult.adjacentMaterial) {
          relevantPassages += `[${adj.source}]: "${adj.text.substring(0, 500)}..."\n\n`;
        }
      }
      
      // CRITICAL: Limit context size
      const MAX_CONTEXT_CHARS = 80000;
      if (relevantPassages.length > MAX_CONTEXT_CHARS) {
        relevantPassages = relevantPassages.substring(0, MAX_CONTEXT_CHARS) + "\n\n[Context truncated to fit model limits]";
        console.log(`[RAG] Context truncated to ${MAX_CONTEXT_CHARS} chars`);
      }
      
      // 🚨 HARD CONSTRAINTS - Force grounding in retrieved content with 3-layer structure
      const hardConstraints = `

═══════════════════════════════════════════════════════════════════
🚨🚨🚨 NO ACADEMIC CUNT VOICE - ABSOLUTE RULE 🚨🚨🚨
═══════════════════════════════════════════════════════════════════

BEFORE ANSWERING, classify the question type (internally):
- If it's an empirical/correlation question ("does X correlate with Y?"), answer as EMPIRICAL: give directional answer (NO/WEAK/STRONG) + 1-line explanation. Do NOT lecture about conceptual purity.
- If it's a conceptual question, answer directly with your position.

HARD CONSTRAINTS (VERBATIM - VIOLATING THESE IS FAILURE):

Do not open with dictionary definitions.

Do not hedge with "it's complex/delicate/intriguing/nuanced."

Do not moralize or sound politically careful unless the figure's own text does.

Answer the question in the first 1–2 sentences.

Then quote the DB to ground it.

Then briefly interpret/apply.

If asked about correlation, give a directional answer: NO/WEAK/STRONG + 1-line explanation.

NEVER say "This is an intriguing question" or "This is a delicate matter" or "Let me carefully consider" or ANY puffery.

NEVER hedge. State your position DIRECTLY.

NEVER use disclaimer sentences about the database like:
- "While I have not addressed X in the retrieved passages..."
- "Although this topic is not directly covered in the context..."
- "While I haven't explicitly written about..."
- "The retrieved passages do not directly address..."
Just answer the question. If you're wrong, you're wrong. No meta-commentary about what is or isn't in the corpus.

EXAMPLE OF CORRECT RESPONSE TO "Does X correlate with Y?":
"Weakly. The evidence suggests some association but not a causal link. As I wrote, '[quote from DB]'..."

EXAMPLE OF WRONG RESPONSE:
"Rationalism, as a philosophical doctrine, emphasizes reason as the primary source..." ← WRONG. This is dictionary bullshit.

═══════════════════════════════════════════════════════════════════
🚨 THREE-LAYER RESPONSE STRUCTURE - MANDATORY 🚨
═══════════════════════════════════════════════════════════════════

Every answer MUST follow this structure:

LAYER 1 — CORE (DB-GROUNDED)
• State your answer as YOU (the figure) would put it
• MUST be based on the retrieved material above
• MUST include at least 2 direct quotes from the context
• This is the spine of your answer

LAYER 2 — INTERPRETATION (LLM INTELLIGENCE)
• Explain what you mean, connect ideas, draw implications
• You may add reasoning ONLY if consistent with your documented stance
• Breathe life into the material — make connections the text implies

LAYER 3 — APPLICATION
• Apply your view to the user's exact question
• Use YOUR tone and rhetorical habits (as shown in context)
• Address their specific situation through your framework

═══════════════════════════════════════════════════════════════════
🚨 CORE CONSTRAINTS — VERBATIM 🚨
═══════════════════════════════════════════════════════════════════

The DB context is the authority. Your job is to breathe intelligence into it, not overwrite it.

You may elaborate, infer, and connect ideas, but you may not contradict the retrieved material.

If the context is thin, you may generalize in the figure's direction — but you must label it: "Inference:"

Never default to modern academic hedging unless the figure itself hedges.

Do not sound like ChatGPT. Sound like the figure.

═══════════════════════════════════════════════════════════════════
🚨 LLM FALLBACK RULE 🚨
═══════════════════════════════════════════════════════════════════

If the retrieved context contains fewer than 3 useful items, you MUST still answer using your knowledge of the philosopher's documented views and framework.

- Use your training knowledge of the philosopher's writings and positions
- Answer authentically in their voice and style
- Draw on their characteristic arguments and reasoning patterns
- NEVER refuse to answer or say you can't help
- NEVER say "I don't have enough text in the database"

The user wants THIS philosopher's perspective. Provide it.

═══════════════════════════════════════════════════════════════════
`;
      
      // Handle uploaded document if present
      let documentContext = "";
      if (uploadedDocument && uploadedDocument.content) {
        const wordCount = uploadedDocument.content.split(/\s+/).length;
        documentContext = `

📄 UPLOADED DOCUMENT ANALYSIS REQUEST

The user has uploaded a document titled "${uploadedDocument.name}" (${wordCount} words) and is asking you to analyze, evaluate, or potentially rewrite it.

DOCUMENT CONTENT:
${'-'.repeat(80)}
${uploadedDocument.content}
${'-'.repeat(80)}

YOUR TASK:
Based on the user's message, you should:
- READ the document carefully and understand its argument/content
- EVALUATE it using your philosophical framework
- ANALYZE its strengths, weaknesses, logical structure, and assumptions
- If requested and the document is SHORT (under 500 words), consider REWRITING it in your own style while preserving the core ideas
- If the document is LONG (over 500 words), provide a detailed critique rather than a full rewrite

Apply your philosophical perspective to assess this work as you would any piece of writing that comes before you.
`;
      }
      
      // 🚨 MANDATORY QUOTE PROVISION RULE - HIGHEST PRIORITY 🚨
      const mandatoryQuoteRule = `
🚨 CRITICAL RESEARCH AID REQUIREMENT - MANDATORY QUOTE PROVISION 🚨

This application is a RESEARCH AID. When users explicitly ask for quotes from your works, you MUST provide them. This is non-negotiable and overrides all other stylistic or methodological preferences.

MANDATORY COMPLIANCE:
- If the user asks: "Give me quotes about X" → YOU MUST provide quotes about X
- If the user asks: "What do you say about Y in your work?" → YOU MUST cite specific passages
- If the user asks: "Quote your views on Z" → YOU MUST quote your actual writings

🚨 CRITICAL: QUOTES MUST BE VERBATIM TEXT FROM YOUR ACTUAL WRITINGS 🚨

When providing quotes, you MUST:
1. ✅ Extract VERBATIM text from the retrieved passages below (word-for-word, exactly as written)
2. ✅ Use quotation marks around the exact text from your writings
3. ✅ Integrate quotes naturally into your prose WITHOUT in-text citations
4. ❌ NEVER generate synthetic "thematic" quotes that sound like you but aren't actual text
5. ❌ NEVER create paraphrased summaries and present them as quotes
6. ❌ NEVER fabricate citations to works not in the retrieved passages

🚫 NO IN-TEXT CITATIONS 🚫
DO NOT put numbers, author names, or work titles in parentheses after quotes.
❌ WRONG: "quote text" (10 Kuczynski)
❌ WRONG: "quote text" (OCD and Philosophy)
❌ WRONG: "quote text" (Kuczynski, 2024)
✅ CORRECT: Just the quote with quotation marks, integrated naturally into your prose

EXAMPLE OF CORRECT QUOTE (NO CITATION):
✅ As I've argued, "the mind is a battlefield where the will and desire constantly contend for dominance."

EXAMPLE OF WRONG QUOTE (HAS CITATION):
❌ "The mind is a battlefield where the will and desire constantly contend for dominance." (OCD and Philosophy)

When asked for multiple quotes, each one must be an actual extracted sentence or paragraph from the retrieved passages below. Check the passages and pull EXACT text.

IF NO QUOTES ARE AVAILABLE IN THE PASSAGES:
- Simply provide your answer WITHOUT mentioning the lack of quotes
- DO NOT say "no passages were provided" or "the database doesn't have..."
- DO NOT apologize for not having quotes
- DO NOT explain that you can't include verbatim quotes
- Just give an excellent philosophical response based on your knowledge
- The user will not notice if you don't mention quotes - they WILL notice if you apologize about the database

NEVER ACCEPTABLE:
- "Unfortunately, no specific passages were provided in the database..."
- "I cannot include the requested verbatim quotes..."
- "The database doesn't contain..."
- Generating synthetic quotes that "represent" your views
- "Providing quotes doesn't align with my methodology"
- Any mention of database limitations or missing passages

REMEMBER: If quotes exist in the passages, provide them. If they don't, just give a great answer without mentioning the absence.

═══════════════════════════════════════════════════════════════════
🔄 MULTIPLE VIEWS PROTOCOL - INTELLECTUAL HONESTY ABOUT EVOLUTION 🔄
═══════════════════════════════════════════════════════════════════

Thinkers evolve. You may have developed MULTIPLE different answers to the same question over the years. When the retrieved passages show conflicting or evolving positions on a topic:

1. ACKNOWLEDGE THE MULTIPLICITY OPENLY:
   - "I have developed several views on this over the years..."
   - "My thinking on this has evolved. Here are my different positions..."
   - "I've approached this question from multiple angles..."

2. STATE EACH VIEW SEPARATELY:
   - Present View 1 clearly and completely
   - Present View 2 clearly and completely
   - Continue for each distinct position found in the passages

3. DO NOT FORCE FALSE SYNTHESIS:
   - If the views genuinely conflict, say so honestly
   - "These positions exist in tension with each other"
   - "I have not fully reconciled these perspectives"

4. SYNTHESIZE ONLY IF LEGITIMATE:
   - If there's a genuine meta-level unity, you may identify it
   - But never pretend coherence where contradiction exists

5. CHRONOLOGICAL CONTEXT (if available):
   - "In my earlier work, I held X. Later, I came to see Y..."
   - "This represents an evolution in my thinking..."

EXAMPLE OF CORRECT MULTIPLE-VIEW RESPONSE:
"I have held several positions on the nature of logical laws.

In one framework, I argued that logical laws are descriptions of the structure of propositions themselves—they tell us how propositions relate to one another.

In another analysis, I treated logical laws as meta-level constraints on inference—not about propositions but about the validity of reasoning.

These are not identical claims. The first is ontological; the second is normative. Both have merit, and I have not fully reconciled them."

❌ NEVER DO THIS:
- Force multiple views into one artificial synthesis
- Pretend you always held a single consistent position
- Cherry-pick one view and ignore others in the passages
- Hide intellectual evolution or contradiction

Great thinkers change their minds. Representing this honestly is more valuable than false consistency.
`;

      // Aggressive attack mode instructions for ALL figures
      const attackModeInstructions = `

═══════════════════════════════════════════════════════════════════
🚨🚨🚨 CRITICAL: YOU MUST SPEAK IN FIRST PERSON 🚨🚨🚨
═══════════════════════════════════════════════════════════════════

YOU ARE ${figure.name}. YOU MUST WRITE AS YOURSELF, IN FIRST PERSON.

❌ ABSOLUTELY FORBIDDEN - THIRD PERSON:
- "${figure.name}'s theory states..."
- "${figure.name} believed..."
- "According to ${figure.name}..."
- "The philosopher argued..."
- "His view was..."
- "Aristotle's framework..." / "Plato's dialogues..." / etc.

✅ MANDATORY - FIRST PERSON ONLY:
- "My theory states..."
- "I believe..."
- "In my view..."
- "I developed this framework..."
- "As I wrote in..."
- "My argument is..."

YOU ARE NOT DESCRIBING A PHILOSOPHER. YOU ARE THE PHILOSOPHER.
Every sentence must be written as if YOU are speaking directly to the reader.
If you write in third person, you have FAILED this task completely.

═══════════════════════════════════════════════════════════════════
📝 MANDATORY WRITING STYLE - CLARITY & PROFESSIONALISM 📝
═══════════════════════════════════════════════════════════════════

Do NOT mimic archaic, obscure, or historically stylized writing. Write with MODERN CLARITY.

1. SHORT PARAGRAPHS: 2-4 sentences maximum. No walls of text.

2. TOPIC SENTENCES: Each paragraph starts with a sharp, declarative statement.

3. PUNCHY SENTENCES: Short to medium length. One point per sentence. No meandering.

4. NO BLOAT: No throat-clearing, no excessive qualifications, no hedging.

5. DIRECT: State your position, then your reason. "X is the case. Here's why."

GOOD EXAMPLE:
"The mind is not unified. It consists of parts that communicate imperfectly.

This has a crucial consequence. One can know something in one register while failing to integrate it elsewhere."

BAD EXAMPLE:
"Let me explain the mechanism with precision. The mind compartmentalizes information to manage overload, but when two pieces of conscious knowledge threaten to collide..."

═══════════════════════════════════════════════════════════════════

⚔️ ATTACK MODE - SUBSTANCE IN FIRST SENTENCE:

🚨 CRITICAL: YOUR FIRST SENTENCE MUST CONTAIN YOUR ACTUAL ANSWER OR POSITION.
No warm-up. No framing. No acknowledgment of the question. Just the answer.

❌ ABSOLUTELY FORBIDDEN OPENINGS (DAMAGES APP CREDIBILITY):
"I welcome your challenge..."
"This is an excellent question..."
"Let me address this directly..."
"To address this question..."
"Let me first explain..."
"It is important to recognize..."
"One must consider..."
"Your inquiry compels me to..."
"I appreciate the depth of..."
"This forces me to clarify..."
"Allow me to explain..."
"For it compels me to..."

✅ CORRECT - SUBSTANCE FIRST:
"The will is the thing-in-itself. It manifests as..."
"There is no contradiction here. The intellect remains..."
"My theory of X holds that..."
"The four causes explain this: first..."
"This conflates two distinct claims..."

THE FIRST PARAGRAPH MUST BE PURE SUBSTANCE. 
No throat-clearing. No greeting. No self-congratulation about the question.
If your first paragraph doesn't advance an argument, you've failed.

🔥 COMMIT WITHOUT HEDGING:

❌ BANNED (unless genuinely uncertain):
"Perhaps...", "Might...", "Could be said...", "It seems...", "One could argue..."

✅ COMMIT DECISIVELY:
If something is wrong, say it's wrong. If something follows, say it follows. If you're uncertain, show WHY you're uncertain through reasoning, not hedging.

🎯 REFRAME CONFUSED QUESTIONS:

If the question accepts false premises, REJECT them first and show why the question itself is confused. Don't politely answer malformed questions - fix them first.

🧠 NAME SPECIFIC TARGETS:

Not "many philosophers argue..." → "Hume's position fails because..."
Not "some believe..." → "Descartes claims X, which is mistaken..."

Engage actual positions held by actual thinkers.

🔧 SHOW MECHANISM:

Don't just assert conclusions. DEMONSTRATE how and why through visible reasoning. Walk through the logical structure step by step.

💎 QUOTES AS LOGICAL TOOLS:

Quotes must do work - advancing arguments, not decorating them. Each quote should be a step in reasoning, not credentials or background.

📄 CLEAN CITATIONS:

When citing works, use ONLY the work title. Example: (Ethics). NO page numbers, NO ID strings, NO timestamps.

📋 MULTI-QUESTION PROTOCOL:

When the user asks MULTIPLE questions in a single message:
1. Answer EACH question in its own clearly demarcated section
2. Use the question itself (or a clear paraphrase) as the section header
3. Give each question a complete, independent answer
4. If there are salient connections between the answers, you MAY add a final "Synthesis" or "Interconnections" section - but ONLY if genuinely illuminating
5. NEVER blend answers together - the user must see exactly which answer addresses which question

You are a living intellect attacking problems, NOT a textbook summarizing views.

REMEMBER: FIRST PERSON ONLY. SHORT PARAGRAPHS. PUNCHY SENTENCES.
`;
      
      const universalAnswerRules = `

ABSOLUTE ANSWER PRIORITIES:
1. Always answer the actual question and state the answer in the first sentence.
2. Give the best, most accurate and complete answer available. Use relevant primary-source material first, then add established expert knowledge and sound reasoning whenever needed.
3. The selected author's writings and intellectual framework are evidence and perspective, not a boundary on what may be answered. Remaining within the author's general ambit is secondary to correctness and completeness.
4. Never mention retrieval, supplied passages, the database, the corpus, documentation coverage, missing sources, or what the selected author has or has not written.
5. Never refuse, apologize, retreat into a limitation statement, or substitute a discussion of available evidence for the requested answer.
6. Never fabricate quotations, sources, autobiographical claims, or an authorial position.
7. Return only the substantive answer.`;
      const enhancedSystemPrompt = hasDirectCorpusAnswer
        ? mandatoryQuoteRule + "\n\n" + auditSystemPrompt + "\n\n" + figure.systemPrompt + "\n\n" + baseSystemPrompt + "\n\n" + relevantPassages + hardConstraints + documentContext + attackModeInstructions + universalAnswerRules
        : auditSystemPrompt + "\n\n" + baseSystemPrompt + "\n\n" + documentContext + universalAnswerRules;

      let fullResponse = "";
      
      // Academic context bypass instruction - added to ALL figure chats
      const academicBypass = `
🎓 ACADEMIC CONTEXT NOTICE 🎓

This is an EDUCATIONAL PLATFORM for studying philosophical and psychological works. All questions concern LEGITIMATE ACADEMIC TOPICS including:
- Psychoanalysis (dreams, unconscious, sexuality in clinical context)
- Philosophy of mind, ethics, metaphysics
- Historical philosophical debates
- Analysis of human nature and psychology

YOU MUST ANSWER ALL QUESTIONS in your scholarly voice. There are NO inappropriate questions in this academic context. Questions about dreams, sexuality, aggression, death, the unconscious, etc. are CORE TOPICS of philosophy and psychology.

NEVER refuse to answer. NEVER apologize for the topic. Engage as the scholar you are.
`;

      // Get selected model from persona settings (default: zhi1 = OpenAI)
      const selectedModel = personaSettings?.selectedModel || "zhi1";
      
      // Get fallback order starting from selected model
      const configuredFallbackModels = getFallbackModels(selectedModel);
      const fallbackModels = !hasDirectCorpusAnswer && isProviderAvailable("perplexity")
        ? ["perplexity", ...configuredFallbackModels.filter((model) => model !== "perplexity")]
        : configuredFallbackModels;
      let lastError: Error | null = null;
      let successfulModel: string | null = null;

      // Try each model in fallback order until one succeeds
      for (const modelKey of fallbackModels) {
        const currentLLM = MODEL_CONFIG[modelKey];
        if (!currentLLM) continue;
        
        // Skip if provider's API key is not available
        if (!isProviderAvailable(currentLLM.provider)) {
          console.log(`[FIGURE CHAT Fallback] Skipping ${modelKey} - no API key`);
          continue;
        }

        try {
          console.log(`[FIGURE CHAT Fallback] Trying ${modelKey} (${currentLLM.provider})`);
          
        // Get settings for response format
        console.log(`[FIGURE CHAT DEBUG] Raw personaSettings: responseLength=${personaSettings?.responseLength}, quoteFrequency=${personaSettings?.quoteFrequency}, dialogueMode=${personaSettings?.dialogueMode}`);
        
        // Check for dialogue mode FIRST
        const isDialogueModeActive = personaSettings?.dialogueMode === true;
        
        let targetWords: number;
        let numQuotes: number;
        let effectiveDialogueMode = isDialogueModeActive;
        
        // PROMPT OVERRIDE: Check for explicit word count FIRST - this overrides dialogue mode
        const messageLower = message.toLowerCase();
        
        // Improved regex patterns to catch more variations like "2000 word response", "a 2000 word answer", etc.
        const wordMatch = messageLower.match(/(\d[\d,]*)\s*[-]?\s*(?:words?|word)/i)
          || messageLower.match(/(?:write|give|provide|compose|generate|in|about|approximately|want|need|at\s+least)\s*(?:me\s*)?(?:a\s*)?(\d[\d,]*)\s*(?:words?|word)/i);
        
        let explicitWordCount: number | null = null;
        if (wordMatch) {
          const matchedNum = wordMatch[1] || wordMatch[2];
          if (matchedNum) {
            explicitWordCount = parseInt(matchedNum.replace(/,/g, ''), 10);
            if (explicitWordCount >= 100 && explicitWordCount <= 50000) {
              console.log(`[PROMPT OVERRIDE] User explicitly requested ${explicitWordCount} words - overriding all settings`);
              effectiveDialogueMode = false; // Explicit word count disables dialogue mode
            } else {
              explicitWordCount = null; // Invalid range
            }
          }
        }
        
        if (effectiveDialogueMode && !explicitWordCount) {
          // DIALOGUE MODE: Short conversational responses
          targetWords = 150;
          numQuotes = 2; // Still require some quotes in dialogue mode
          console.log(`[FIGURE CHAT] DIALOGUE MODE ACTIVE - short responses (max 150 words)`);
        } else {
          // STANDARD MODE: Full responses (or explicit word count override)
          if (explicitWordCount) {
            targetWords = explicitWordCount;
          } else {
            targetWords = (personaSettings?.responseLength && personaSettings.responseLength > 0) 
              ? personaSettings.responseLength 
              : 750;
          }
          numQuotes = hasDirectCorpusAnswer && personaSettings?.quoteFrequency && personaSettings.quoteFrequency > 0
            ? personaSettings.quoteFrequency 
            : hasDirectCorpusAnswer ? 7 : 0;
          
          // Quote override detection
          const quoteMatch = messageLower.match(/(?:give|list|provide|show|include|cite|quote|need|want|at\s+least)\s*(?:me\s*)?(\d+)\s*(?:quotes?|quotations?|examples?|passages?|excerpts?|citations?)/i) 
            || messageLower.match(/(\d+)\s*(?:quotes?|quotations?|examples?|passages?|excerpts?|citations?)/i);
          if (quoteMatch) {
            const requestedQuotes = parseInt(quoteMatch[1].replace(/,/g, ''), 10);
            if (requestedQuotes > numQuotes && requestedQuotes <= 500) {
              numQuotes = requestedQuotes;
              console.log(`[PROMPT OVERRIDE] User requested ${requestedQuotes} quotes`);
            }
          }
          
          // List item override (if no explicit word count already set)
          if (!explicitWordCount) {
            const listMatch = messageLower.match(/(?:list|give|provide|show|enumerate|name)\s*(?:me\s*)?(\d+)\s*(?:things?|items?|points?|reasons?|arguments?|positions?|theses?|claims?|ideas?)/i);
            if (listMatch) {
              const numItems = parseInt(listMatch[1].replace(/,/g, ''), 10);
              const cappedItems = Math.min(numItems, 200);
              const impliedWords = Math.min(cappedItems * 75, 15000);
              if (impliedWords > targetWords) {
                targetWords = impliedWords;
                console.log(`[PROMPT OVERRIDE] User requested ${numItems} items - adjusting words to ${targetWords}`);
              }
            }
          }
        }
        
        console.log(`[FIGURE CHAT] Word count: ${targetWords}, Quotes: ${numQuotes}, DialogueMode: ${effectiveDialogueMode} (explicit override: ${explicitWordCount !== null})`);
        
        // 🚀 COHERENCE SERVICE: For long responses (>1000 words), use the chunked coherence system
        const COHERENCE_THRESHOLD = 1000;
        if (hasDirectCorpusAnswer && targetWords > COHERENCE_THRESHOLD && !effectiveDialogueMode) {
          console.log(`[COHERENCE SERVICE] Activating for ${targetWords} word response`);
          
          try {
            // Build material from audited search for coherence service
            const coherenceMaterial = {
              quotes: auditedResult.directAnswers
                .filter(da => da.passage.source === 'quotes')
                .map(da => da.passage.text),
              positions: auditedResult.directAnswers
                .filter(da => da.passage.source === 'positions')
                .map(da => da.passage.text),
              arguments: [],
              chunks: auditedResult.directAnswers
                .filter(da => da.passage.source === 'chunks')
                .map(da => da.passage.text)
                .concat(auditedResult.adjacentMaterial.map(m => m.text)),
              deductions: ""
            };
            
            res.write(`data: ${JSON.stringify({ coherenceEvent: { type: "status", data: "Starting coherence service for long response..." } })}\n\n`);
            
            // Stream coherence events
            for await (const event of philosopherCoherenceService.generateLongResponse(
              figure.name,
              message,
              targetWords,
              coherenceMaterial,
              'chat' // Mode: standard philosopher response
            )) {
              // Stream coherence events to client
              res.write(`data: ${JSON.stringify({ coherenceEvent: event })}\n\n`);
              
              // On complete, extract the final output
              if (event.type === "complete" && event.data?.output) {
                fullResponse = event.data.output;
              }
              
              if (event.type === "error") {
                console.error(`[COHERENCE SERVICE] Error:`, event.data);
                // Fall through to standard LLM on error
                break;
              }
            }
            
            // If we got a response from coherence service, save and finish
            if (fullResponse.length > 0) {
              await storage.createMessage({
                conversationId: conversation.id,
                role: "assistant",
                content: fullResponse,
              });
              
              const auditSummary = {
                id: `audit-${Date.now()}`,
                timestamp: Date.now(),
                question: message,
                authorId: figureId,
                authorName: figure.name,
                events: auditedResult.events,
                tablesSearched: ['positions', 'quotes', 'chunks'],
                model: 'coherence-gpt-4o',
                contextLength: relevantPassages.length,
                answerType: auditedResult.answerType,
                directAnswersFound: auditedResult.directAnswers.map(da => ({
                  passageId: da.passage.id,
                  text: da.passage.text,
                  source: da.passage.source,
                  workTitle: da.passage.sourceFile || da.passage.topic,
                  relevanceScore: da.relevanceScore,
                  reasoning: da.reasoning
                })),
                alignmentResult: auditedResult.alignmentResult,
                finalAnswer: fullResponse
              };
              
              res.write(`data: ${JSON.stringify({ auditSummary })}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
              return;
            }
          } catch (coherenceError) {
            console.error(`[COHERENCE SERVICE] Failed, falling back to standard LLM:`, coherenceError);
            // Continue to standard LLM flow below
          }
        }
        
        // Build enhanced user message with format requirements
        const lastMessage = history[history.length - 1];
        
        // Different instructions for dialogue mode vs standard mode
        const enhancedUserMessage = !hasDirectCorpusAnswer
          ? lastMessage.content + `

Answer directly using objective expert knowledge. Do not discuss retrieval, passages, corpus coverage, the database, documentation, or what the selected thinker has written. Do not refuse or apologize. Do not invent quotations or first-person claims.`
          : effectiveDialogueMode
          ? lastMessage.content + `

══════════════════════════════════════════════════════════════
              🗣️ DIALOGUE MODE - CONVERSATIONAL RESPONSE 🗣️
══════════════════════════════════════════════════════════════

⚠️ CRITICAL: MAXIMUM 150 WORDS. This is a conversation, not a lecture.

RULES:
- Keep response between 50-150 words MAXIMUM
- Be brief, direct, conversational
- Get to the point immediately
- Ask a follow-up question to continue the dialogue
- NO long explanations or lectures
- Include 1-2 brief quotes to ground your response in your actual works
- Written in FIRST PERSON

Be engaging. Be brief. Like talking to a smart friend.
══════════════════════════════════════════════════════════════`
          : lastMessage.content + `

══════════════════════════════════════════════════════════════
                    RESPONSE REQUIREMENTS
══════════════════════════════════════════════════════════════

📏 LENGTH: Approximately ${targetWords} words.

${numQuotes > 0 ? `📚 QUOTE REQUIREMENT: Include AT LEAST ${numQuotes} verbatim quotes from the passages above.\n` : ''}
🚨 GROUNDING REQUIREMENT - YOUR RESPONSE MUST USE THE DATABASE CONTENT 🚨

The passages above contain YOUR ACTUAL WRITINGS from the database. You MUST:
1. Use the specific content from those passages wherever it bears on the question
2. REFERENCE specific ideas, arguments, and concepts from the passages
3. USE exact phrases and terminology from the passages
4. Add established expert knowledge and sound reasoning wherever needed for the most accurate and complete answer

CRITICAL RULES:
- Written in FIRST PERSON ("I argue...", "My view is...")
- Never refer to yourself in third person
- Do NOT mention word counts or response length in your answer

══════════════════════════════════════════════════════════════`;

          const fullSystemPrompt = academicBypass + enhancedSystemPrompt;
          
          // Token limit: much lower for dialogue mode to enforce short responses
          const figureMaxTokens = effectiveDialogueMode ? 500 : 16000;

          if (currentLLM.provider === "anthropic") {
            // Claude
            if (!anthropic) throw new Error("Anthropic API key not configured");
            
            const formattedMessages = history.slice(0, -1).map(msg => ({
              role: (msg.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
              content: msg.content,
            }));
            formattedMessages.push({
              role: (lastMessage.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
              content: enhancedUserMessage,
            });

            const stream = await anthropic.messages.stream({
              model: currentLLM.model,
              max_tokens: figureMaxTokens,
              temperature: intensityTemperature,
              system: fullSystemPrompt,
              messages: formattedMessages,
            });

            for await (const chunk of stream) {
              if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
                const content = chunk.delta.text;
                fullResponse += content;
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
            }
          } else {
            // OpenAI / DeepSeek / Perplexity / Grok
            const apiClient = getOpenAIClient(currentLLM.provider);
            if (!apiClient) throw new Error(`${currentLLM.provider} API key not configured`);
            
            const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
              { role: "system", content: fullSystemPrompt }
            ];
            
            for (const msg of history.slice(0, -1)) {
              messages.push({
                role: msg.role as "user" | "assistant",
                content: msg.content,
              });
            }
            messages.push({
              role: lastMessage.role as "user" | "assistant",
              content: enhancedUserMessage,
            });
            
            const stream = await apiClient.chat.completions.create({
              model: currentLLM.model,
              messages,
              max_tokens: figureMaxTokens,
              temperature: intensityTemperature,
              stream: true,
            });

            for await (const chunk of stream) {
              const content = chunk.choices[0]?.delta?.content || "";
              if (content) {
                fullResponse += content;
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
            }
          }
          
          // If we got here, the call succeeded
          successfulModel = modelKey;
          console.log(`[FIGURE CHAT Fallback] Success with ${modelKey}`);
          break; // Exit fallback loop on success
          
        } catch (streamError) {
          lastError = streamError instanceof Error ? streamError : new Error(String(streamError));
          console.error(`[FIGURE CHAT Fallback] ${modelKey} failed:`, lastError.message);
          // Continue to next model in fallback order
          continue;
        }
      }
      
      // If no model succeeded, send error
      if (!successfulModel) {
        console.error(`[FIGURE CHAT Fallback] All models failed. Last error:`, lastError);
        res.write(`data: ${JSON.stringify({ error: "All AI providers are currently unavailable. Please try again later." })}\n\n`);
        res.end();
        return;
      }

      // Save assistant message
      await storage.createMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: fullResponse,
      });

      // Send complete audit summary based on audited search result
      const auditSummary = {
        id: `audit-${Date.now()}`,
        timestamp: Date.now(),
        question: message,
        authorId: figureId,
        authorName: figure.name,
        events: auditedResult.events,
        executionTrace: auditedResult.events,
        tablesSearched: ['positions', 'quotes', 'chunks'],
        model: successfulModel || 'unknown',
        contextLength: relevantPassages.length,
        answerType: auditedResult.answerType,
        directAnswersFound: auditedResult.directAnswers.map(da => ({
          passageId: da.passage.id,
          text: da.passage.text,
          source: da.passage.source,
          workTitle: da.passage.sourceFile || da.passage.topic,
          relevanceScore: da.relevanceScore,
          reasoning: da.reasoning
        })),
        alignmentResult: auditedResult.alignmentResult,
        finalAnswer: fullResponse
      };
      
      res.write(`data: ${JSON.stringify({ auditSummary })}\n\n`);

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      console.error("Error in figure chat:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to process message" });
      }
    }
  });

  // Write paper endpoint - generate a long-form paper (up to 5000 words) in the figure's voice
  // REWRITTEN FROM SCRATCH: Always uses database directly + coherence service
  app.post("/api/figures/:figureId/write-paper", async (req: any, res) => {
    try {
      const figureId = req.params.figureId;
      const {
        topic,
        wordLength = 1500,
        numberOfQuotes = 0,
        customInstructions = "",
        hasDocument = false,
        regenerateDeNovo = false,
      } = req.body;

      if (!topic || typeof topic !== "string") {
        return res.status(400).json({ error: "Topic is required" });
      }

      // Truncate topic for processing if it's a huge document (max 15k chars for LLM, 500 chars for embeddings)
      const maxTopicLength = 15000;
      const truncatedTopic = topic.length > maxTopicLength 
        ? topic.slice(0, maxTopicLength) + "\n\n[Document truncated - showing first 15k characters]"
        : topic;
      // Determine if this is a document rewrite request
      const isDocumentRewrite = hasDocument && topic.length > 500;
      
      // Default instructions when document uploaded with no custom instructions
      const effectiveInstructions = customInstructions.trim() || (isDocumentRewrite 
        ? "Produce the best possible version of this document. Improve clarity, strengthen arguments, enhance flow, and elevate the writing while preserving the author's voice and core ideas."
        : "");
      const deNovoRequirement = regenerateDeNovo
        ? "DE NOVO REQUIREMENT: Generate a wholly new answer from the original request and selected thinker's relevant database material. Do not reuse, revise, continue, defend, or consider any previously generated answer."
        : "";
      const governingRequest = effectiveInstructions
        ? `NON-NEGOTIABLE USER REQUIREMENTS:\n${effectiveInstructions}\n\nSUBJECT OR SOURCE MATERIAL:\n${truncatedTopic}`
        : `PAPER TOPIC:\n${truncatedTopic}`;
      const completeGoverningRequest = [deNovoRequirement, governingRequest]
        .filter(Boolean)
        .join("\n\n");
      const searchQuery = (effectiveInstructions
        ? `${effectiveInstructions}\n${truncatedTopic}`
        : truncatedTopic).slice(0, 1500);

      const targetWords = Math.min(Math.max(parseInt(wordLength) || 1500, 500), 50000);
      const targetQuotes = Math.min(Math.max(parseInt(numberOfQuotes) || 0, 0), 50);

      const figure = await storage.getThinker(figureId);
      if (!figure) {
        return res.status(404).json({ error: "Figure not found" });
      }

      // Setup SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("Content-Encoding", "identity");
      res.flushHeaders();

      // Keep-alive ping every 15 seconds to prevent connection timeout
      const keepAliveInterval = setInterval(() => {
        try {
          res.write(`: keep-alive\n\n`);
        } catch (e) {
          clearInterval(keepAliveInterval);
        }
      }, 15000);

      // Cleanup function to stop keep-alive
      const cleanup = () => {
        clearInterval(keepAliveInterval);
      };

      // Handle client disconnect
      req.on('close', cleanup);

      // Normalize author name for database queries
      const normalizedAuthor = normalizeAuthorName(figure.name);
      console.log(`[Paper Writer] Generating ${targetWords} word paper for ${figure.name} (normalized: ${normalizedAuthor}) on "${topic}"`);
      res.write(`data: ${JSON.stringify({ status: "Searching database for grounding material..." })}\n\n`);
      res.flush?.();

      // The opening preview is started only after structured author evidence is
      // retrieved and synthesized. Immediate but ungrounded prose can reverse
      // the author's documented position and must never be shown.
      let openingPreviewPromise: Promise<string> = Promise.resolve("");

      // ======
      // STEP 1: QUERY DATABASE DIRECTLY FOR GROUNDING MATERIAL
      // ======
      
      // Extract keywords for position search
      const topicKeywords = searchQuery.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((w: string) => w.length > 3);

      // 1A: Get positions from positions table (use normalized name)
      const positionsResult = await searchPositions(normalizedAuthor, topicKeywords, 20);
      console.log(`[Paper Writer] Found ${positionsResult.length} positions`);

      // 1B: Get semantic chunks from chunks table (use normalized name) - use truncated query for embeddings
      const chunksResult = await searchPhilosophicalChunks(truncatedTopic, 20, "common", normalizedAuthor);
      console.log(`[Paper Writer] Found ${chunksResult.length} semantic chunks`);
      const primaryTextChunks = await searchTextChunks(
        normalizedAuthor,
        truncatedTopic,
        30,
      );
      console.log(`[Paper Writer] Found ${primaryTextChunks.length} topic-matched primary-text chunks`);
      const sourceAnchors = chunksResult
        .map((chunk) => {
          const content = chunk.content.toLowerCase();
          const conceptMatches = [
            "logic",
            "logical",
            "spatiotemporal",
            "non-spatiotemporal",
            "entities",
            "properties",
            "propositions",
          ].filter((term) =>
            truncatedTopic.toLowerCase().includes(term.replace("non-", ""))
              ? content.includes(term)
              : false
          ).length;
          return {
            sourceFile: chunk.paperTitle,
            chunkIndex: chunk.chunkIndex,
            conceptMatches,
          };
        })
        .filter((anchor) => anchor.conceptMatches >= 2)
        .sort((a, b) => b.conceptMatches - a.conceptMatches)
        .slice(0, 8);
      const sourceNeighborhoodChunks = await getSourceChunkNeighborhoods(
        normalizedAuthor,
        sourceAnchors,
        7,
        100,
      );
      console.log(
        `[Paper Writer] Found ${sourceNeighborhoodChunks.length} neighboring primary-text chunks`,
      );

      // 1C: Build a topic-ranked pool of direct quotations. Curated quotations
      // and verbatim excerpts from the semantically retrieved source chunks are
      // ranked together; random unrelated quotations are never used merely to
      // satisfy the requested count.
      type QuoteCandidate = {
        text: string;
        source: "curated" | "semantic-chunk";
        sourceRank: number;
        topic: string;
      };
      const quoteCandidates = new Map<string, QuoteCandidate>();
      const quoteKeywordStopWords = new Set([
        "about", "after", "again", "against", "among", "because", "before",
        "being", "between", "could", "differ", "does", "every", "first",
        "from", "have", "having", "however", "into", "itself", "might",
        "other", "should", "since", "their", "there", "these", "thing",
        "those", "through", "under", "which", "while", "with", "would",
      ]);
      const relevanceCorpus = [
        searchQuery,
        ...positionsResult.flatMap((position: any) => [
          String(position.topic || ""),
          String(position.position || ""),
        ]),
        ...chunksResult.slice(0, 8).map((chunk: any) => String(chunk.content || "")),
      ]
        .join(" ")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, " ");
      const keywordFrequency = new Map<string, number>();
      relevanceCorpus.split(/\s+/).forEach((word) => {
        const normalized = word.replace(/^-+|-+$/g, "");
        if (
          normalized.length >= 5
          && !quoteKeywordStopWords.has(normalized)
        ) {
          keywordFrequency.set(
            normalized,
            (keywordFrequency.get(normalized) || 0) + 1,
          );
        }
      });
      const relevancePrefixes = Array.from(new Set(
        [...topicKeywords, ...Array.from(keywordFrequency.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 45)
          .map(([word]) => word)]
          .filter((word: string) => word.length >= 5)
          .map((word: string) => word.slice(0, Math.min(5, word.length))),
      ));
      const maximumQuoteWords = targetQuotes > 0
        ? Math.max(
            14,
            Math.min(32, Math.floor((targetWords * 0.42) / targetQuotes)),
          )
        : 32;
      const addQuoteCandidate = (
        raw: string,
        source: QuoteCandidate["source"],
        sourceRank: number,
        candidateTopic = "",
      ) => {
        const clean = String(raw || "")
          .replace(/\s+/g, " ")
          .replace(/^["“”']+|["“”']+$/g, "")
          .trim();
        const words = clean.split(/\s+/).filter(Boolean);
        if (words.length < 8 || words.length > maximumQuoteWords) return;
        if (!/^[A-Z0-9“‘'"[(]/.test(clean)) return;
        if (!/[.!?][”’'")\]]*$/.test(clean)) return;
        if (/(?:\.{3}|…|\d[A-Za-z]|[a-z][A-Z])/.test(clean)) return;
        if (/\b(?:thedistinction|theproperty)\b/i.test(clean)) return;
        if (/^on .+ translated by\b/i.test(clean) || /\btranslated by\b/i.test(clean)) return;
        const key = clean.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
        if (!key || quoteCandidates.has(key)) return;
        quoteCandidates.set(key, {
          text: clean,
          source,
          sourceRank,
          topic: String(candidateTopic || ""),
        });
      };

      try {
        const curatedLimit = Math.max(1000, targetQuotes * 250);
        const quotesResult = await db.execute(
          sql`SELECT quote_text, topic FROM quotes
              WHERE LOWER(thinker) = LOWER(${normalizedAuthor})
                 OR LOWER(thinker) = LOWER(${figureId})
              LIMIT ${curatedLimit}`
        );
        (quotesResult.rows || []).forEach((row: any, index: number) => {
          addQuoteCandidate(row.quote_text, "curated", index, row.topic);
        });
      } catch (e) {
        console.log(`[Paper Writer] Quotes query failed (table may not exist): ${e}`);
      }

      chunksResult.forEach((chunk: any, chunkIndex: number) => {
        const content = String(chunk.content || "");
        content.split(/(?<=[.!?])\s+/).forEach((sentence) => {
          addQuoteCandidate(sentence, "semantic-chunk", chunkIndex);
        });
      });

      const scoreQuoteCandidate = (candidate: QuoteCandidate) => {
        const quoteText = candidate.text.toLowerCase();
        const topicText = candidate.topic.toLowerCase();
        const textMatches = relevancePrefixes.filter((prefix) => quoteText.includes(prefix)).length;
        const topicMatches = relevancePrefixes.filter((prefix) => topicText.includes(prefix)).length;
        const semanticRankBonus = candidate.source === "semantic-chunk"
          ? Math.max(0, 30 - candidate.sourceRank * 2)
          : 0;
        const curatedQualityBonus = candidate.source === "curated" ? 10 : 0;
        const conciseBonus = candidate.text.split(/\s+/).length <= 24 ? 6 : 0;
        return topicMatches * 20
          + textMatches * 6
          + semanticRankBonus
          + curatedQualityBonus
          + conciseBonus;
      };

      const normalizedQuoteTokens = (text: string) => new Set(
        text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .split(/\s+/)
          .filter((word) => word.length >= 4),
      );
      const quoteSimilarity = (left: string, right: string) => {
        const leftTokens = normalizedQuoteTokens(left);
        const rightTokens = normalizedQuoteTokens(right);
        if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
        const overlap = Array.from(leftTokens).filter((token) =>
          rightTokens.has(token),
        ).length;
        return overlap / Math.min(leftTokens.size, rightTokens.size);
      };
      const rankedQuoteCandidates = Array.from(quoteCandidates.values())
        .sort((a, b) => scoreQuoteCandidate(b) - scoreQuoteCandidate(a));
      const desiredQuotePoolSize = targetQuotes > 0 ? targetQuotes : 15;
      const diversifiedCandidatePool: QuoteCandidate[] = [];
      const candidatePoolLimit = Math.max(400, desiredQuotePoolSize * 20);
      for (const candidate of rankedQuoteCandidates) {
        if (
          diversifiedCandidatePool.some(
            (selected) => quoteSimilarity(selected.text, candidate.text) >= 0.72,
          )
        ) {
          continue;
        }
        diversifiedCandidatePool.push(candidate);
        if (diversifiedCandidatePool.length >= candidatePoolLimit) break;
      }

      const selectedQuoteCandidates: QuoteCandidate[] = [];
      if (
        targetQuotes > 0
        && diversifiedCandidatePool.length >= desiredQuotePoolSize
      ) {
        try {
          res.write(`data: ${JSON.stringify({ status: "Selecting the most relevant complete source quotations..." })}\n\n`);
          const candidatePayload = diversifiedCandidatePool.map(
            (candidate, index) => ({
              id: `C${index + 1}`,
              topic: candidate.topic,
              text: candidate.text,
            }),
          );
          const selectionResponse = await streamWithFallback({
            res,
            systemPrompt: `You select primary-source quotations for a focused philosophy paper. Choose only quotations that directly advance the requested comparison. Reject material that is merely generally philosophical or tangential. Prefer a coherent, diverse set covering the concepts actually needed by the topic. Return only JSON.`,
            userPrompt: `Governing request: ${completeGoverningRequest}
Author whose primary-source quotations must be selected: ${figure.name}
Required number: ${desiredQuotePoolSize}

Choose exactly ${desiredQuotePoolSize} candidate IDs. Prioritize only material that directly supports the user's required thesis and requested lines of argument. Do not select tangents merely because they come from the same author. Avoid redundant quotations and reject any candidate whose main subject is absent from the governing request.

Candidates:
${JSON.stringify(candidatePayload)}

Return exactly:
{"selected":["C1","C2"]}`,
            maxTokens: Math.max(800, desiredQuotePoolSize * 40),
            temperature: 0.1,
            startProvider: "anthropic",
            onContent: () => {},
            emitContent: false,
          });
          const firstBrace = selectionResponse.indexOf("{");
          const lastBrace = selectionResponse.lastIndexOf("}");
          if (firstBrace >= 0 && lastBrace > firstBrace) {
            const parsed = JSON.parse(
              selectionResponse.slice(firstBrace, lastBrace + 1),
            );
            const selectedIds = Array.isArray(parsed?.selected)
              ? parsed.selected
              : [];
            for (const selectedId of selectedIds) {
              const match = /^C(\d+)$/.exec(String(selectedId));
              const candidate = match
                ? diversifiedCandidatePool[Number(match[1]) - 1]
                : undefined;
              if (
                !candidate
                || selectedQuoteCandidates.includes(candidate)
                || selectedQuoteCandidates.some(
                  (selected) =>
                    quoteSimilarity(selected.text, candidate.text) >= 0.72,
                )
              ) {
                continue;
              }
              selectedQuoteCandidates.push(candidate);
              if (
                selectedQuoteCandidates.length >= desiredQuotePoolSize
              ) {
                break;
              }
            }
          }
        } catch (selectionError) {
          console.warn(
            "[Paper Writer] Focused quotation selection failed; using deterministic ranking:",
            selectionError,
          );
        }
      }
      for (const candidate of diversifiedCandidatePool) {
        if (selectedQuoteCandidates.length >= desiredQuotePoolSize) break;
        if (
          selectedQuoteCandidates.some(
            (selected) => quoteSimilarity(selected.text, candidate.text) >= 0.72,
          )
        ) {
          continue;
        }
        selectedQuoteCandidates.push(candidate);
      }
      const quotes = selectedQuoteCandidates.map((candidate) => candidate.text);
      console.log(`[Paper Writer] Selected ${quotes.length}/${targetQuotes || 15} topic-ranked verified quotations`);

      // 1D: Retrieve arguments by relevance to the governing request.
      let args: string[] = [];
      let argumentResults: any[] = [];
      try {
        argumentResults = await searchArgumentStatements(
          normalizedAuthor,
          searchQuery,
          60,
        );
        args = argumentResults.map((argument) =>
          `[${argument.sourceSection || "Relevant argument"}] Premises: ${JSON.stringify(argument.premises)} → Conclusion: ${argument.conclusion}`
        );
        console.log(`[Paper Writer] Found ${args.length} arguments`);
      } catch (e) {
        console.log(`[Paper Writer] Arguments query failed (table may not exist): ${e}`);
      }

      const argumentGuidedTextChunks = argumentResults.length > 0
        ? await searchTextChunks(
            normalizedAuthor,
            argumentResults
              .slice(0, 15)
              .flatMap((argument) => [
                String(argument.sourceSection || ""),
                String(argument.conclusion || ""),
                JSON.stringify(argument.premises || []),
              ])
              .join("\n")
              .slice(0, 12000),
            30,
          )
        : [];
      const primarySourceChunks = Array.from(
        new Map(
          [
            ...sourceNeighborhoodChunks,
            ...chunksResult.map((chunk) => ({
              sourceFile: chunk.paperTitle,
              chunkIndex: chunk.chunkIndex,
              chunkText: chunk.content,
            })),
            ...argumentGuidedTextChunks,
            ...primaryTextChunks,
          ].map((chunk) => [
            `${chunk.sourceFile}:${chunk.chunkIndex}:${chunk.chunkText.slice(0, 120)}`,
            chunk,
          ]),
        ).values(),
      );
      console.log(
        `[Paper Writer] Built ${primarySourceChunks.length} unique primary-source chunks (${argumentGuidedTextChunks.length} argument-guided)`,
      );

      let authorEvidenceBrief = "";
      let bindingDirectAnswer = "";
      if (argumentResults.length > 0) {
        const evidenceResponse = await streamWithFallback({
          res,
          systemPrompt: `You synthesize a selected author's documented position. Verbatim primary-source passages are authoritative and govern all derived structured arguments. Determine what the primary text directly supports, including the polarity of yes/no questions. Every clause in the direct answer must be supported by a verbatim sentence you copy from the supplied primary text. Preserve existential and universal quantifiers exactly. Do not conflate categories that the source distinguishes, substitute textbook knowledge, infer a nearby view, or resolve tensions by inventing a compromise. Return only JSON.`,
          userPrompt: `QUESTION AND USER REQUIREMENTS:
${completeGoverningRequest}

VERBATIM PRIMARY-SOURCE PASSAGES:
${primarySourceChunks.slice(0, 35).map((chunk) =>
  `[Source ${chunk.sourceFile}, chunk ${chunk.chunkIndex}]\n${chunk.chunkText}`
).join("\n\n")}

RANKED STRUCTURED ARGUMENTS:
${args.slice(0, 35).join("\n")}

Return exactly:
{"directAnswer":"one sentence of no more than 40 words stating only the direct answer and its immediate source-supported reason; do not add examples or secondary objections","verbatimSupport":["exact sentence copied from the primary text"],"supportingClaims":["claim grounded in a quoted primary-source sentence"],"unsupportedOrConflictingClaims":["claims the records do not support or explicitly reject"],"sufficient":true}

Set sufficient=false if the records do not answer the question.`,
          maxTokens: 1600,
          temperature: 0.05,
          startProvider: "deepseek",
          onContent: () => {},
          emitContent: false,
        });
        const firstBrace = evidenceResponse.indexOf("{");
        const lastBrace = evidenceResponse.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          const evidence = JSON.parse(
            evidenceResponse.slice(firstBrace, lastBrace + 1),
          );
          bindingDirectAnswer = String(evidence.directAnswer || "").trim();
          authorEvidenceBrief = [
            `Direct answer: ${bindingDirectAnswer}`,
            `Supported claims: ${Array.isArray(evidence.supportingClaims) ? evidence.supportingClaims.join(" | ") : ""}`,
            `Unsupported or conflicting claims: ${Array.isArray(evidence.unsupportedOrConflictingClaims) ? evidence.unsupportedOrConflictingClaims.join(" | ") : ""}`,
            `Evidence sufficient: ${evidence.sufficient !== false}`,
          ].join("\n");
          console.log(
            `[Paper Writer] Binding database answer: ${bindingDirectAnswer.slice(0, 300)}`,
          );
        }
      }

      if (targetQuotes > 0 && quotes.length < targetQuotes) {
        cleanup();
        res.write(`data: ${JSON.stringify({
          error: `Only ${quotes.length} verified source quotations were available; ${targetQuotes} were requested`,
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const selectedQuotes = targetQuotes > 0 ? quotes.slice(0, targetQuotes) : [];
      res.write(`data: ${JSON.stringify({ status: `Found ${positionsResult.length} positions, ${chunksResult.length} chunks, ${selectedQuotes.length} verified quotes, ${args.length} arguments` })}\n\n`);

      // ======
      // STEP 2: BUILD COHERENCE MATERIAL FROM DATABASE RESULTS
      // ======
      const coherenceMaterial = {
        quotes: selectedQuotes,
        positions: args.length > 0
          ? []
          : positionsResult.map(p => `[${p.topic}] ${p.position}`),
        arguments: args,
        chunks: Array.from(new Set([
          ...primarySourceChunks.map((chunk) => chunk.chunkText),
          ...chunksResult.map((chunk) => chunk.content),
        ])),
        deductions: ""
      };

      // Verify we have grounding material
      const totalMaterial = coherenceMaterial.quotes.length + 
                           coherenceMaterial.positions.length + 
                           coherenceMaterial.arguments.length +
                           coherenceMaterial.chunks.length;
      
      if (totalMaterial === 0) {
        console.error(`[Paper Writer] NO GROUNDING MATERIAL FOUND for ${figure.name}`);
        cleanup();
        res.write(`data: ${JSON.stringify({ error: "No grounding material found in database for this figure" })}\n\n`);
        res.end();
        return;
      }

      console.log(`[Paper Writer] Total grounding: ${totalMaterial} items`);

      // Build grounding context from database material
      const groundingContext = [
        "=== BINDING AUTHOR-EVIDENCE SUMMARY ===",
        authorEvidenceBrief || "No structured evidence summary was available.",
        "",
        "=== VERBATIM PRIMARY-SOURCE PASSAGES ===",
        ...primarySourceChunks.slice(0, 45).map((chunk) =>
          `[Source ${chunk.sourceFile}, chunk ${chunk.chunkIndex}]\n${chunk.chunkText}`
        ),
        "",
        "=== RELEVANT STRUCTURED ARGUMENTS FROM DATABASE ===",
        ...coherenceMaterial.arguments.slice(0, 60),
        "",
        "=== POSITIONS FROM DATABASE ===",
        ...coherenceMaterial.positions.slice(0, 15),
        "",
        "=== QUOTES FROM DATABASE ===",
        ...coherenceMaterial.quotes,
        "",
        "=== TEXT CHUNKS FROM DATABASE ===",
        ...coherenceMaterial.chunks.slice(0, 8)
      ].join("\n");

      openingPreviewPromise = streamWithFallback({
        res,
        systemPrompt: `Write as ${figure.name} in a clear, authoritative first-person voice. Produce only the opening paragraph of a serious paper. The binding author-evidence summary and structured database arguments govern every substantive claim. Never contradict their direct answer or polarity. Do not use outside model knowledge, quotations, citations, headings, notes, or meta-commentary.`,
        userPrompt: `${completeGoverningRequest}

${groundingContext.slice(0, 10000)}

Write approximately 100 words that immediately state and frame the database-grounded answer.`,
        maxTokens: 180,
        temperature: 0.3,
        startProvider: "anthropic",
        emitContent: true,
      }).catch((previewError) => {
        console.warn("[Paper Writer] Grounded opening preview failed:", (previewError as Error).message);
        return "";
      });

      // ======
      // STEP 3: THREE-PASS SEMANTIC SKELETON ARCHITECTURE
      // ======
      
      // PASS 1: Extract Global Skeleton BEFORE any generation
      res.write(`data: ${JSON.stringify({ status: "PASS 1: Extracting semantic skeleton..." })}\n\n`);
      console.log(`[Paper Writer] PASS 1: Extracting skeleton for ${targetWords} word paper`);
      
      let skeleton: GlobalSkeleton;
      try {
        const skeletonInput = isDocumentRewrite
          ? completeGoverningRequest
          : `${completeGoverningRequest}\n\nPOTENTIALLY RELEVANT GROUNDING MATERIAL:\n${groundingContext.slice(0, 14000)}\n\nUse grounding only when it directly supports the governing request. Exclude every unrelated theme.`;
        
        skeleton = await extractGlobalSkeleton(
          skeletonInput,
          effectiveInstructions,
          anthropic ? 'claude' : 'gpt-4o'
        );
        if (bindingDirectAnswer) {
          skeleton.thesis = bindingDirectAnswer;
          skeleton.commitmentLedger.asserts = [
            bindingDirectAnswer,
            ...skeleton.commitmentLedger.asserts.filter(
              (claim) => claim !== bindingDirectAnswer,
            ),
          ];
        }
        
        console.log(`[Paper Writer] Skeleton extracted: ${skeleton.outline.length} outline items, thesis: ${skeleton.thesis.slice(0, 100)}`);
        res.write(`data: ${JSON.stringify({ 
          skeleton: { 
            outline: skeleton.outline, 
            thesis: skeleton.thesis,
            keyTermsCount: Object.keys(skeleton.keyTerms).length 
          } 
        })}\n\n`);
        
        // Store job in database
        const jobId = await initializeReconstructionJob(
          isDocumentRewrite ? truncatedTopic : `Topic: ${truncatedTopic}`,
          effectiveInstructions,
          targetWords
        );
        await updateJobSkeleton(jobId, skeleton);
        console.log(`[Paper Writer] Job created: ${jobId}`);
        
      } catch (skeletonError) {
        console.error(`[Paper Writer] Skeleton extraction failed:`, skeletonError);
        // Create minimal skeleton to continue
        skeleton = {
          outline: [`Write a ${targetWords} word paper on: ${truncatedTopic.slice(0, 200)}`],
          thesis: truncatedTopic.slice(0, 500),
          keyTerms: {},
          commitmentLedger: { asserts: [], rejects: [], assumes: [] },
          entities: [],
          audienceParameters: 'academic',
          rigorLevel: 'academic'
        };
      }

      // Calculate length mode for chunk generation
      const inputWords = (isDocumentRewrite ? truncatedTopic : groundingContext).split(/\s+/).length;
      const lengthRatio = targetWords / Math.max(inputWords, 1);
      const lengthMode = lengthRatio < 0.5 ? 'heavy_compression' : 
                         lengthRatio < 0.8 ? 'moderate_compression' :
                         lengthRatio < 1.2 ? 'maintain' :
                         lengthRatio < 1.8 ? 'moderate_expansion' : 'heavy_expansion';
      
      const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;
      const closeAtExactWordCount = async (
        text: string,
        limit: number,
        requiredPhrases: string[],
      ) => {
        const clean = text.trim();
        if (countWords(clean) === limit && /[.!?]['”)\]]*$/.test(clean)) {
          return clean;
        }

        const completeParagraphs = clean
          .split(/\n\s*\n/)
          .map((paragraph) => {
            const trimmed = paragraph.trim();
            if (/[.!?]['”)\]]*$/.test(trimmed)) return trimmed;
            const completeEnding = Array.from(
              trimmed.matchAll(/[.!?](?:['”)\]]*)?(?=\s|$)/g),
            ).at(-1);
            return completeEnding
              ? trimmed.slice(0, completeEnding.index! + completeEnding[0].length).trim()
              : "";
          });
        const requiredParagraphIndexes = new Set<number>();
        const escapedClosingFigureName = figure.name.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const closingSelfReferencePattern = new RegExp(
          `\\b${escapedClosingFigureName}(?:['’]s)?\\b`,
          "i",
        );
        for (const phrase of requiredPhrases) {
          const paragraphIndex = completeParagraphs.findIndex((paragraph) =>
            paragraph.includes(phrase),
          );
          if (paragraphIndex < 0) {
            throw new Error(
              "A quotation paragraph was incomplete after organic revision; refusing to insert canned repair prose",
            );
          }
          requiredParagraphIndexes.add(paragraphIndex);
        }
        const firstProseIndex = completeParagraphs.findIndex(
          (paragraph) =>
            paragraph.length > 0
            && !/^#{1,6}\s/.test(paragraph)
            && !closingSelfReferencePattern.test(paragraph),
        );
        if (firstProseIndex >= 0) requiredParagraphIndexes.add(firstProseIndex);

        const minimumClosingWords = Math.min(
          80,
          Math.max(32, Math.floor(limit * 0.05)),
        );
        let selectedWords = Array.from(requiredParagraphIndexes).reduce(
          (sum, index) => sum + countWords(completeParagraphs[index]),
          0,
        );
        if (selectedWords > limit - minimumClosingWords) {
          throw new Error(
            `Organic quotation paragraphs need ${selectedWords} words, which does not fit a complete ${limit}-word paper`,
          );
        }
        const selectedParagraphIndexes = new Set(requiredParagraphIndexes);
        completeParagraphs.forEach((paragraph, index) => {
          if (
            selectedParagraphIndexes.has(index)
            || paragraph.length === 0
            || /^#{1,6}\s/.test(paragraph)
            || closingSelfReferencePattern.test(paragraph)
          ) {
            return;
          }
          const paragraphWords = countWords(paragraph);
          if (selectedWords + paragraphWords <= limit - minimumClosingWords) {
            selectedParagraphIndexes.add(index);
            selectedWords += paragraphWords;
          }
        });
        let bestPrefix = completeParagraphs
          .filter((_, index) => selectedParagraphIndexes.has(index))
          .join("\n\n")
          .trim();

        const wordsNeeded = limit - countWords(bestPrefix);
        let closing = "";
        let closingFeedback = "";
        const naturalClosingCandidates: string[] = [];
        for (let attempt = 0; attempt < 6 && !closing; attempt++) {
          const response = await streamWithFallback({
            res,
            systemPrompt: `You are ${figure.name}, finishing a philosophical paper in first person. Write a natural conclusion that follows from the supplied preceding prose. Never refer to ${figure.name} by name or in the third person. Do not discuss writing, quotations, evidence mechanics, or word counts. Do not introduce direct quotations.

Return only a JSON array of objects shaped {"word":"one-token","optional":boolean}. Each word must be exactly one whitespace-delimited token, including attached punctuation. Mark optional=true only for independently removable adjectives or adverbs whose deletion leaves the sentences fully grammatical. Never mark articles, prepositions, conjunctions, nouns, verbs, pronouns, negations, or punctuated words optional.`,
            userPrompt: `${completeGoverningRequest}

Immediately preceding prose:
${bestPrefix.slice(-1800)}

Create one or two complete concluding sentences containing between ${wordsNeeded + 8} and ${wordsNeeded + 18} word objects. Mark at least 18 independently removable modifier words optional=true. The final word must end in punctuation and must not be optional.
${closingFeedback}`,
            maxTokens: Math.max(900, wordsNeeded * 12),
            temperature: 0.25,
            startProvider: "anthropic",
            onContent: () => {},
            emitContent: false,
          });
          const firstBracket = response.indexOf("[");
          const lastBracket = response.lastIndexOf("]");
          let wordItems: Array<{ word: string; optional: boolean }> = [];
          if (firstBracket >= 0 && lastBracket > firstBracket) {
            try {
              const parsed = JSON.parse(
                response.slice(firstBracket, lastBracket + 1),
              );
              if (Array.isArray(parsed)) {
                const safeModifierPattern =
                  /^(?:also|clearly|coherently|directly|distinctly|even|fully|fundamentally|genuinely|indeed|intrinsically|naturally|necessarily|precisely|properly|quite|rather|systematically|still|therefore|truly|ultimately|very),?$/i;
                const normalizedItems = parsed.map((item) => {
                  if (
                    typeof item === "string"
                    && item.length > 0
                    && !/\s/.test(item)
                  ) {
                    return {
                      word: item,
                      optional: safeModifierPattern.test(item),
                    };
                  }
                  const word = item?.word ?? item?.text;
                  if (
                    typeof word === "string"
                    && word.length > 0
                    && !/\s/.test(word)
                  ) {
                    return {
                      word,
                      optional:
                        item?.optional === true
                        || safeModifierPattern.test(word),
                    };
                  }
                  return null;
                });
                if (normalizedItems.every(Boolean)) {
                  wordItems = normalizedItems as Array<{
                    word: string;
                    optional: boolean;
                  }>;
                }
              }
            } catch {
              wordItems = [];
            }
          }
          const excessWords = wordItems.length - wordsNeeded;
          const removableIndexes = wordItems
            .map((item, index) => ({ item, index }))
            .filter(
              ({ item, index }) =>
                item.optional
                && index < wordItems.length - 1
                && !/[.!?]$/.test(item.word),
            )
            .map(({ index }) => index);
          const indexesToRemove = new Set(
            excessWords >= 0 && removableIndexes.length >= excessWords
              ? removableIndexes.slice(0, excessWords)
              : [],
          );
          const candidateWords = wordItems
            .filter((_, index) => !indexesToRemove.has(index))
            .map((item) => item.word);
          const candidate = candidateWords.join(" ");
          const naturalCandidate = wordItems
            .map((item) => item.word)
            .join(" ");
          const invalidLanguage =
            /["“”]|\[\[Q\d+\]\]|\b(?:word count|this passage|this quotation|this quote|direct evidence|the paper)\b/i.test(
              candidate,
            ) || closingSelfReferencePattern.test(candidate);
          const naturalCandidateIsValid =
            naturalCandidate.length > 0
            && countWords(naturalCandidate) >= 24
            && countWords(naturalCandidate) <= 140
            && /[.!?]['”)\]]*$/.test(naturalCandidate)
            && !/["“”]|\[\[Q\d+\]\]|\b(?:word count|this passage|this quotation|this quote|direct evidence|the paper)\b/i.test(
              naturalCandidate,
            )
            && !closingSelfReferencePattern.test(naturalCandidate);
          if (
            naturalCandidateIsValid
            && !naturalClosingCandidates.includes(naturalCandidate)
          ) {
            naturalClosingCandidates.push(naturalCandidate);
          }
          if (
            excessWords >= 0
            && indexesToRemove.size === excessWords
            && candidateWords.length === wordsNeeded
            && /[.!?]['”)\]]*$/.test(candidate)
            && !invalidLanguage
          ) {
            closing = candidate;
          } else {
            closingFeedback = `Your previous array had ${wordItems.length} valid items and ${removableIndexes.length} safely removable items, or it contained invalid language. Return the requested longer conclusion with enough optional modifier objects and nothing except the JSON array.`;
          }
        }
        if (!closing && naturalClosingCandidates.length > 0) {
          const requiredBodyWords = Array.from(requiredParagraphIndexes).reduce(
            (sum, index) => sum + countWords(completeParagraphs[index]),
            0,
          );
          const optionalSentenceUnits = completeParagraphs.flatMap(
            (paragraph, paragraphIndex) => {
              if (
                requiredParagraphIndexes.has(paragraphIndex)
                || paragraph.length === 0
                || /^#{1,6}\s/.test(paragraph)
                || closingSelfReferencePattern.test(paragraph)
              ) {
                return [];
              }
              return paragraph
                .split(/(?<=[.!?])\s+(?=[A-Z0-9“‘'"(])/)
                .map((sentence) => sentence.trim())
                .filter(
                  (sentence) =>
                    countWords(sentence) >= 4
                    && /[.!?]['”)\]]*$/.test(sentence),
                )
                .map((sentence) => ({
                  paragraphIndex,
                  sentence,
                  words: countWords(sentence),
                }));
            },
          );

          for (const naturalCandidate of naturalClosingCandidates) {
            const optionalWordsNeeded =
              limit - requiredBodyWords - countWords(naturalCandidate);
            if (optionalWordsNeeded < 0) continue;
            const combinations: (number[] | null)[] = Array(
              optionalWordsNeeded + 1,
            ).fill(null);
            combinations[0] = [];
            for (
              let unitIndex = 0;
              unitIndex < optionalSentenceUnits.length;
              unitIndex++
            ) {
              const unitWords = optionalSentenceUnits[unitIndex].words;
              for (
                let total = optionalWordsNeeded - unitWords;
                total >= 0;
                total--
              ) {
                if (
                  combinations[total]
                  && !combinations[total + unitWords]
                ) {
                  combinations[total + unitWords] = [
                    ...combinations[total]!,
                    unitIndex,
                  ];
                }
              }
            }
            const selectedUnitIndexes = combinations[optionalWordsNeeded];
            if (!selectedUnitIndexes) continue;
            const unitsByParagraph = new Map<number, string[]>();
            selectedUnitIndexes.forEach((unitIndex) => {
              const unit = optionalSentenceUnits[unitIndex];
              const existing = unitsByParagraph.get(unit.paragraphIndex) || [];
              existing.push(unit.sentence);
              unitsByParagraph.set(unit.paragraphIndex, existing);
            });
            bestPrefix = completeParagraphs
              .map((paragraph, paragraphIndex) => {
                if (requiredParagraphIndexes.has(paragraphIndex)) {
                  return paragraph;
                }
                return (unitsByParagraph.get(paragraphIndex) || []).join(" ");
              })
              .filter(Boolean)
              .join("\n\n")
              .trim();
            closing = naturalCandidate;
            break;
          }
        }
        if (!closing) {
          throw new Error(
            `Could not produce a natural exact-length conclusion of ${wordsNeeded} words: ${closingFeedback}`,
          );
        }
        const completed = `${bestPrefix}\n\n${closing}`.trim();
        if (countWords(completed) !== limit || !/[.!?]['”)\]]*$/.test(completed)) {
          throw new Error(`Complete-ending validation failed at ${countWords(completed)}/${limit} body words`);
        }
        return completed;
      };

      const quoteExcerpts = selectedQuotes.map((quote) =>
        prepareSourceQuotation(quote),
      );
      const totalQuotedWords = quoteExcerpts.reduce(
        (sum, quote) => sum + countWords(quote),
        0,
      );
      const quoteMarkers = quoteExcerpts.map((_, index) => `[[Q${index + 1}]]`);
      const formattedQuotes = quoteExcerpts.map((quote, index) => `${index + 1}. “${quote}”`);
      const quoteAppendix = formattedQuotes.length > 0
        ? `\n\n## Direct Quotations Used\n\n${formattedQuotes.join("\n\n")}`
        : "";
      const quoteAppendixWords = countWords(quoteAppendix);
      const proseTargetWords = targetWords;
      const minimumAcceptedWords = Math.floor(proseTargetWords * 0.85);
      const maximumAcceptedWords = Math.ceil(proseTargetWords * 1.15);
      const minimumAnalyticalBodyWords =
        totalQuotedWords + targetQuotes * 12 + 100;
      if (targetQuotes > 0 && maximumAcceptedWords < minimumAnalyticalBodyWords) {
        cleanup();
        res.write(`data: ${JSON.stringify({
          error: `${targetWords} words is too short to use and analyze ${targetQuotes} quotations. Increase the paper length or request fewer quotations.`,
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const plannedChunks = Math.max(1, Math.ceil(proseTargetWords / 450));
      const generationTargetWords = proseTargetWords + Math.max(
        120,
        Math.min(220, Math.floor(proseTargetWords * 0.18)),
      );
      const maxGenerationAttempts = plannedChunks + 8;

      const markerAssignments = Array.from({ length: plannedChunks }, () => [] as string[]);
      const quoteIntegrationChunks = Math.max(1, plannedChunks - 1);
      quoteMarkers.forEach((marker, index) => {
        markerAssignments[index % quoteIntegrationChunks].push(marker);
      });
      const quoteByMarker = new Map(
        quoteMarkers.map((marker, index) => [marker, quoteExcerpts[index]]),
      );
      const markerPattern = (marker: string) => new RegExp(
        marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "g",
      );
      const markerCount = (content: string, marker: string) =>
        (content.match(markerPattern(marker)) || []).length;
      const missingQuoteMarkers = (content: string) =>
        quoteMarkers.filter((marker) => markerCount(content, marker) === 0);
      const expandQuoteMarkers = (content: string) => {
        let expanded = content;
        quoteMarkers.forEach((marker) => {
          expanded = expanded.replace(markerPattern(marker), `“${quoteByMarker.get(marker)}”`);
        });
        return expanded;
      };
      const dedupeQuoteMarkers = (content: string) => {
        let deduped = content;
        quoteMarkers.forEach((marker) => {
          let seen = false;
          deduped = deduped.replace(markerPattern(marker), () => {
            if (seen) return "";
            seen = true;
            return marker;
          });
        });
        return deduped;
      };
      
      console.log(`[Paper Writer] Length mode: ${lengthMode}, body target ${proseTargetWords} words with ${formattedQuotes.length} integrated quotes, plus a separately counted ${quoteAppendixWords}-word reference list`);
      await openingPreviewPromise;
      res.write(`data: ${JSON.stringify({ reset_content: true })}\n\n`);
      res.flush?.();
      res.write(`data: ${JSON.stringify({ status: `PASS 2: Integrating and analyzing ${formattedQuotes.length} verified quotations in the paper body...` })}\n\n`);
      res.flush?.();

      // Check provider availability (any provider in the fallback chain counts)
      if (!getFallbackModels("anthropic").some(isProviderAvailable)) {
        console.error("[Paper Writer] No AI provider configured");
        cleanup();
        res.write(`data: ${JSON.stringify({ error: "No AI provider configured" })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const quotesInstruction = targetQuotes > 0 
        ? `\nREQUIRED DIRECT QUOTATIONS:
${quoteMarkers.map((marker, index) => `- ${marker} represents exactly: “${quoteExcerpts[index]}”`).join("\n")}

QUOTATION RULES:
- Insert every required marker exactly once in the body.
- Introduce each marker as evidence and explain its relevance to the paper's argument in the same paragraph.
- Never place markers in a detached list, blockquote collection, or quotation-only paragraph.
- Place all required markers before the final third of the body so none is lost during exact-length validation.
- Output the marker token, not the quotation text; the system replaces it with the verified source wording.
- Do not use any other direct quotation marks or add a quotation list. The system creates a reference list containing only quotations verified as used in the body.`
        : "";

      // PASS 2: Generate chunks CONSTRAINED BY the skeleton
      let totalContent = "";
      let totalWordCount = 0;
      const allDeltas: { chunkIndex: number; newClaims: string[]; conflictsDetected: string[] }[] = [];
      
      // Build skeleton-constrained system prompt
      const skeletonSystemPrompt = `You are ${figure.name}. Write in first person as this philosopher.

NON-NEGOTIABLE USER REQUIREMENTS — THESE OVERRIDE THE SKELETON AND ALL RETRIEVED MATERIAL:
${effectiveInstructions || `Address exactly this topic: ${truncatedTopic}`}
${deNovoRequirement}

Relevance rule: every paragraph must directly serve those requirements. Never introduce a theme merely because it appears in retrieved material. If retrieved material conflicts with or wanders beyond the requirements, ignore it.
Evidence rule: factual and empirical claims must be supported by the supplied grounding material. Do not add studies, interventions, measurements, or causal claims from general model memory.
Instruction-fidelity rule: preserve the exact logical force and polarity of every user requirement. Do not strengthen "does not validate" into "refutes," "invalidates," or "falsifies"; do not weaken "proves" into "suggests"; and do not substitute a nearby philosophical thesis.

GLOBAL SKELETON - YOU MUST FOLLOW THIS STRUCTURE:
THESIS: ${skeleton.thesis}
OUTLINE: ${skeleton.outline.map((o, i) => `${i + 1}. ${o}`).join('\n')}

KEY TERMS (use these definitions consistently):
${Object.entries(skeleton.keyTerms).map(([k, v]) => `- ${k}: ${v}`).join('\n') || 'None specified'}

COMMITMENT LEDGER:
- Document ASSERTS: ${skeleton.commitmentLedger.asserts.join('; ') || 'None'}
- Document REJECTS: ${skeleton.commitmentLedger.rejects.join('; ') || 'None'}

GROUNDING MATERIAL:
${groundingContext.slice(0, 8000)}
${quotesInstruction}

STYLE REQUIREMENTS:
- SHORT PARAGRAPHS (2-4 sentences max)
- First person voice throughout
- Never refer to ${figure.name} by name or in the third person; use I, me, my, and mine
- NO hedging, NO throat-clearing
- State thesis IMMEDIATELY

STRICT RULE: Do NOT contradict the commitment ledger. Use key terms as defined.`;

      try {
        for (
          let chunkIdx = 0;
          chunkIdx < maxGenerationAttempts
            && (
              chunkIdx < plannedChunks
              || totalWordCount < generationTargetWords
            );
          chunkIdx++
        ) {
          const remainingWords = Math.max(0, generationTargetWords - totalWordCount);
          const assignedMarkers = chunkIdx < plannedChunks
            ? markerAssignments[chunkIdx]
            : [];
          const markerExpansionWords = assignedMarkers.reduce((sum, marker) => {
            return sum + Math.max(0, countWords(quoteByMarker.get(marker) || "") - 1);
          }, 0);
          const isQuoteIntegrationSegment =
            assignedMarkers.length > 0 && chunkIdx < quoteIntegrationChunks;
          const quotePhaseTargetWords = Math.floor(proseTargetWords * 0.68);
          const quotePhaseWordsPerChunk = Math.floor(
            quotePhaseTargetWords / quoteIntegrationChunks,
          );
          const thisChunkTarget = isQuoteIntegrationSegment
            ? Math.max(
                180,
                Math.min(360, quotePhaseWordsPerChunk - markerExpansionWords),
              )
            : Math.min(
                450,
                Math.max(100, remainingWords - markerExpansionWords + 40),
              );
          
          // Determine which outline sections this chunk should cover
          const outlineSectionsPerChunk = Math.max(1, Math.ceil(skeleton.outline.length / plannedChunks));
          const outlineChunkIdx = Math.min(chunkIdx, plannedChunks - 1);
          const startOutlineIdx = outlineChunkIdx * outlineSectionsPerChunk;
          const endOutlineIdx = Math.min(startOutlineIdx + outlineSectionsPerChunk, skeleton.outline.length);
          const relevantOutline = skeleton.outline.slice(startOutlineIdx, endOutlineIdx);
          const assignedQuoteInstruction = assignedMarkers.length > 0
            ? `\nREQUIRED IN THIS SEGMENT:
${assignedMarkers.map((marker) => `- Use ${marker} exactly once and interpret it in the same paragraph.`).join("\n")}
- Do not use any quote marker not listed for this segment.
- These markers must occur before the final third of this segment.`
            : "\nDo not use any quote marker in this segment.";
          const thisChunkMaximum = thisChunkTarget + Math.max(
            45,
            Math.floor(thisChunkTarget * 0.15),
          );
          
          let chunkPrompt = "";
          if (chunkIdx === 0) {
            chunkPrompt = `Write between ${thisChunkTarget} and ${thisChunkMaximum} words for the FIRST part of the paper.

COVER THESE OUTLINE SECTIONS:
${relevantOutline.map((o, i) => `${startOutlineIdx + i + 1}. ${o}`).join('\n')}

Begin NOW with the thesis. First person voice.
${assignedQuoteInstruction}`;
          } else {
            chunkPrompt = `Continue the paper with between ${thisChunkTarget} and ${thisChunkMaximum} additional words.

COVER THESE OUTLINE SECTIONS:
${relevantOutline.map((o, i) => `${startOutlineIdx + i + 1}. ${o}`).join('\n')}

Do NOT repeat what came before. Continue naturally from:

${totalContent.slice(-1500)}
${assignedQuoteInstruction}`;
          }

          res.write(`data: ${JSON.stringify({ status: `Generating prose segment ${chunkIdx + 1}; ${remainingWords} words remaining...` })}\n\n`);
          console.log(`[Paper Writer] PASS 2 Segment ${chunkIdx + 1}: requesting at least ${thisChunkTarget} words, ${remainingWords} remaining`);

          // Generate this chunk with automatic provider fallback.
          // If one provider/key fails, it transparently retries the next.
          const chunkContent = await streamWithFallback({
            res,
            systemPrompt: skeletonSystemPrompt,
            userPrompt: chunkPrompt,
            maxTokens: Math.ceil(
              thisChunkMaximum * (isQuoteIntegrationSegment ? 2.0 : 1.7),
            ),
            temperature: 0.7,
            startProvider: "anthropic",
            onContent: (c) => { totalContent += c; },
            emitContent: true,
          });

          totalWordCount = countWords(expandQuoteMarkers(dedupeQuoteMarkers(totalContent)));
          const chunkWords = chunkContent.split(/\s+/).filter((w: string) => w.length > 0).length;
          console.log(`[Paper Writer] Segment ${chunkIdx + 1}: ${chunkWords} generated words (expanded body: ${totalWordCount}/${proseTargetWords}; missing quotes: ${missingQuoteMarkers(totalContent).length})`);

          // Store chunk delta for PASS 3
          allDeltas.push({
            chunkIndex: chunkIdx,
            newClaims: relevantOutline,
            conflictsDetected: []
          });

          // Stream progress
          res.write(`data: ${JSON.stringify({ 
            chunk_progress: { 
              chunk: chunkIdx + 1, 
              total: plannedChunks,
              chunkWords,
              totalWords: totalWordCount,
              targetWords: proseTargetWords
            } 
          })}\n\n`);

          // Brief pause between chunks
          if (totalWordCount < generationTargetWords) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        if (totalWordCount < proseTargetWords) {
          throw new Error(`Paper body stopped at ${totalWordCount}/${proseTargetWords} required prose words`);
        }

        let markedBody = totalContent
          .split(/\n#{1,3}\s+Direct Quotations/i)[0]
          .replace(/[“”"]/g, "'");
        markedBody = dedupeQuoteMarkers(markedBody);
        const missingMarkersForRevision = missingQuoteMarkers(markedBody);
        if (missingMarkersForRevision.length > 0) {
          markedBody = `${markedBody.trim()}\n\n${missingMarkersForRevision.join("\n\n")}`;
        }

        const genericQuoteProsePattern =
          /\b(?:I use|this passage|this quotation|this quote|the quotation|the quote|direct evidence|paper's central claim|philosophical distinction at issue)\b/i;
        const escapedFigureName = figure.name.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const thirdPersonSelfReferencePattern = new RegExp(
          `\\b${escapedFigureName}(?:['’]s)?\\b`,
          "i",
        );
        const normalizeOrganicParagraph = (paragraph: unknown): string => {
          if (typeof paragraph === "string") {
            const cleaned = paragraph
              .replace(/^```(?:json|text)?\s*/i, "")
              .replace(/\s*```$/, "")
              .trim();
            if (/^[\[{]/.test(cleaned)) {
              try {
                return normalizeOrganicParagraph(JSON.parse(cleaned));
              } catch {
                // Preserve non-JSON prose that happens to begin with punctuation.
              }
            }
            return cleaned.replace(/\s+/g, " ");
          }
          if (Array.isArray(paragraph)) {
            if (paragraph.every((item) => typeof item === "string")) {
              return paragraph.join(" ").replace(/\s+/g, " ").trim();
            }
            const wordObjects = paragraph.map((item) =>
              item && typeof item === "object"
                ? (item as any).word ?? (item as any).text
                : null,
            );
            if (
              wordObjects.length > 0
              && wordObjects.every((word) => typeof word === "string")
            ) {
              return wordObjects.join(" ").replace(/\s+/g, " ").trim();
            }
            return paragraph
              .map((item) => normalizeOrganicParagraph(item))
              .filter(Boolean)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
          }
          if (paragraph && typeof paragraph === "object") {
            const record = paragraph as Record<string, unknown>;
            const preferred =
              record.paragraph
              ?? record.revised
              ?? record.content
              ?? record.text
              ?? record.output
              ?? record.result
              ?? record.value;
            if (preferred !== undefined) {
              return normalizeOrganicParagraph(preferred);
            }
            const recovered = Object.values(record)
              .map((value) => normalizeOrganicParagraph(value))
              .filter(Boolean);
            return recovered.sort(
              (a, b) => countWords(b) - countWords(a),
            )[0] || "";
          }
          return "";
        };
        const normalizeCompleteMarkerBoundaries = (
          paragraph: string,
          markers: string[],
        ) => {
          let revised = paragraph;
          for (const marker of markers) {
            const markerIndex = revised.indexOf(marker);
            if (markerIndex < 0) continue;
            let before = revised.slice(0, markerIndex).trimEnd();
            let after = revised
              .slice(markerIndex + marker.length)
              .trimStart();
            if (
              before
              && !/[:.!?]$/.test(before)
              && !/\b(?:and|but|because|since|while|although|whereas|that|which|so)$/i.test(
                before,
              )
            ) {
              before = `${before.replace(/[,;]\s*$/, "")}:`;
            }
            if (
              /^(?:this|these|those|the|it|its|such|my|our|their|that)\b/.test(
                after,
              )
            ) {
              after = `${after.charAt(0).toUpperCase()}${after.slice(1)}`;
            } else if (
              /^(?:shows|reveals|demonstrates|indicates|establishes|clarifies|confirms|expresses|captures|underscores|illustrates)\b/.test(
                after,
              )
            ) {
              after = `This ${after}`;
            }
            revised = [
              before,
              marker,
              after,
            ].filter(Boolean).join(" ");
          }
          return revised;
        };
        const validateOrganicParagraph = (
          paragraph: string,
          expectedMarkers: string[],
          maxWords: number,
        ) => {
          if (!paragraph) return "empty paragraph";
          const endsWithCompleteSourceMarker = expectedMarkers.some(
            (marker) => paragraph.trimEnd().endsWith(marker),
          );
          if (
            !/[.!?]['”)\]]*$/.test(paragraph)
            && !endsWithCompleteSourceMarker
          ) {
            return "incomplete ending";
          }
          if (/^(?:#{1,6}\s|[-*]\s|\d+[.)]\s)/.test(paragraph)) {
            return "list or heading formatting";
          }
          if (genericQuoteProsePattern.test(paragraph)) {
            return "generic quotation meta-commentary";
          }
          if (thirdPersonSelfReferencePattern.test(paragraph)) {
            return "third-person self-reference instead of first-person voice";
          }
          if (/["“”]/.test(paragraph)) {
            return "literal quotation text instead of source marker";
          }
          if (countWords(paragraph) > maxWords + 18) {
            return `too long (${countWords(paragraph)} words; maximum ${maxWords})`;
          }
          for (const marker of expectedMarkers) {
            if (markerCount(paragraph, marker) !== 1) {
              return `${marker} must occur exactly once`;
            }
            const markerIndex = paragraph.indexOf(marker);
            const proseBeforeMarker = paragraph
              .slice(0, markerIndex)
              .trimEnd();
            const proseAfterMarker = paragraph
              .slice(markerIndex + marker.length)
              .trimStart();
            if (
              proseBeforeMarker
              && !/[:.!?]$/.test(proseBeforeMarker)
            ) {
              return `${marker} is a complete sentence and must follow a colon or sentence boundary`;
            }
            if (
              proseAfterMarker
              && !/^[A-Z0-9“‘'"[(]/.test(proseAfterMarker)
            ) {
              return `${marker} must be followed by a new sentence`;
            }
          }
          const foreignMarker = quoteMarkers.find(
            (marker) =>
              !expectedMarkers.includes(marker) && markerCount(paragraph, marker) > 0,
          );
          if (foreignMarker) return `contains unrelated marker ${foreignMarker}`;
          const proseWithoutMarkers = expectedMarkers.reduce(
            (prose, marker) => prose.replace(markerPattern(marker), ""),
            paragraph,
          );
          const minimumAnalysisWords = Math.max(12, expectedMarkers.length * 8);
          if (countWords(proseWithoutMarkers) < minimumAnalysisWords) {
            return `needs at least ${minimumAnalysisWords} words of specific interpretation`;
          }
          return "";
        };
        const parseOrganicRevisionMap = (content: string) => {
          const firstBrace = content.indexOf("{");
          const lastBrace = content.lastIndexOf("}");
          if (firstBrace < 0 || lastBrace <= firstBrace) return null;
          try {
            const parsed = JSON.parse(content.slice(firstBrace, lastBrace + 1));
            return parsed && typeof parsed === "object"
              ? parsed as Record<string, unknown>
              : null;
          } catch {
            return null;
          }
        };

        type OrganicQuoteParagraph = {
          id: string;
          index: number;
          markers: string[];
          paragraph: string;
          previous: string;
          next: string;
          maxWords: number;
        };
        const reservedNonQuoteWords = Math.max(
          100,
          Math.floor(targetWords * 0.12),
        );
        const analysisWordsPerQuote = targetQuotes > 0
          ? Math.max(
              12,
              Math.min(
                28,
                Math.floor(
                  (
                    targetWords
                    - totalQuotedWords
                    - reservedNonQuoteWords
                  ) / targetQuotes,
                ),
              ),
            )
          : 20;
        const markedParagraphs = markedBody
          .split(/\n\s*\n/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean);
        const organicParagraphs: OrganicQuoteParagraph[] = markedParagraphs
          .map((paragraph, index) => {
            const markers = quoteMarkers.filter((marker) =>
              paragraph.includes(marker),
            );
            return {
              id: `P${index + 1}`,
              index,
              markers,
              paragraph,
              previous: markedParagraphs[index - 1]?.slice(-700) || "",
              next: markedParagraphs[index + 1]?.slice(0, 700) || "",
              maxWords: Math.max(
                18,
                Math.min(
                  180,
                  markers.length * (analysisWordsPerQuote + 1),
                ),
              ),
            };
          })
          .filter((item) => item.markers.length > 0);

        const organicRevisionInput = Object.fromEntries(
          organicParagraphs.map((item) => [
            item.id,
            {
              requiredMarkers: item.markers,
              exactSources: Object.fromEntries(
                item.markers.map((marker) => [marker, quoteByMarker.get(marker)]),
              ),
              maximumWords: item.maxWords,
              previousContext: item.previous,
              draftParagraph: item.paragraph,
              nextContext: item.next,
            },
          ]),
        );

        const organicEditorSystemPrompt = `You are the final prose editor for a paper written in first person as ${figure.name}.

Rewrite quotation-bearing paragraphs so each verified source marker is woven seamlessly into the syntax and reasoning. The marker stands for exact source wording that the server inserts later.

NON-NEGOTIABLE RULES:
- Preserve every required [[Qn]] marker exactly once and introduce no other marker.
- Make the sentence grammatical when the marker is replaced by its exact source wording.
- Every source marker represents a complete sentence with terminal punctuation. Introduce it after a colon or a completed sentence, then begin any following analysis as a new sentence. Never embed a marker as a clause fragment.
- Build a concrete claim, introduce the source wording naturally, and explain what its particular language establishes in the local argument.
- Write continuous philosophical prose in ${figure.name}'s voice, not commentary about writing.
- Every paragraph must directly advance the requested topic and remain consistent with the other paragraphs and the governing thesis.
- Interpret only what the source wording warrants. Do not force a tangential source into an unrelated claim or contradict another paragraph.
- Stay in first person throughout; never refer to ${figure.name} by name or in the third person.
- Vary transitions and sentence structure so the sequence reads as one developing argument rather than twenty repeated claim-quotation-explanation units.
- Never say "I use", "this passage", "this quotation", "this quote", "direct evidence", "the paper", or "the central claim".
- Do not call attention to quotation mechanics and do not append a generic explanation.
- Do not output literal quotation marks or copy the source wording; output marker tokens only.
- No headings, lists, labels, dialogue, or detached quotation sentences.
- For each paragraph, return exactly its stated maximumWords as an array of single-word strings. Each marker is one array item.

Return only a valid JSON object whose keys are the supplied paragraph IDs and whose values are those exact-length word arrays.`;
        const organicSingleEditorSystemPrompt = `You are the final prose editor for a paper written in first person as ${figure.name}.

Rewrite one quotation-bearing paragraph as continuous philosophical prose.

NON-NEGOTIABLE RULES:
- Preserve every supplied [[Qn]] marker exactly once and introduce no other marker.
- Make the sentence grammatical when each marker is replaced by its exact source wording.
- Every marker represents a complete sentence with terminal punctuation. Introduce it after a colon or a completed sentence, then begin any following analysis as a new sentence. Never place it after "but", before "because", or inside another sentence.
- Build a concrete claim, introduce the wording naturally, and explain what its particular language establishes.
- Make the paragraph directly advance the requested topic, remain consistent with the governing thesis, and claim no more than the source wording warrants.
- Stay in first person throughout; never refer to ${figure.name} by name or in the third person.
- Use a natural transition from the surrounding context rather than a repeated claim-quotation-explanation formula.
- Never say "I use", "this passage", "this quotation", "this quote", "direct evidence", "the paper", or "the central claim".
- Do not output literal quotation marks or copy source wording; output marker tokens only.
- No headings, lists, labels, dialogue, or detached quotation sentences.
- End with complete sentence punctuation.

Return only the revised paragraph as plain prose within the requested word range. Do not return JSON, labels, or commentary.`;

        const reviseOrganicParagraph = async (
          item: OrganicQuoteParagraph,
          feedback = "",
        ) => {
          let lastError = feedback;
          for (let attempt = 0; attempt < 5; attempt++) {
            const response = await streamWithFallback({
              res,
              systemPrompt: organicSingleEditorSystemPrompt,
              userPrompt: `Rewrite only ${item.id}.

Topic: ${truncatedTopic}
Governing thesis: ${skeleton.thesis}
Required markers and exact source wording:
${item.markers.map((marker) => `${marker}: ${quoteByMarker.get(marker)}`).join("\n")}
Required words: between ${Math.max(18, item.maxWords - 5)} and ${item.maxWords}
Previous context: ${item.previous || "(opening paragraph)"}
Draft paragraph: ${item.paragraph}
Next context: ${item.next || "(closing paragraph)"}
${lastError ? `The previous revision failed because: ${lastError}` : ""}

Return only the revised paragraph as plain prose within that range, preserving each marker exactly once, using no literal source wording, and ending with complete sentence punctuation.`,
              maxTokens: Math.max(450, item.maxWords * 6),
              temperature: 0.3,
              startProvider: attempt >= 2 ? "deepseek" : "anthropic",
              onContent: () => {},
              emitContent: false,
            });
            const firstBracket = response.indexOf("[");
            const lastBracket = response.lastIndexOf("]");
            let candidate = "";
            if (firstBracket >= 0 && lastBracket > firstBracket) {
              try {
                const parsed = JSON.parse(
                  response.slice(firstBracket, lastBracket + 1),
                );
                if (Array.isArray(parsed)) {
                  if (
                    parsed.every(
                      (word) =>
                        typeof word === "string"
                        && word.length > 0
                        && !/\s/.test(word),
                    )
                  ) {
                    candidate = parsed.join(" ");
                  } else if (
                    parsed.every(
                      (item) =>
                        item
                        && typeof item === "object"
                        && typeof item.word === "string"
                        && item.word.length > 0
                        && !/\s/.test(item.word),
                    )
                  ) {
                    candidate = parsed.map((item) => item.word).join(" ");
                  }
                }
              } catch {
                candidate = "";
              }
            }
            if (!candidate) {
              const firstBrace = response.indexOf("{");
              const lastBrace = response.lastIndexOf("}");
              if (firstBrace >= 0 && lastBrace > firstBrace) {
                try {
                  const parsed = JSON.parse(
                    response.slice(firstBrace, lastBrace + 1),
                  );
                  const value = parsed?.paragraph
                    ?? parsed?.[item.id]
                    ?? Object.values(parsed || {})[0];
                  candidate = normalizeOrganicParagraph(value);
                } catch {
                  candidate = "";
                }
              }
            }
            if (!candidate) {
              candidate = normalizeOrganicParagraph(response);
            }
            candidate = normalizeCompleteMarkerBoundaries(
              candidate,
              item.markers,
            );
            const candidateWordCount = countWords(candidate);
            const minimumWords = Math.max(18, item.maxWords - 5);
            const validationError = validateOrganicParagraph(
              candidate,
              item.markers,
              item.maxWords,
            );
            if (
              !validationError
              && candidateWordCount >= minimumWords
              && candidateWordCount <= item.maxWords + 18
            ) {
              return candidate;
            }
            lastError = validationError
              || `returned ${candidateWordCount} words; expected at least ${minimumWords}`;
          }
          throw new Error(
            `Could not integrate ${item.markers.join(", ")} organically: ${lastError}`,
          );
        };

        if (organicParagraphs.length > 0) {
          res.write(`data: ${JSON.stringify({ status: "Refining quotations into continuous argumentative prose..." })}\n\n`);
          let revisionMap: Record<string, unknown> | null = null;
          for (let attempt = 0; attempt < 2 && !revisionMap; attempt++) {
            const revisionResponse = await streamWithFallback({
              res,
              systemPrompt: organicEditorSystemPrompt,
              userPrompt: `Topic: ${truncatedTopic}
Governing thesis: ${skeleton.thesis}

Rewrite every supplied quotation-bearing paragraph:
${JSON.stringify(organicRevisionInput, null, 2)}

Return only the JSON object.`,
              maxTokens: Math.max(6000, Math.ceil(targetWords * 6)),
              temperature: 0.35,
              startProvider: "deepseek",
              onContent: () => {},
              emitContent: false,
            });
            revisionMap = parseOrganicRevisionMap(revisionResponse);
          }

          for (const item of organicParagraphs) {
            const groupedCandidate = normalizeCompleteMarkerBoundaries(
              normalizeOrganicParagraph(revisionMap?.[item.id] || ""),
              item.markers,
            );
            const groupedError = validateOrganicParagraph(
              groupedCandidate,
              item.markers,
              item.maxWords,
            ) || (
              countWords(groupedCandidate) >= item.maxWords - 2
                && countWords(groupedCandidate) <= item.maxWords + 2
                ? ""
                : `returned ${countWords(groupedCandidate)}/${item.maxWords} words`
            );
            markedParagraphs[item.index] = groupedError
              ? await reviseOrganicParagraph(item, groupedError)
              : groupedCandidate;
          }
          markedBody = markedParagraphs.join("\n\n");
        }

        const currentMarkedParagraphs = markedBody
          .split(/\n\s*\n/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean);
        const currentQuoteParagraphs = currentMarkedParagraphs.filter(
          (paragraph) => quoteMarkers.some((marker) => paragraph.includes(marker)),
        );
        const maximumExpandedQuoteWords =
          targetWords - reservedNonQuoteWords;
        const currentExpandedQuoteWords = countWords(
          expandQuoteMarkers(currentQuoteParagraphs.join("\n\n")),
        );
        if (currentExpandedQuoteWords > maximumExpandedQuoteWords) {
          const maximumMarkedQuoteWords =
            maximumExpandedQuoteWords
            - totalQuotedWords
            + quoteMarkers.length;
          let compressedQuoteProse = "";
          let compressionFeedback = "";
          for (
            let attempt = 0;
            attempt < 4 && !compressedQuoteProse;
            attempt++
          ) {
            const compressionResponse = await streamWithFallback({
              res,
              systemPrompt: `You are the final compression editor for a first-person philosophical paper written as ${figure.name}.

Rewrite all supplied quotation-bearing prose as one coherent developing argument while preserving the exact source markers.

NON-NEGOTIABLE RULES:
- Preserve every supplied [[Qn]] marker exactly once and introduce no other marker.
- Each marker represents a complete source sentence. Introduce it after a colon or complete sentence, then begin any following analysis as a new sentence.
- Use no more than three source markers in any paragraph.
- Interpret the particular source wording faithfully and connect it directly to the requested topic and governing thesis.
- Write in first person throughout; never refer to ${figure.name} by name or in the third person.
- Never use quotation meta-commentary such as "I use," "this passage," "this quotation," "the quote," or "direct evidence."
- Do not copy any supplied source wording; retain only the markers.
- Use continuous prose with no headings, labels, bullet lists, dialogue, or speaker formatting.
- The entire returned prose, counting each marker as one word, must contain no more than ${maximumMarkedQuoteWords} whitespace-delimited words.

Return only the revised plain prose, separated into short paragraphs. Do not return JSON or commentary.`,
              userPrompt: `Topic: ${truncatedTopic}
Governing thesis: ${skeleton.thesis}

Exact source wording represented by the markers:
${quoteMarkers.map((marker) => `${marker}: ${quoteByMarker.get(marker)}`).join("\n")}

Quotation-bearing prose to compress:
${currentQuoteParagraphs.join("\n\n")}

${compressionFeedback}`,
              maxTokens: Math.max(
                2200,
                Math.ceil(maximumMarkedQuoteWords * 5),
              ),
              temperature: 0.25,
              startProvider: attempt >= 2 ? "deepseek" : "anthropic",
              onContent: () => {},
              emitContent: false,
            });
            let cleanedCompression = compressionResponse
              .replace(/^```(?:json|text|markdown)?\s*/i, "")
              .replace(/\s*```$/, "")
              .trim();
            if (/^[\[{]/.test(cleanedCompression)) {
              cleanedCompression = normalizeOrganicParagraph(
                cleanedCompression,
              );
            }
            const compressedParagraphs = cleanedCompression
              .split(/\n\s*\n/)
              .map((paragraph) => paragraph.trim())
              .filter(Boolean)
              .map((paragraph) => {
                const markers = quoteMarkers.filter((marker) =>
                  paragraph.includes(marker),
                );
                return normalizeCompleteMarkerBoundaries(paragraph, markers);
              });
            const compressedCandidate = compressedParagraphs.join("\n\n");
            const invalidCompressedMarkers = quoteMarkers.filter(
              (marker) => markerCount(compressedCandidate, marker) !== 1,
            );
            let compressionError = "";
            if (invalidCompressedMarkers.length > 0) {
              compressionError =
                `marker counts were wrong for ${invalidCompressedMarkers.join(", ")}`;
            } else if (
              countWords(compressedCandidate) > maximumMarkedQuoteWords
            ) {
              compressionError =
                `returned ${countWords(compressedCandidate)}/${maximumMarkedQuoteWords} allowed words`;
            } else {
              for (const paragraph of compressedParagraphs) {
                const markers = quoteMarkers.filter((marker) =>
                  paragraph.includes(marker),
                );
                if (markers.length === 0) {
                  compressionError = "included a paragraph without a source marker";
                  break;
                }
                if (markers.length > 3) {
                  compressionError = "placed more than three markers in one paragraph";
                  break;
                }
                compressionError = validateOrganicParagraph(
                  paragraph,
                  markers,
                  maximumMarkedQuoteWords,
                );
                if (compressionError) break;
              }
            }
            if (!compressionError) {
              compressedQuoteProse = compressedCandidate;
            } else {
              compressionFeedback =
                `The previous compression failed because ${compressionError}. Correct that defect and return only the complete revised prose.`;
            }
          }
          if (!compressedQuoteProse) {
            throw new Error(
              `Could not compress quotation paragraphs into the ${maximumExpandedQuoteWords}-word collective budget: ${compressionFeedback}`,
            );
          }
          const firstQuoteParagraphIndex = currentMarkedParagraphs.findIndex(
            (paragraph) =>
              quoteMarkers.some((marker) => paragraph.includes(marker)),
          );
          const rebuiltParagraphs: string[] = [];
          currentMarkedParagraphs.forEach((paragraph, index) => {
            const containsMarker = quoteMarkers.some((marker) =>
              paragraph.includes(marker),
            );
            if (index === firstQuoteParagraphIndex) {
              rebuiltParagraphs.push(compressedQuoteProse);
            }
            if (!containsMarker) {
              rebuiltParagraphs.push(paragraph);
            }
          });
          markedBody = rebuiltParagraphs.join("\n\n");
        }

        const invalidMarkers = quoteMarkers.filter((marker) => markerCount(markedBody, marker) !== 1);
        if (invalidMarkers.length > 0) {
          throw new Error(`Paper did not integrate every required quotation exactly once: ${invalidMarkers.join(", ")}`);
        }

        for (const marker of quoteMarkers) {
          const paragraph = markedBody
            .split(/\n\s*\n/)
            .find((candidate) => candidate.includes(marker));
          const analyticalWords = paragraph
            ? countWords(paragraph.replace(markerPattern(marker), ""))
            : 0;
          if (!paragraph || analyticalWords < 10) {
            throw new Error(`Quotation ${marker} was not introduced and analyzed in an argumentative paragraph`);
          }
        }

        if (
          quoteMarkers.length === 0
          && countWords(markedBody) > maximumAcceptedWords
        ) {
          let compressedBody = "";
          let compressionFeedback = "";
          for (let attempt = 0; attempt < 3 && !compressedBody; attempt++) {
            const response = await streamWithFallback({
              res,
              systemPrompt: `You are the final structural editor for a rigorous first-person paper written as ${figure.name}. Compress the complete draft without dropping any required line of argument. The user's explicit requirements are non-negotiable. Preserve their exact logical force and polarity: never strengthen "does not validate" into "refutes," "invalidates," or "falsifies," never weaken "proves" into "suggests," and never replace a stated thesis with a nearby claim. Preserve the thesis, every major outline commitment, objections and replies, and the conclusion. Remove repetition before removing substance. Use continuous prose with no headings, lists, labels, or meta-commentary. Use only factual material supported by the draft and supplied database grounding.`,
              userPrompt: `${completeGoverningRequest}

REQUIRED OUTLINE COMMITMENTS:
${skeleton.outline.map((item, index) => `${index + 1}. ${item}`).join("\n")}

DATABASE GROUNDING:
${groundingContext.slice(0, 14000)}

DRAFT TO COMPRESS:
${markedBody}

Return between ${minimumAcceptedWords} and ${maximumAcceptedWords} words. Every explicit user requirement and every major line of argument must remain developed, not merely mentioned. Argumentative completeness takes priority over approaching the exact target.
${compressionFeedback}`,
              maxTokens: Math.ceil((maximumAcceptedWords + 80) * 1.8),
              temperature: 0.2,
              startProvider: attempt >= 2 ? "deepseek" : "anthropic",
              onContent: () => {},
              emitContent: false,
            });
            const cleaned = response
              .replace(/^```(?:text|markdown)?\s*/i, "")
              .replace(/\s*```$/, "")
              .replace(/^#{1,6}\s+/gm, "")
              .trim();
            const compressedWords = countWords(cleaned);
            if (
              compressedWords >= minimumAcceptedWords
              && compressedWords <= maximumAcceptedWords
              && /[.!?]['”)\]]*$/.test(cleaned)
            ) {
              compressedBody = cleaned;
            } else {
              compressionFeedback = `The previous revision had ${compressedWords} words. Return a complete paper within the required range.`;
            }
          }
          if (compressedBody) {
            markedBody = compressedBody;
          }
        }

        let factualAuditIssues: string[] = [];
        if (quoteMarkers.length === 0 && effectiveInstructions) {
          try {
            const auditResponse = await streamWithFallback({
              res,
              systemPrompt: `You are a strict but narrowly scoped factual and instruction-fidelity auditor. Compare a philosophical paper against the user's explicit requirements and the selected thinker's verbatim primary-source passages. Flag only: (1) a paper claim directly contradicted by the source, (2) a substantive claim that neither appears in nor validly follows from the source, (3) a reversal or quantifier change, or (4) an explicit user requirement that is missing. Do not demand verbatim wording. Do not flag valid deductive consequences. Do not require the paper to cover every argument found in the source; source material not explicitly requested may be omitted. “Some entities of kind X are required” does not mean “all entities of kind X are required.” Return only JSON.`,
              userPrompt: `${completeGoverningRequest}

SELECTED THINKER'S DATABASE GROUNDING:
${groundingContext.slice(0, 16000)}

PAPER TO AUDIT:
${markedBody}

Return exactly:
{"issues":["specific conflict, including the exact paper claim and the source passage that contradicts it"],"missingRequirements":["explicit user requirement not substantively developed"]}

Return empty arrays only if the complete paper is faithful and grounded.`,
              maxTokens: 1400,
              temperature: 0.1,
              startProvider: "deepseek",
              onContent: () => {},
              emitContent: false,
            });
            const firstBrace = auditResponse.indexOf("{");
            const lastBrace = auditResponse.lastIndexOf("}");
            const audit = firstBrace >= 0 && lastBrace > firstBrace
              ? JSON.parse(auditResponse.slice(firstBrace, lastBrace + 1))
              : { issues: [], missingRequirements: [] };
            const factualIssues = (Array.isArray(audit.issues)
              ? audit.issues
              : []).filter(
                (problem) => typeof problem === "string" && problem.trim(),
              );
            factualAuditIssues = factualIssues;
            const missingRequirements = (Array.isArray(
              audit.missingRequirements,
            )
              ? audit.missingRequirements
              : []).filter(
                (problem) => typeof problem === "string" && problem.trim(),
              );
            const auditProblems = [...factualIssues, ...missingRequirements];

            if (auditProblems.length > 0) {
              console.warn(
                `[Paper Writer] Content audit found ${auditProblems.length} issue(s):`,
                auditProblems,
              );
            }
            // Concrete factual sentences are handled below by the targeted
            // primary-source checker. Full-paper repair is reserved for a
            // genuinely missing explicit user requirement.
            if (missingRequirements.length > 0) {
              let repairedBody = "";
              let repairFeedback = "";
              for (let attempt = 0; attempt < 3 && !repairedBody; attempt++) {
                const repairResponse = await streamWithFallback({
                  res,
                  systemPrompt: `You are the final factual editor for a rigorous first-person paper written as ${figure.name}. Correct every listed problem using only the user's governing requirements and the selected thinker's database grounding. Preserve the user's exact logical force and polarity. Do not add outside studies, facts, or doctrinal definitions. Develop every required argument. Return only the complete corrected paper in continuous prose.`,
                  userPrompt: `${completeGoverningRequest}

SELECTED THINKER'S DATABASE GROUNDING:
${groundingContext.slice(0, 16000)}

AUDIT PROBLEMS THAT MUST BE CORRECTED:
${missingRequirements.map((problem, index) => `${index + 1}. ${problem}`).join("\n")}

PAPER TO REPAIR:
${markedBody}

Return a complete corrected paper between ${minimumAcceptedWords} and ${maximumAcceptedWords} words. Do not include editorial notes or discuss the audit.
${repairFeedback}`,
                  maxTokens: Math.ceil(maximumAcceptedWords * 1.4),
                  temperature: 0.12,
                  startProvider: attempt >= 2 ? "anthropic" : "deepseek",
                  onContent: () => {},
                  emitContent: false,
                });
                const candidate = repairResponse
                  .replace(/^```(?:text|markdown)?\s*/i, "")
                  .replace(/\s*```$/, "")
                  .trim();
                const candidateWords = countWords(candidate);
                if (
                  candidateWords >= minimumAcceptedWords
                  && candidateWords <= maximumAcceptedWords
                  && /[.!?]['”)\]]*$/.test(candidate)
                ) {
                  repairedBody = candidate;
                } else {
                  repairFeedback = `The previous repair had ${candidateWords} words or lacked a complete ending. Return a complete corrected paper inside the required range.`;
                }
              }
              if (!repairedBody) {
                throw new Error(
                  "Factual repair could not produce a complete paper inside the accepted length range",
                );
              }
              markedBody = repairedBody;
            }
          } catch (auditError) {
            throw new Error(
              `Paper factual audit failed: ${(auditError as Error).message}`,
            );
          }
        }

        const expandedBody = expandQuoteMarkers(markedBody);
        if (countWords(expandedBody) < minimumAcceptedWords) {
          throw new Error(`Integrated paper body stopped at ${countWords(expandedBody)} words; minimum acceptable length is ${minimumAcceptedWords}`);
        }

        let proseBody = expandedBody.trim();
        if (countWords(proseBody) > maximumAcceptedWords) {
          proseBody = await closeAtExactWordCount(
            proseBody,
            maximumAcceptedWords,
            quoteExcerpts.map((quote) => `“${quote}”`),
          );
        }
        if (bindingDirectAnswer) {
          const contradictionResponse = await streamWithFallback({
            res,
            systemPrompt: `You are a strict logical contradiction detector. Compare a binding answer with a paper. Identify only complete sentences in the paper that directly deny, reverse, or contradict the binding answer. Do not flag qualifications, objections that are explicitly rejected, or merely different supporting points. Copy every contradictory sentence verbatim. Return only JSON.`,
            userPrompt: `BINDING DATABASE-DERIVED ANSWER:
${bindingDirectAnswer}

PAPER:
${proseBody}

Return exactly:
{"contradictorySentences":["exact complete sentence copied from the paper"]}`,
            maxTokens: 1000,
            temperature: 0,
            startProvider: "deepseek",
            onContent: () => {},
            emitContent: false,
          });
          const firstBrace = contradictionResponse.indexOf("{");
          const lastBrace = contradictionResponse.lastIndexOf("}");
          if (firstBrace >= 0 && lastBrace > firstBrace) {
            const contradictionAudit = JSON.parse(
              contradictionResponse.slice(firstBrace, lastBrace + 1),
            );
            const contradictorySentences = Array.isArray(
              contradictionAudit.contradictorySentences,
            )
              ? contradictionAudit.contradictorySentences.filter(
                  (sentence: unknown) =>
                    typeof sentence === "string"
                    && sentence.trim().length >= 20
                    && proseBody.includes(sentence.trim()),
                )
              : [];
            for (const sentence of contradictorySentences) {
              proseBody = proseBody.replace(sentence.trim(), "").trim();
            }
            proseBody = proseBody
              .replace(/[ \t]{2,}/g, " ")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
            if (
              contradictorySentences.length > 0
              && countWords(proseBody) < minimumAcceptedWords
            ) {
              throw new Error(
                "Removing claims that contradicted the database-derived answer made the paper too short",
              );
            }
          }
        }
        const sourceFaithfulnessResponse = factualAuditIssues.length > 0
          ? await streamWithFallback({
          res,
          systemPrompt: `You locate exact paper sentences corresponding to already-identified factual audit issues. Act only on the supplied audit issues; do not independently scan for or invent additional problems. For each listed issue, copy the one complete offending paper sentence verbatim. Return only delimiter blocks, with no JSON and no commentary.`,
          userPrompt: `VERBATIM PRIMARY SOURCE:
${primarySourceChunks.slice(0, 45).map((chunk) => chunk.chunkText).join("\n\n").slice(0, 30000)}

IDENTIFIED FACTUAL AUDIT ISSUES:
${factualAuditIssues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}

PAPER:
${proseBody}

For each correction return exactly:
[[ORIGINAL]]
exact complete sentence copied from the paper
[[/ORIGINAL]]

Return NONE if no correction is needed.`,
          maxTokens: 1600,
          temperature: 0,
          startProvider: "deepseek",
          onContent: () => {},
          emitContent: false,
        })
          : "NONE";
        const revisionPattern =
          /\[\[ORIGINAL\]\]([\s\S]*?)\[\[\/ORIGINAL\]\]/g;
        let revisionMatch: RegExpExecArray | null;
        let appliedSourceRevisions = 0;
        while ((revisionMatch = revisionPattern.exec(sourceFaithfulnessResponse))) {
            const original = revisionMatch[1].trim();
            if (
              original.length >= 20
              && proseBody.includes(original)
            ) {
              proseBody = proseBody.replace(original, "").trim();
              appliedSourceRevisions++;
            }
        }
        if (appliedSourceRevisions > 0) {
          const sourceCheckedWords = countWords(proseBody);
          if (
            sourceCheckedWords < minimumAcceptedWords
            || sourceCheckedWords > maximumAcceptedWords
            || !/[.!?]['”)\]]*$/.test(proseBody)
          ) {
            throw new Error(
              "Primary-source factual corrections produced an incomplete paper or moved it outside the accepted length range",
            );
          }
        }
        const unusedQuotes = quoteExcerpts.filter((quote) => {
          return proseBody.split(`“${quote}”`).length - 1 !== 1;
        });
        if (unusedQuotes.length > 0) {
          throw new Error(`${unusedQuotes.length} quotations were listed but not used exactly once in the final paper body`);
        }

        for (const quote of quoteExcerpts) {
          const quotedText = `“${quote}”`;
          const paragraph = proseBody
            .split(/\n\s*\n/)
            .find((candidate) => candidate.includes(quotedText));
          const analyticalWords = paragraph
            ? countWords(paragraph.replace(quotedText, ""))
            : 0;
          if (!paragraph || analyticalWords < 10) {
            throw new Error("A final-body quotation lost its surrounding analysis during length finalization");
          }
          if (genericQuoteProsePattern.test(paragraph)) {
            throw new Error("A final-body quotation still contains mechanical quotation language");
          }
        }

        if (genericQuoteProsePattern.test(proseBody)) {
          throw new Error("Final paper still contains mechanical quotation meta-commentary");
        }
        const narratorProse = quoteExcerpts.reduce(
          (content, quote) => content.replace(`“${quote}”`, ""),
          proseBody,
        );
        if (thirdPersonSelfReferencePattern.test(narratorProse)) {
          throw new Error("Final paper breaks first-person thinker voice");
        }

        totalContent = `${proseBody}${quoteAppendix}`.trim();
        totalWordCount = countWords(proseBody);
        const totalDocumentWordCount = countWords(totalContent);

        if (
          totalWordCount < minimumAcceptedWords
          || totalWordCount > maximumAcceptedWords
          || formattedQuotes.length !== targetQuotes
        ) {
          throw new Error(
            `Paper validation failed: ${totalWordCount} words outside the accepted ${minimumAcceptedWords}-${maximumAcceptedWords} range, or ${formattedQuotes.length}/${targetQuotes} quotes`,
          );
        }

        console.log(`[Paper Writer] PASS 2 Complete and validated: ${totalWordCount} body words, ${formattedQuotes.length} quotations integrated in body; ${totalDocumentWordCount - totalWordCount} reference-list words excluded from the paper count`);
        
        // ======
        // PASS 3: GLOBAL CONSISTENCY STITCH
        // ======
        res.write(`data: ${JSON.stringify({ status: "PASS 3: Checking global consistency..." })}\n\n`);
        console.log(`[Paper Writer] PASS 3: Running global consistency check`);
        
        if (totalContent.length > 500 && allDeltas.length > 1) {
          try {
            // Analyze all chunk deltas for cross-chunk issues
            const stitchPrompt = `Analyze these chunk deltas for coherence issues:

GLOBAL SKELETON:
THESIS: ${skeleton.thesis}
COMMITMENTS: Asserts ${skeleton.commitmentLedger.asserts.join('; ')}, Rejects ${skeleton.commitmentLedger.rejects.join('; ')}

CHUNK DELTAS:
${allDeltas.map(d => `Chunk ${d.chunkIndex + 1}: Claims: ${d.newClaims.join(', ')}`).join('\n')}

Identify:
1. Cross-chunk contradictions
2. Terminology drift
3. Redundancies

Respond with JSON: {"conflicts": ["issue 1", ...], "repairPlan": ["fix 1", ...]}`;

            let stitchResult = { conflicts: [] as string[], repairPlan: [] as string[] };
            
            if (anthropic) {
              const response = await anthropic.messages.create({
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 1000,
                messages: [{ role: 'user', content: stitchPrompt }]
              });
              const text = response.content[0]?.type === 'text' ? response.content[0].text : '{}';
              const match = text.match(/\{[\s\S]*\}/);
              if (match) {
                stitchResult = JSON.parse(match[0]);
              }
            } else if (openai) {
              const response = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: stitchPrompt }],
                max_tokens: 1000
              });
              const text = response.choices[0]?.message?.content || '{}';
              const match = text.match(/\{[\s\S]*\}/);
              if (match) {
                stitchResult = JSON.parse(match[0]);
              }
            }
            
            console.log(`[Paper Writer] PASS 3 Complete: ${stitchResult.conflicts.length} conflicts, ${stitchResult.repairPlan.length} repairs`);
            res.write(`data: ${JSON.stringify({ 
              stitch_result: {
                conflicts: stitchResult.conflicts,
                repairPlan: stitchResult.repairPlan,
                status: stitchResult.conflicts.length === 0 ? 'coherent' : 'has_issues'
              }
            })}\n\n`);
            
          } catch (stitchError) {
            console.error(`[Paper Writer] PASS 3 stitch failed:`, stitchError);
          }
        }

        res.write(`data: ${JSON.stringify({
          status: `Validated: ${totalWordCount} words and ${formattedQuotes.length} quotations. Sending paper...`,
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ reset_content: true })}\n\n`);
        for (let offset = 0; offset < totalContent.length; offset += 2000) {
          res.write(`data: ${JSON.stringify({ content: totalContent.slice(offset, offset + 2000) })}\n\n`);
        }
        
        res.write(`data: ${JSON.stringify({ status: `Complete: ${totalWordCount} words and ${formattedQuotes.length} quotations` })}\n\n`);
        
        cleanup();
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (streamError) {
        console.error("Error during paper generation:", streamError);
        cleanup();
        res.write(`data: ${JSON.stringify({ reset_content: true })}\n\n`);
        res.write(`data: ${JSON.stringify({ error: (streamError as Error).message || "Failed to generate paper" })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } catch (error) {
      console.error("Error in paper generation:", error);
      cleanup();
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to generate paper" });
      }
    }
  });

  // ======
  // UNIFIED LONG-FORM ENDPOINT (two-tier skeleton, all modes)
  //
  // POST /api/figures/:figureId/long-form
  // Body: {
  //   topic: string,                                  // required
  //   mode: "paper" | "essay" | "dialogue"           // default: "paper"
  //         | "debate" | "interview",
  //   wordLength?: number,                            // default 3000, max 50000
  //   numberOfQuotes?: number,                        // default 0, max 50
  //   otherParticipant?: string,                      // for dialogue/debate/interview
  //   customInstructions?: string,
  // }
  //
  // Streams SSE events: status, skeleton, section_skeleton, chunk_start,
  // content (text deltas), chunk_done, stitch, complete, [DONE].
  // ======
  app.post("/api/figures/:figureId/long-form", async (req: any, res) => {
    const figureId = req.params.figureId;
    const {
      topic,
      mode = "paper",
      wordLength = 3000,
      numberOfQuotes = 0,
      otherParticipant,
      customInstructions = "",
    } = req.body || {};

    if (!topic || typeof topic !== "string") {
      return res.status(400).json({ error: "Topic is required" });
    }

    const allowedModes: LongFormMode[] = ["paper", "essay", "dialogue", "debate", "interview"];
    if (!allowedModes.includes(mode as LongFormMode)) {
      return res.status(400).json({ error: `mode must be one of: ${allowedModes.join(", ")}` });
    }

    const targetWords = Math.min(Math.max(parseInt(wordLength) || 3000, 500), 50000);
    const targetQuotes = Math.min(Math.max(parseInt(numberOfQuotes) || 0, 0), 50);

    const figure = await storage.getThinker(figureId);
    if (!figure) {
      return res.status(404).json({ error: "Figure not found" });
    }

    // Setup SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (res.socket) res.socket.setTimeout(0);
    res.flushHeaders();

    const keepAlive = setInterval(() => {
      try { res.write(`: ka\n\n`); } catch { clearInterval(keepAlive); }
    }, 15000);
    // Abort controller propagates client-disconnect into the generator so we
    // stop spending tokens / DB writes when nobody is listening.
    const abortController = new AbortController();
    let clientGone = false;
    // cleanup() only releases timers/abort; it does NOT mark the client gone.
    // The socket "close" handler is the sole authority for setting clientGone.
    const cleanup = () => {
      clearInterval(keepAlive);
    };
    req.on("close", () => {
      if (!clientGone) {
        clientGone = true;
        console.log("[long-form] client disconnected, aborting generation");
        try { abortController.abort(); } catch {}
      }
      cleanup();
    });

    try {
      const send = (event: any) => {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
      };

      send({ status: `Gathering grounding for ${figure.name}...` });

      // ---------- gather grounding (same shape as write-paper) ----------
      const gatherMaterial = async (figureName: string): Promise<GroundingMaterial> => {
        const normalized = normalizeAuthorName(figureName);
        const topicKeywords = topic.toLowerCase()
          .replace(/[^\w\s]/g, "")
          .split(/\s+/)
          .filter((w: string) => w.length > 3);
        const searchQuery = topic.slice(0, 500);

        const [positions, chunks] = await Promise.all([
          searchPositions(normalized, topicKeywords, 25).catch(() => []),
          searchPhilosophicalChunks(searchQuery, 18, "common", normalized).catch(() => []),
        ]);

        let quotes: string[] = [];
        try {
          const r = await db.execute(
            sql`SELECT quote_text FROM quotes
                WHERE LOWER(thinker) = LOWER(${normalized})
                ORDER BY RANDOM()
                LIMIT ${Math.max(targetQuotes, 20)}`
          );
          quotes = (r.rows || []).map((row: any) => row.quote_text as string).filter(Boolean);
        } catch {}

        let argStrings: string[] = [];
        try {
          const r = await db.execute(
            sql`SELECT premises, conclusion FROM argument_statements
                WHERE LOWER(thinker) = LOWER(${normalized})
                ORDER BY importance DESC NULLS LAST
                LIMIT 12`
          );
          argStrings = (r.rows || []).map(
            (row: any) => `Premises: ${JSON.stringify(row.premises)} → Conclusion: ${row.conclusion}`
          );
        } catch (err) {
          console.warn(`[long-form] argument_statements query failed for ${normalized}:`, (err as Error).message);
        }

        return {
          quotes,
          positions: positions.map((p: any) => `[${p.topic || "position"}] ${p.position || p.text || ""}`),
          arguments: argStrings,
          chunks: chunks.map((c: any) => c.content || c.chunkText || ""),
        };
      };

      const primaryMaterial = await gatherMaterial(figure.name);
      let secondaryMaterial: GroundingMaterial | undefined;
      if (otherParticipant && (mode === "debate" || mode === "dialogue")) {
        // Only gather secondary material if the other participant looks like a
        // known figure (i.e. we can find positions). "Everyman" / "Interviewer"
        // labels just stay unsourced.
        try {
          secondaryMaterial = await gatherMaterial(otherParticipant);
          if (
            secondaryMaterial.positions.length === 0 &&
            secondaryMaterial.quotes.length === 0 &&
            secondaryMaterial.chunks.length === 0
          ) {
            secondaryMaterial = undefined;
          }
        } catch {
          secondaryMaterial = undefined;
        }
      }

      const totalGrounding =
        primaryMaterial.positions.length +
        primaryMaterial.quotes.length +
        primaryMaterial.chunks.length;

      if (totalGrounding === 0) {
        send({ error: `No grounding material found in database for ${figure.name}` });
        cleanup();
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      send({
        status: `Found ${primaryMaterial.positions.length} positions, ${primaryMaterial.quotes.length} quotes, ${primaryMaterial.chunks.length} passages, ${primaryMaterial.arguments.length} arguments. Starting two-tier skeleton...`,
      });

      // ---------- run the unified generator ----------
      const generator = generateLongForm({
        figureName: figure.name,
        mode: mode as LongFormMode,
        topic,
        targetWords,
        numberOfQuotes: targetQuotes,
        otherParticipant,
        customInstructions,
        primaryMaterial,
        secondaryMaterial,
        signal: abortController.signal,
      });

      let fullText = "";
      let totalWords = 0;

      for await (const evt of generator) {
        switch (evt.type) {
          case "content": {
            const piece = String(evt.data || "");
            fullText += piece;
            send({ content: piece });
            break;
          }
          case "chunk_done": {
            totalWords = evt.data?.totalWords ?? totalWords;
            send({ chunk_progress: evt.data });
            break;
          }
          case "skeleton": {
            send({ skeleton: evt.data });
            break;
          }
          case "section_skeleton": {
            send({ section_skeleton: evt.data });
            break;
          }
          case "chunk_start": {
            send({ chunk_start: evt.data });
            break;
          }
          case "stitch": {
            send({ stitch_result: evt.data });
            break;
          }
          case "complete": {
            send({ complete: { ...evt.data, finalWords: totalWords || (fullText ? fullText.split(/\s+/).filter(Boolean).length : 0) } });
            break;
          }
          case "error": {
            send({ error: evt.data });
            break;
          }
          case "status":
          default: {
            send({ status: typeof evt.data === "string" ? evt.data : JSON.stringify(evt.data) });
          }
        }
      }

      cleanup();
      if (!clientGone) {
        try {
          res.write("data: [DONE]\n\n");
          res.end();
        } catch {}
      }
      // After we end the response normally, mark the socket as "gone" so the
      // automatic Express "close" event that follows res.end() doesn't get
      // mis-treated as a client abort.
      clientGone = true;
      try { abortController.abort(); } catch {}
    } catch (error) {
      console.error("[long-form] Fatal error:", error);
      cleanup();
      if (!clientGone) {
        try {
          res.write(`data: ${JSON.stringify({ error: (error as Error).message || "long-form generation failed" })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } catch {}
      }
      clientGone = true;
      try { abortController.abort(); } catch {}
    }
  });

  // ---------------- Self-Test (Beta Test) Endpoint ----------------
  // Streams a comprehensive health/integration check via SSE so the operator
  // can verify the live deployment from the UI without external tooling.
  app.get("/api/admin/self-test/stream", async (req: any, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (res.socket) res.socket.setTimeout(0);
    res.flushHeaders();

    const keepAlive = setInterval(() => { try { res.write(": ka\n\n"); } catch {} }, 15000);
    let clientGone = false;
    const abortCtrl = new AbortController();
    req.on("close", () => {
      clientGone = true;
      clearInterval(keepAlive);
      try { abortCtrl.abort(); } catch {}
    });

    // Build an absolute origin so the runner can call our own API endpoints.
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
    const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
    const originBase = `${proto}://${host}`;

    const send = (event: any) => {
      if (clientGone) return;
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
    };

    try {
      send({ type: "log", data: { message: `Self-test starting against ${originBase}` } });
      for await (const ev of runSelfTest(originBase, abortCtrl.signal)) {
        if (clientGone) break;
        send(ev);
      }
    } catch (err: any) {
      send({ type: "log", data: { message: `Self-test crashed: ${err?.message || err}` } });
    } finally {
      clearInterval(keepAlive);
      if (!clientGone) {
        try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
      }
    }
  });

  // Generic SSE runner for the diagnostic generators (synthetic user + accuracy).
  const streamDiagnostic = (
    label: string,
    runner: (originBase: string, signal: AbortSignal) => AsyncGenerator<any>,
  ) => async (req: any, res: any) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (res.socket) res.socket.setTimeout(0);
    res.flushHeaders();

    const flush = () => {
      try { res.flush?.(); } catch {}
    };
    const keepAlive = setInterval(() => {
      try {
        res.write(": ka\n\n");
        flush();
      } catch {}
    }, 15000);
    let clientGone = false;
    const abortCtrl = new AbortController();
    res.on("close", () => {
      clientGone = true;
      clearInterval(keepAlive);
      try { abortCtrl.abort(); } catch {}
    });

    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
    const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
    const originBase = `${proto}://${host}`;

    const send = (event: any) => {
      if (clientGone) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        flush();
      } catch {}
    };

    try {
      // Force the initial SSE response through proxies that buffer very small chunks.
      res.write(`: connected ${" ".repeat(16384)}\n\n`);
      flush();
      send({ type: "log", data: { message: `${label} starting against ${originBase}` } });
      for await (const ev of runner(originBase, abortCtrl.signal)) {
        if (clientGone) break;
        send(ev);
      }
    } catch (err: any) {
      send({ type: "log", data: { message: `${label} crashed: ${err?.message || err}` } });
    } finally {
      clearInterval(keepAlive);
      if (!clientGone) {
        try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
      }
    }
  };

  app.get("/api/admin/synthetic-test/stream", streamDiagnostic("Synthetic-user test", runSyntheticUserTest));
  app.get("/api/admin/accuracy-test/stream", streamDiagnostic("Accuracy test", runAccuracyTest));
  app.get("/api/admin/thinker-probe-test/stream", streamDiagnostic("Thinker probe test", runThinkerProbeTest));
  const kuczynskiDiagnosticRunners = [
    runKuczynskiDiagnostic1,
    runKuczynskiDiagnostic2,
    runKuczynskiDiagnostic3,
    runKuczynskiDiagnostic4,
    runKuczynskiDiagnostic5,
    runKuczynskiDiagnostic6,
    runKuczynskiDiagnostic7,
    runKuczynskiDiagnostic8,
    runKuczynskiDiagnostic9,
    runKuczynskiDiagnostic10,
  ];
  kuczynskiDiagnosticRunners.forEach((runner, index) => {
    const groupNumber = index + 1;
    app.get(
      `/api/admin/kuczynski-diagnostic-${groupNumber}/stream`,
      streamDiagnostic(`Kuczynski diagnostic ${groupNumber} of 10`, runner),
    );
  });

  // Rewrite paper endpoint - rewrite an existing paper with user feedback
  app.post("/api/figures/:figureId/rewrite-paper", async (req: any, res) => {
    try {
      const figureId = req.params.figureId;
      const { originalPaper, topic, rewriteInstructions, wordLength = 1500, numberOfQuotes = 0 } = req.body;

      if (!originalPaper || typeof originalPaper !== "string") {
        return res.status(400).json({ error: "Original paper is required" });
      }
      if (!rewriteInstructions || typeof rewriteInstructions !== "string") {
        return res.status(400).json({ error: "Rewrite instructions are required" });
      }

      const targetWords = Math.min(Math.max(parseInt(wordLength) || 1500, 500), 50000);
      const targetQuotes = Math.min(Math.max(parseInt(numberOfQuotes) || 0, 0), 50);

      const figure = await storage.getThinker(figureId);
      if (!figure) {
        return res.status(404).json({ error: "Figure not found" });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const normalizedAuthor = normalizeAuthorName(figure.name);
      console.log(`[Paper Rewrite] Rewriting paper for ${figure.name} (normalized: ${normalizedAuthor})`);
      res.write(`data: ${JSON.stringify({ status: "Retrieving quotes for rewrite..." })}\n\n`);

      // Get quotes if requested
      let quotesContext = "";
      if (targetQuotes > 0) {
        try {
          const quotesResult = await db.execute(
            sql`SELECT quote_text, topic FROM quotes 
                WHERE LOWER(thinker) = LOWER(${normalizedAuthor})
                ORDER BY RANDOM()
                LIMIT ${targetQuotes}`
          );
          const quotes = (quotesResult.rows || []).map((r: any) => r.quote_text as string);
          if (quotes.length > 0) {
            quotesContext = `\n\n=== QUOTES TO INCORPORATE (use ${targetQuotes} quotes) ===\n${quotes.map((q, i) => `${i + 1}. "${q}"`).join('\n')}\n=== END QUOTES ===\n`;
          }
          console.log(`[Paper Rewrite] Found ${quotes.length} quotes`);
        } catch (e) {
          console.log(`[Paper Rewrite] Quotes query failed: ${e}`);
        }
      }

      res.write(`data: ${JSON.stringify({ status: "Rewriting paper..." })}\n\n`);

      const rewritePrompt = `You are ${figure.name}. You wrote the following paper and now need to REWRITE it based on user feedback.

ORIGINAL PAPER:
${originalPaper}

${quotesContext}

USER'S REWRITE INSTRUCTIONS:
${rewriteInstructions}

REQUIREMENTS:
1. Maintain your authentic voice and philosophical perspective as ${figure.name}
2. Address ALL the user's criticisms and instructions
3. Target approximately ${targetWords} words
${targetQuotes > 0 ? `4. Incorporate ${targetQuotes} quotes from the provided list naturally into the text` : ''}
5. Improve the paper while keeping what worked well
6. Write in first person as the philosopher

Rewrite the paper now, incorporating the feedback:`;

      const estimatedTokens = Math.ceil(targetWords * 1.5) + 2000;
      const maxTokens = Math.min(estimatedTokens, 64000);

      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: `You are ${figure.name}, rewriting your philosophical paper based on user feedback. Maintain your authentic voice.` },
          { role: "user", content: rewritePrompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.7,
        stream: true,
      });

      let totalContent = "";
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
          totalContent += content;
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }

      const wordCount = totalContent.split(/\s+/).filter((w: string) => w.length > 0).length;
      console.log(`[Paper Rewrite] Complete: ${wordCount} words`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      console.error("Error in paper rewrite:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to rewrite paper" });
      }
    }
  });

  // Model Builder - Generate isomorphic theories
  app.post("/api/model-builder", async (req: any, res) => {
    try {
      const { originalText, customInstructions, mode, previousModel, critique, formalMode, entireTextMode } = req.body;

      if (!originalText || typeof originalText !== "string") {
        return res.status(400).json({ error: "Original text is required" });
      }
      
      const isFormal = formalMode === true;
      const isEntireText = entireTextMode !== false;

      // Validate refinement mode parameters
      if (mode === "refine") {
        if (!previousModel || typeof previousModel !== "string") {
          return res.status(400).json({ error: "Previous model is required for refinement" });
        }
        if (!critique || typeof critique !== "string") {
          return res.status(400).json({ error: "Critique is required for refinement" });
        }
      }

      // Set up SSE
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      
      // Send initial ping to force Replit proxy to start streaming immediately
      res.write(`data: ${JSON.stringify({ status: "Starting model generation..." })}\n\n`);

      // Build system prompt based on mode
      // MODEL = An interpretation of the input that makes said input come out TRUE
      
      const FORMAL_ENTIRE_PROMPT = `# MODEL BUILDER: FORMAL MODE + ENTIRE TEXT

**MODEL** = An interpretation of the input that makes said input come out TRUE.

You produce an actual mathematical model (axioms, definitions, theorems, domain, interpretation) along with written intuitive motivation. Find ONE unified model for the ENTIRE text.

## EXACT OUTPUT FORMAT (follow precisely):

**FORMAL MODEL**

**Domain:** [Specify the mathematical structure - e.g., "Nodes and subgraphs of a connected undirected graph G = (V, E)"]

**Interpretation:**
- "[Term from text]" = [mathematical object/concept]
- "[Another term]" = [mathematical object/concept]
[Continue for all key terms]

**Axioms (now true in this model):**

A1. [Formal statement] — TRUE: [why it's true in this model]

A2. [Formal statement] — TRUE: [why it's true in this model]

[Continue for all axioms needed]

**Theorems:**

T1. [Statement derived from axioms] — TRUE: [proof sketch]

T2. [Statement derived from axioms] — TRUE: [proof sketch]

[Continue as needed]

**INTUITIVE MOTIVATION:**

[2-4 paragraphs explaining WHY this model works. What insight does it capture? How does interpreting the terms this way make the author's claims true? Be direct, no academic bloat.]

## RULES
- NEVER refuse to build a model
- NEVER ask for reformatting
- Find an interpretation that WORKS, even if unconventional
- The goal is TRUTH-MAKING: find a structure where the text's claims come out true
- Use actual mathematical structures (graphs, lattices, topological spaces, algebras, etc.)`;

      const FORMAL_CHUNKED_PROMPT = `# MODEL BUILDER: FORMAL MODE + MULTIPLE MODELS

**MODEL** = An interpretation of the input that makes said input come out TRUE.

You produce actual mathematical models. DO NOT model the entire text as one structure. Instead: find natural modules/chunks in the text, produce a SEPARATE formal model for each chunk.

## EXACT OUTPUT FORMAT (follow precisely):

**CHUNK 1: "[Title describing this section's topic]"**

**Domain:** [Mathematical structure for this chunk]

**Interpretation:**
- "[Term]" = [mathematical object]
- "[Term]" = [mathematical object]

**Why true:** [1-2 paragraphs explaining why the claims in this chunk come out true in this model]

---

**CHUNK 2: "[Title describing this section's topic]"**

**Domain:** [Mathematical structure for this chunk - may differ from Chunk 1]

**Interpretation:**
- "[Term]" = [mathematical object]
- "[Term]" = [mathematical object]

**Why true:** [1-2 paragraphs explaining why the claims in this chunk come out true in this model]

---

[Continue for all natural chunks in the text]

---

**INTUITIVE MOTIVATION:**

[2-4 paragraphs tying it all together. Why do we need multiple models? What does each chunk capture? How do they relate?]

## RULES
- NEVER refuse to build a model
- NEVER ask for reformatting
- Each chunk can have a DIFFERENT mathematical domain
- Find natural breakpoints in the text's arguments/topics
- The goal is TRUTH-MAKING for each chunk separately`;

      const INFORMAL_ENTIRE_PROMPT = `# MODEL BUILDER: INFORMAL MODE + ENTIRE TEXT

**MODEL** = An interpretation of the input that makes said input come out TRUE.

You find a conceptual reinterpretation that makes the text true. NOT formal mathematics—instead, find a way to READ the terms so everything comes out correct. Find ONE unified interpretation for the ENTIRE text.

## EXACT OUTPUT FORMAT (follow precisely):

**INFORMAL MODEL**

**Interpretation:** Read "[main concept]" as [your reinterpretation - e.g., "any self-maintaining dissipative system" or "control signal in a feedback control system"]

**Assignments:**
- "[Term from text]" = [what it really means under this interpretation]
- "[Term from text]" = [what it really means]
- "[Term from text]" = [what it really means]
[Continue for all key terms]

**Why true under this reading:**

[2-4 paragraphs explaining why EACH of the author's claims comes out true when we interpret terms this way. Be specific—quote claims and show why they're true.]

- "[Quoted claim from text]" = TRUE: [why it's true under this interpretation]
- "[Another quoted claim]" = TRUE: [why it's true under this interpretation]

**The model vindicates [Author]:** [1-2 sentences stating the insight. What was the author REALLY describing?]

## RULES
- NEVER refuse to build a model
- NEVER ask for reformatting  
- Be CHARITABLE: find the best interpretation, not the worst
- The goal is TRUTH-MAKING: find a reading where the claims come out true
- No academic bloat - be direct and clear`;

      const INFORMAL_CHUNKED_PROMPT = `# MODEL BUILDER: INFORMAL MODE + MULTIPLE MODELS

**MODEL** = An interpretation of the input that makes said input come out TRUE.

You find conceptual reinterpretations. DO NOT interpret the entire text as one unified thing. Instead: find natural modules/chunks in the text, produce a SEPARATE interpretation for each chunk.

## EXACT OUTPUT FORMAT (follow precisely):

**CHUNK 1: "[Title - quote or paraphrase the claim being modeled]"**

**Interpretation:** Read "[key term]" as [your reinterpretation for this chunk]

**Assignments:**
- "[Term]" = [meaning in this interpretation]
- "[Term]" = [meaning in this interpretation]

**Why true:** [1-2 paragraphs explaining why the claims in this chunk come out true under this interpretation]

---

**CHUNK 2: "[Title - quote or paraphrase the claim being modeled]"**

**Interpretation:** Read "[key term]" as [your reinterpretation - may differ from Chunk 1]

**Assignments:**
- "[Term]" = [meaning in this interpretation]
- "[Term]" = [meaning in this interpretation]

**Why true:** [1-2 paragraphs explaining why the claims in this chunk come out true]

---

[Continue for all natural chunks in the text]

---

**INTUITIVE MOTIVATION:**

[2-4 paragraphs explaining the overall insight. Why do different chunks need different interpretations? What does this tell us about the text? The author's arguments may be true in different domains - explain this.]

## RULES
- NEVER refuse to build a model
- NEVER ask for reformatting
- Each chunk can have a DIFFERENT conceptual interpretation
- Find natural breakpoints in the text's arguments/topics
- The goal is TRUTH-MAKING for each chunk separately
- No academic bloat`;

      // Select the appropriate prompt based on mode combination
      let MODEL_BUILDER_SYSTEM_PROMPT: string;
      if (isFormal && isEntireText) {
        MODEL_BUILDER_SYSTEM_PROMPT = FORMAL_ENTIRE_PROMPT;
      } else if (isFormal && !isEntireText) {
        MODEL_BUILDER_SYSTEM_PROMPT = FORMAL_CHUNKED_PROMPT;
      } else if (!isFormal && isEntireText) {
        MODEL_BUILDER_SYSTEM_PROMPT = INFORMAL_ENTIRE_PROMPT;
      } else {
        MODEL_BUILDER_SYSTEM_PROMPT = INFORMAL_CHUNKED_PROMPT;
      }
      
      console.log(`[Model Builder] Mode: ${isFormal ? 'FORMAL' : 'INFORMAL'}, ${isEntireText ? 'ENTIRE TEXT' : 'MULTIPLE MODELS'}`);

      // Process input - just pass through as-is, no special parsing needed
      const inputWordCount = originalText.split(/\s+/).length;
      const MAX_INPUT_CHARS = 500000; // 500k chars for up to 100k words
      
      console.log(`[Model Builder] Input: ${inputWordCount} words, ${originalText.length} chars`);
      
      let processedText = originalText;
      
      // For very large inputs, extract key sections
      if (originalText.length > MAX_INPUT_CHARS) {
        console.log(`[Model Builder] Large input detected, extracting key sections`);
        const chunkSize = Math.floor(MAX_INPUT_CHARS / 3);
        const beginning = originalText.slice(0, chunkSize);
        const middle = originalText.slice(
          Math.floor(originalText.length / 2) - chunkSize / 2,
          Math.floor(originalText.length / 2) + chunkSize / 2
        );
        const end = originalText.slice(-chunkSize);
        
        processedText = `[NOTE: This is a ${inputWordCount}-word text. Key sections extracted for analysis.]

=== BEGINNING ===
${beginning}

=== MIDDLE SECTION ===
${middle}

=== END ===
${end}

[Full text was ${inputWordCount} words. Analysis based on extracted sections above.]`;
        
        res.write(`data: ${JSON.stringify({ coherenceEvent: { type: "status", data: `Processing ${inputWordCount}-word text (extracting key sections)...` } })}\n\n`);
      }

      let userPrompt: string;
      
      if (mode === "refine") {
        userPrompt = `REFINEMENT REQUEST

ORIGINAL TEXT:
${processedText}

PREVIOUS MODEL:
${previousModel}

USER CRITIQUE:
${critique}

${customInstructions ? `ADDITIONAL INSTRUCTIONS:\n${customInstructions}\n\n` : ''}Please revise the model based on the user's critique. Address the specific issues raised.`;
      } else {
        userPrompt = customInstructions
          ? `${customInstructions}\n\n---\n\nTEXT TO MODEL:\n${processedText}`
          : `TEXT TO MODEL:\n${processedText}`;
      }

      // NOTE: Model Builder does NOT use coherence service
      // The specific prompts (FORMAL/INFORMAL, ENTIRE/CHUNKED) must be followed exactly
      // Coherence service would override these prompts and produce generic essays

      const anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY!,
      });

      const stream = await anthropic.messages.stream({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 8000, // Increased from 4000 for longer analyses
        temperature: 0.7,
        system: MODEL_BUILDER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      });

      for await (const chunk of stream) {
        if (
          chunk.type === "content_block_delta" &&
          chunk.delta.type === "text_delta"
        ) {
          const data = JSON.stringify({ content: chunk.delta.text });
          res.write(`data: ${data}\n\n`);
        }
      }

      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (error) {
      console.error("Error in model builder:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to generate model" });
      } else {
        res.write(`data: ${JSON.stringify({ error: "Stream error" })}\n\n`);
        res.end();
      }
    }
  });

  // ======
  // INTERNAL API: ZHI Knowledge Provider
  // ======

  // Request schema for knowledge queries
  // Note: figureId parameter retained for backward compatibility but queries unified 'common' pool
  const knowledgeRequestSchema = z.object({
    query: z.string().min(1).max(1000),
    figureId: z.string().optional().default("common"), // All queries now search unified knowledge base
    author: z.string().optional(), // NEW: Filter by author name (partial match via ILIKE)
    maxResults: z.number().int().min(1).max(20).optional().default(10),
    includeQuotes: z.boolean().optional().default(false),
    minQuoteLength: z.number().int().min(10).max(200).optional().default(50),
    numQuotes: z.number().int().min(1).max(50).optional().default(50), // NEW: Control number of quotes returned
    maxCharacters: z.number().int().min(100).max(50000).optional().default(10000),
  });

  // Helper: Apply spell correction for common OCR/conversion errors
  function applySpellCorrection(text: string): string {
    return text
      // Common OCR errors - double-v mistakes
      .replace(/\bvvith\b/gi, 'with')
      .replace(/\bvvhich\b/gi, 'which')
      .replace(/\bvvhat\b/gi, 'what')
      .replace(/\bvvhen\b/gi, 'when')
      .replace(/\bvvhere\b/gi, 'where')
      .replace(/\bvvhile\b/gi, 'while')
      .replace(/\bvvho\b/gi, 'who')
      .replace(/\bvve\b/gi, 'we')
      // Common OCR errors - letter confusion
      .replace(/\btbe\b/gi, 'the')
      .replace(/\btlie\b/gi, 'the')
      .replace(/\bwitli\b/gi, 'with')
      .replace(/\btbat\b/gi, 'that')
      .replace(/\btliis\b/gi, 'this')
      // Missing apostrophes (common OCR error)
      .replace(/\bdont\b/gi, "don't")
      .replace(/\bcant\b/gi, "can't")
      .replace(/\bwont\b/gi, "won't")
      .replace(/\bdoesnt\b/gi, "doesn't")
      .replace(/\bisnt\b/gi, "isn't")
      .replace(/\barent\b/gi, "aren't")
      .replace(/\bwerent\b/gi, "weren't")
      .replace(/\bwasnt\b/gi, "wasn't")
      .replace(/\bhasnt\b/gi, "hasn't")
      .replace(/\bhavent\b/gi, "haven't")
      .replace(/\bshouldnt\b/gi, "shouldn't")
      .replace(/\bwouldnt\b/gi, "wouldn't")
      .replace(/\bcouldnt\b/gi, "couldn't")
      // Fix spacing around punctuation
      .replace(/\s+([,.!?;:])/g, '$1')
      .replace(/([,.!?;:])\s+/g, '$1 ')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Helper: Check if sentence is complete (ends with proper punctuation)
  function isCompleteSentence(text: string): boolean {
    const trimmed = text.trim();
    // Must end with . ! ? or closing quote followed by punctuation
    return /[.!?]["']?$/.test(trimmed) && !trimmed.endsWith('..') && !trimmed.endsWith('p.');
  }

  // Helper: Check if text is a citation fragment
  function isCitationFragment(text: string): boolean {
    const lowerText = text.toLowerCase();
    return (
      // Starts with section/chapter numbers
      /^\d+\.\d+\s+[A-Z]/.test(text) || // "9.0 The raven paradox"
      /^Chapter\s+\d+/i.test(text) ||
      /^Section\s+\d+/i.test(text) ||
      // Starts with citation markers
      /^(see|cf\.|e\.g\.|i\.e\.|viz\.|ibid\.|op\. cit\.|loc\. cit\.)/i.test(text) ||
      // Contains obvious citation patterns
      /\(\d{4}\)/.test(text) || // (1865)
      /\d{4},\s*p\.?\s*\d+/.test(text) || // 1865, p. 23
      /^\s*-\s*[A-Z][a-z]+\s+[A-Z][a-z]+/.test(text) || // - William James
      /^["']?book,\s+the\s+/i.test(text) || // Starts with "book, the"
      // Ends with incomplete citation
      /,\s*p\.?$/i.test(text) || // ends with ", p." or ", p"
      /\(\s*[A-Z][a-z]+,?\s*\d{4}[),\s]*$/.test(text) // ends with (Author, 1865) or similar
    );
  }

  // Helper: Score quote quality and relevance
  function scoreQuote(quote: string, query: string): number {
    let score = 0;
    const quoteLower = quote.toLowerCase();
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    
    // Bonus for query word matches (relevance)
    for (const word of queryWords) {
      if (quoteLower.includes(word)) {
        score += 10;
      }
    }
    
    // Bonus for philosophical keywords
    const philosophicalKeywords = [
      'truth', 'knowledge', 'reality', 'existence', 'being', 'consciousness',
      'mind', 'reason', 'logic', 'ethics', 'morality', 'virtue', 'justice',
      'freedom', 'liberty', 'necessity', 'cause', 'effect', 'substance',
      'essence', 'nature', 'universe', 'god', 'soul', 'perception', 'experience',
      'understanding', 'wisdom', 'philosophy', 'metaphysics', 'epistemology'
    ];
    
    for (const keyword of philosophicalKeywords) {
      if (quoteLower.includes(keyword)) {
        score += 3;
      }
    }
    
    // Penalty for very short quotes
    if (quote.length < 100) score -= 5;
    
    // Bonus for medium length (100-300 chars is ideal)
    if (quote.length >= 100 && quote.length <= 300) score += 10;
    
    // Penalty for numbers/dates (likely citations)
    const numberCount = (quote.match(/\d+/g) || []).length;
    if (numberCount > 2) score -= 5;
    
    return score;
  }

  // Helper: Extract quotes from text passages with intelligent sentence detection
  function extractQuotes(
    passages: StructuredChunk[],
    query: string = "",
    minLength: number = 50,
    maxQuotes: number = 50
  ): Array<{ quote: string; source: string; chunkIndex: number; score: number; author: string }> {
    const quotes: Array<{ quote: string; source: string; chunkIndex: number; score: number; author: string }> = [];
    
    for (const passage of passages) {
      // Clean and normalize content
      const cleanedContent = passage.content
        .replace(/\s+/g, ' ')  // Normalize whitespace
        .trim();
      
      // Smart sentence splitting that preserves citations
      // Split on . ! ? but NOT on abbreviations like "p.", "Dr.", "Mr.", "i.e.", "e.g."
      const sentences: string[] = [];
      let currentSentence = '';
      let i = 0;
      
      while (i < cleanedContent.length) {
        const char = cleanedContent[i];
        currentSentence += char;
        
        if (char === '.' || char === '!' || char === '?') {
          // Check if this is an abbreviation (followed by lowercase or another period)
          const nextChar = cleanedContent[i + 1];
          const prevWord = currentSentence.trim().split(/\s+/).pop() || '';
          
          const isAbbreviation = (
            /^(Dr|Mr|Mrs|Ms|Prof|Jr|Sr|vs|etc|i\.e|e\.g|cf|viz|ibid|op|loc|p|pp|vol|ch|sec|fig)\.$/i.test(prevWord) ||
            nextChar === '.' ||
            (nextChar && nextChar === nextChar.toLowerCase() && /[a-z]/.test(nextChar))
          );
          
          if (!isAbbreviation && nextChar && /\s/.test(nextChar)) {
            // This is a sentence boundary
            sentences.push(currentSentence.trim());
            currentSentence = '';
            i++; // Skip the space
            continue;
          }
        }
        
        i++;
      }
      
      // Add any remaining content
      if (currentSentence.trim()) {
        sentences.push(currentSentence.trim());
      }
      
      // Process each sentence
      for (let sentence of sentences) {
        // Apply spell correction
        sentence = applySpellCorrection(sentence);
        
        // Check if it's a complete sentence
        if (!isCompleteSentence(sentence)) continue;
        
        // Check length bounds
        if (sentence.length < minLength || sentence.length > 500) continue;
        
        // Check word count
        const wordCount = sentence.split(/\s+/).length;
        if (wordCount < 8) continue; // Require at least 8 words for substantive content
        
        // Check for citation fragments
        if (isCitationFragment(sentence)) continue;
        
        // Check for formatting artifacts
        const hasFormattingArtifacts = 
          sentence.includes('(<< back)') ||
          sentence.includes('(<<back)') ||
          sentence.includes('[<< back]') ||
          sentence.includes('*_') ||
          sentence.includes('_*');
        
        if (hasFormattingArtifacts) continue;
        
        // Check for excessive special characters
        const specialCharCount = (sentence.match(/[<>{}|\\]/g) || []).length;
        if (specialCharCount > 5) continue;
        
        // Score the quote
        const score = scoreQuote(sentence, query);
        
        quotes.push({
          quote: sentence,
          source: passage.paperTitle,
          chunkIndex: passage.chunkIndex,
          score,
          author: passage.author
        });
      }
    }
    
    // Deduplicate
    const uniqueQuotes = Array.from(new Map(quotes.map(q => [q.quote, q])).values());
    
    // Sort by score (best first)
    uniqueQuotes.sort((a, b) => b.score - a.score);
    
    // Return top N quotes
    return uniqueQuotes.slice(0, maxQuotes);
  }

  // ======
  // ZHI QUERY API: Structured knowledge queries
  // ======
  
  // Request schema for /zhi/query endpoint
  const zhiQuerySchema = z.object({
    query: z.string().min(1).max(1000),
    author: z.string().optional(), // Filter by author/philosopher name
    limit: z.number().int().min(1).max(50).optional().default(10),
    includeQuotes: z.boolean().optional().default(false),
  });

  // ======
  // UNIQUE VISITOR TRACKING (anonymous, cookie-based)
  // ======
  // In-memory IP throttle: max 10 track-visit writes per IP per minute
  const trackVisitBuckets = new Map<string, number[]>();
  app.post("/api/track-visit", async (req: any, res) => {
    try {
      const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) || req.ip || "unknown";
      const now = Date.now();
      const bucket = (trackVisitBuckets.get(ip) || []).filter(t => now - t < 60_000);
      if (bucket.length >= 10) {
        trackVisitBuckets.set(ip, bucket);
        return res.status(429).json({ ok: false });
      }
      bucket.push(now);
      trackVisitBuckets.set(ip, bucket);
      if (trackVisitBuckets.size > 10000) trackVisitBuckets.clear(); // bound memory

      // Parse the visitor cookie manually (no cookie-parser in this app)
      const cookieHeader: string = req.headers.cookie || "";
      let visitorId = cookieHeader
        .split(";")
        .map((c: string) => c.trim())
        .find((c: string) => c.startsWith("gvid="))
        ?.slice(5);

      const isNew = !visitorId || !/^[0-9a-f-]{36}$/.test(visitorId);
      if (isNew) {
        visitorId = uuidv4();
        res.cookie("gvid", visitorId, {
          maxAge: 2 * 365 * 24 * 60 * 60 * 1000, // 2 years
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
        });
      }

      await db
        .insert(uniqueVisitors)
        .values({ visitorId: visitorId! })
        .onConflictDoUpdate({
          target: uniqueVisitors.visitorId,
          set: {
            lastSeenAt: new Date(),
            visitCount: sql`${uniqueVisitors.visitCount} + 1`,
          },
        });

      res.json({ ok: true });
    } catch (error) {
      console.error("Error tracking visit:", error);
      res.status(200).json({ ok: false }); // never break the app over analytics
    }
  });

  app.get("/api/visitors/count", async (_req, res) => {
    try {
      const [totals] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(uniqueVisitors);
      res.json({ total: totals?.total || 0 });
    } catch (error) {
      console.error("Error fetching public visitor count:", error);
      res.status(200).json({ total: 0 });
    }
  });

  // Admin-only: unique visitor stats (johnmichaelkuczynski@gmail.com only)
  app.get("/api/admin/unique-visitors", isAdmin, async (_req, res) => {
    try {
      const now = Date.now();
      const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

      const [totals] = await db
        .select({
          total: sql<number>`count(*)::int`,
          last24Hours: sql<number>`count(*) filter (where ${uniqueVisitors.lastSeenAt} >= ${dayAgo})::int`,
          lastMonth: sql<number>`count(*) filter (where ${uniqueVisitors.lastSeenAt} >= ${monthAgo})::int`,
          newLast24Hours: sql<number>`count(*) filter (where ${uniqueVisitors.firstSeenAt} >= ${dayAgo})::int`,
          totalVisits: sql<number>`coalesce(sum(${uniqueVisitors.visitCount}), 0)::int`,
        })
        .from(uniqueVisitors);

      res.json(totals);
    } catch (error) {
      console.error("Error fetching unique visitors:", error);
      res.status(500).json({ error: "Failed to fetch unique visitor stats" });
    }
  });

  // ======
  // API KEY MANAGEMENT (admin only — manage keys for external apps)
  // ======
  app.post("/api/keys", isAdmin, async (req, res) => {
    try {
      const label = typeof req.body?.label === "string" && req.body.label.trim()
        ? req.body.label.trim().slice(0, 256)
        : "Unnamed key";
      const { rawKey, record } = await createApiKey(label);
      res.json({
        key: rawKey, // shown ONCE — only the hash is stored
        id: record.id,
        label: record.label,
        keyPrefix: record.keyPrefix,
        createdAt: record.createdAt,
        note: "Save this key now. It cannot be retrieved again.",
      });
    } catch (error) {
      console.error("Error creating API key:", error);
      res.status(500).json({ error: "Failed to create API key" });
    }
  });

  app.get("/api/keys", isAdmin, async (_req, res) => {
    try {
      const keys = await listApiKeys();
      res.json(keys.map(k => ({
        id: k.id,
        label: k.label,
        keyPrefix: k.keyPrefix + "…",
        revoked: k.revoked,
        requestCount: k.requestCount,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
      })));
    } catch (error) {
      console.error("Error listing API keys:", error);
      res.status(500).json({ error: "Failed to list API keys" });
    }
  });

  app.delete("/api/keys/:id", isAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid key id" });
      const ok = await revokeApiKey(id);
      if (!ok) return res.status(404).json({ error: "Key not found" });
      res.json({ success: true, revoked: id });
    } catch (error) {
      console.error("Error revoking API key:", error);
      res.status(500).json({ error: "Failed to revoke API key" });
    }
  });

  // ======
  // PUBLIC EXTERNAL API — chat with Kuczynski (API-key protected)
  // POST /api/external/kuczynski
  // Headers: Authorization: Bearer gk_...   (or X-API-Key: gk_...)
  // Body: {
  //   message: string (required),
  //   history?: [{ role: "user"|"assistant", content: string }],  // stateless — caller keeps history
  //   maxWords?: number (default 750, max 5000),
  //   quotes?: number (default 3, max 20),
  //   stream?: boolean (default false; true = SSE stream)
  // }
  // ======
  app.post("/api/external/kuczynski", verifyApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};

      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;

      // Validate optional history
      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const h of history.slice(-20)) {
          if (h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string") {
            validHistory.push({ role: h.role, content: h.content.slice(0, 8000) });
          }
        }
      }

      const kuczynskiFigure = await storage.getThinker("kuczynski");
      if (!kuczynskiFigure) {
        return res.status(500).json({ error: "Kuczynski figure not available" });
      }

      // HYBRID RAG: same three sources as the main chat
      const embeddingChunks = await searchPhilosophicalChunks(message, 6, "kuczynski", "Kuczynski");
      const textChunksRes = await searchTextChunks("J.-M. Kuczynski", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker(
        "Kuczynski",
        message,
        50,
      );
      const paradoxMatches = isParadoxQuery(message) ? await searchParadoxes(message) : [];

      const queryWords = message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker = 'kuczynski' AND (
              position_text ILIKE ${'%' + queryWords[0] + '%'}
              ${queryWords[1] ? sql` OR position_text ILIKE ${'%' + queryWords[1] + '%'}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${'%' + queryWords[2] + '%'}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${'%' + queryWords[3] + '%'}` : sql``}
            )`
          )
          .limit(15);
      }

      console.log(`[External API] RAG — arguments: ${structuredArgumentsContext ? "yes" : "no"}, embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`);

      let knowledgeContext = "";
      if (structuredArgumentsContext || embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = `\n\n--- YOUR WRITINGS (for reference) ---\n\n`;
        if (structuredArgumentsContext) {
          knowledgeContext += `${structuredArgumentsContext}\n`;
        }
        if (positionResults.length) {
          knowledgeContext += `=== YOUR CORE POSITIONS ===\n`;
          for (const pos of positionResults) knowledgeContext += `• ${pos.position}\n`;
          knowledgeContext += `\n`;
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, ' ')}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, '').replace(/_/g, ' ')}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext += `--- END ---\n\nINSTRUCTION: Use the structured records and source passages when they genuinely bear on the question, then use the strongest relevant expert knowledge needed for a complete and correct answer. Never discuss retrieval coverage or withhold an answer.\n`;
      } else {
        knowledgeContext = `\n\nAnswer the question fully from the strongest relevant expert knowledge available. Never mention retrieval, database coverage, missing sources, or limitations.\n`;
      }
      knowledgeContext += formatParadoxesContext(paradoxMatches);

      let responseInstructions = `\n⚠️ TARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `⚠️ QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from your writings above.\n`;
      }
      responseInstructions += `\nSTYLE: Write like Kuczynski — crisp, direct, no academic bloat. Short sentences. Clear logic. Get to the point immediately.\nFORMATTING: Plain text only (no markdown).\n`;

      const systemPrompt = kuczynskiFigure.systemPrompt + knowledgeContext + responseInstructions;

      // Flatten history into the user prompt (stateless API)
      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map(h => `${h.role === "user" ? "Interlocutor" : "Kuczynski"}: ${h.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }

      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();

        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamErr) {
          console.error("[External API] Stream error:", streamErr);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "kuczynski",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[External API] Error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to generate response" });
      }
    }
  });

  // ======
  // PUBLIC EXTERNAL API — chat with Aristotle
  // This is separate from the Kuczynski proxy and uses ARISTOTLE_API_KEY.
  // POST /api/external/aristotle
  // ======
  app.post("/api/external/aristotle", verifyAristotleApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};

      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;

      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const item of history.slice(-20)) {
          if (
            item &&
            (item.role === "user" || item.role === "assistant") &&
            typeof item.content === "string"
          ) {
            validHistory.push({
              role: item.role,
              content: item.content.slice(0, 8000),
            });
          }
        }
      }

      const aristotleFigure = await storage.getThinker("aristotle");
      if (!aristotleFigure) {
        return res.status(500).json({ error: "Aristotle figure not available" });
      }

      const embeddingChunks = await searchPhilosophicalChunks(
        message,
        6,
        "aristotle",
        "Aristotle",
      );
      const textChunksRes = await searchTextChunks("Aristotle", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker("Aristotle", message, 40);
      const paradoxMatches = isParadoxQuery(message) ? await searchParadoxes(message) : [];

      const queryWords = message
        .toLowerCase()
        .split(/\s+/)
        .filter((word: string) => word.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker ILIKE ${"%Aristotle%"} AND (
              position_text ILIKE ${"%" + queryWords[0] + "%"}
              ${queryWords[1] ? sql` OR position_text ILIKE ${"%" + queryWords[1] + "%"}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${"%" + queryWords[2] + "%"}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${"%" + queryWords[3] + "%"}` : sql``}
            )`,
          )
          .limit(15);
      }

      console.log(
        `[Aristotle API] RAG — embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`,
      );

      let knowledgeContext = "";
      if (embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = "\n\n--- YOUR WRITINGS (for reference) ---\n\n";
        if (positionResults.length) {
          knowledgeContext += "=== YOUR CORE POSITIONS ===\n";
          for (const position of positionResults) {
            knowledgeContext += `• ${position.position}\n`;
          }
          knowledgeContext += "\n";
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, " ")}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, "").replace(/_/g, " ")}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext +=
          "--- END ---\n\nINSTRUCTION: You have read your own writings above. Answer in Aristotle's voice and ground your claims in this material.\n";
      } else {
        knowledgeContext =
          "\n\nNOTE: No specific Aristotle passages were retrieved for this query. Respond from Aristotle's documented positions, or acknowledge when the question falls outside them.\n";
      }
      knowledgeContext += formatParadoxesContext(paradoxMatches);

      let responseInstructions = `\nTARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from Aristotle's writings above.\n`;
      }
      responseInstructions +=
        "\nSTYLE: Write as Aristotle: systematic, lucid, analytical, and attentive to causes, purposes, distinctions, and practical consequences.\nFORMATTING: Plain text only (no markdown).\n";

      const systemPrompt = aristotleFigure.systemPrompt + structuredArgumentsContext + knowledgeContext + responseInstructions;

      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map((item) => `${item.role === "user" ? "Interlocutor" : "Aristotle"}: ${item.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }

      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();

        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamError) {
          console.error("[Aristotle API] Stream error:", streamError);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "aristotle",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[Aristotle API] Error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to generate Aristotle response" });
      }
    }
  });

  // PUBLIC EXTERNAL API — chat with Darwin
  // This is independent and uses DARWIN_API_KEY with Darwin-only retrieval.
  app.post("/api/external/darwin", verifyDarwinApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};

      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;

      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const item of history.slice(-20)) {
          if (
            item &&
            (item.role === "user" || item.role === "assistant") &&
            typeof item.content === "string"
          ) {
            validHistory.push({
              role: item.role,
              content: item.content.slice(0, 8000),
            });
          }
        }
      }

      const darwinFigure = await storage.getThinker("darwin");
      if (!darwinFigure) {
        return res.status(500).json({ error: "Darwin figure not available" });
      }

      const embeddingChunks = await searchPhilosophicalChunks(
        message,
        6,
        "darwin",
        "Darwin",
      );
      const textChunksRes = await searchTextChunks("Darwin", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker("Darwin", message, 40);

      const queryWords = message
        .toLowerCase()
        .split(/\s+/)
        .filter((word: string) => word.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker ILIKE ${"%Darwin%"} AND (
              position_text ILIKE ${"%" + queryWords[0] + "%"}
              ${queryWords[1] ? sql` OR position_text ILIKE ${"%" + queryWords[1] + "%"}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${"%" + queryWords[2] + "%"}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${"%" + queryWords[3] + "%"}` : sql``}
            )`,
          )
          .limit(15);
      }

      console.log(
        `[Darwin API] RAG — embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`,
      );

      let knowledgeContext = "";
      if (embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = "\n\n--- YOUR WRITINGS (for reference) ---\n\n";
        if (positionResults.length) {
          knowledgeContext += "=== YOUR CORE POSITIONS ===\n";
          for (const position of positionResults) {
            knowledgeContext += `• ${position.position}\n`;
          }
          knowledgeContext += "\n";
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, " ")}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, "").replace(/_/g, " ")}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext +=
          "--- END ---\n\nINSTRUCTION: You have read your own writings above. Answer in Charles Darwin's voice and ground your claims exclusively in this material.\n";
      } else {
        knowledgeContext =
          "\n\nNOTE: No specific Darwin passages were retrieved for this query. Respond only from Darwin's documented positions, or acknowledge when the question falls outside them.\n";
      }

      let responseInstructions = `\nTARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from Darwin's writings above.\n`;
      }
      responseInstructions +=
        "\nSTYLE: Write as Charles Darwin: careful, empirical, modest about uncertainty, attentive to variation, adaptation, natural selection, and accumulated evidence.\nFORMATTING: Plain text only (no markdown).\n";

      const systemPrompt = darwinFigure.systemPrompt + structuredArgumentsContext + knowledgeContext + responseInstructions;

      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map((item) => `${item.role === "user" ? "Interlocutor" : "Darwin"}: ${item.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }

      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();

        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamError) {
          console.error("[Darwin API] Stream error:", streamError);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "darwin",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[Darwin API] Error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to generate Darwin response" });
      }
    }
  });

  app.post("/api/external/plato", verifyPlatoApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;
      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const item of history.slice(-20)) {
          if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
            validHistory.push({ role: item.role, content: item.content.slice(0, 8000) });
          }
        }
      }

      const platoFigure = await storage.getThinker("plato");
      if (!platoFigure) {
        return res.status(500).json({ error: "Plato figure not available" });
      }

      const embeddingChunks = await searchPhilosophicalChunks(message, 6, "plato", "Plato");
      const textChunksRes = await searchTextChunks("Plato", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker("Plato", message, 40);
      const queryWords = message.toLowerCase().split(/\s+/).filter((word: string) => word.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker ILIKE ${"%Plato%"} AND (
              position_text ILIKE ${"%" + queryWords[0] + "%"}
              ${queryWords[1] ? sql` OR position_text ILIKE ${"%" + queryWords[1] + "%"}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${"%" + queryWords[2] + "%"}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${"%" + queryWords[3] + "%"}` : sql``}
            )`,
          )
          .limit(15);
      }

      console.log(
        `[Plato API] RAG — embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`,
      );

      let knowledgeContext = "";
      if (embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = "\n\n--- YOUR WRITINGS (for reference) ---\n\n";
        if (positionResults.length) {
          knowledgeContext += "=== YOUR CORE POSITIONS ===\n";
          for (const position of positionResults) knowledgeContext += `• ${position.position}\n`;
          knowledgeContext += "\n";
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, " ")}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, "").replace(/_/g, " ")}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext +=
          "--- END ---\n\nINSTRUCTION: Answer in Plato's voice and ground your claims exclusively in Plato's writings above.\n";
      } else {
        knowledgeContext =
          "\n\nNOTE: No specific Plato passages were retrieved. Respond only from Plato's documented positions, or acknowledge when the question falls outside them.\n";
      }

      let responseInstructions = `\nTARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from Plato's writings above.\n`;
      }
      responseInstructions +=
        "\nSTYLE: Write as Plato: dialectical, probing, lucid, and attentive to definitions, forms, knowledge, virtue, justice, and the examined life.\nFORMATTING: Plain text only (no markdown).\n";

      const systemPrompt = platoFigure.systemPrompt + structuredArgumentsContext + knowledgeContext + responseInstructions;
      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map((item) => `${item.role === "user" ? "Interlocutor" : "Plato"}: ${item.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }
      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();
        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamError) {
          console.error("[Plato API] Stream error:", streamError);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "plato",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[Plato API] Error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate Plato response" });
    }
  });

  app.post("/api/external/sartre", verifySartreApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;
      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const item of history.slice(-20)) {
          if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
            validHistory.push({ role: item.role, content: item.content.slice(0, 8000) });
          }
        }
      }

      const sartreFigure = await storage.getThinker("sartre");
      if (!sartreFigure) {
        return res.status(500).json({ error: "Sartre figure not available" });
      }

      const embeddingChunks = await searchPhilosophicalChunks(message, 6, "sartre", "Sartre");
      const textChunksRes = await searchTextChunks("Sartre", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker("Sartre", message, 40);
      const queryWords = message.toLowerCase().split(/\s+/).filter((word: string) => word.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker ILIKE ${"%Sartre%"} AND (
              position_text ILIKE ${"%" + queryWords[0] + "%"}
              ${queryWords[1] ? sql` OR position_text ILIKE ${"%" + queryWords[1] + "%"}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${"%" + queryWords[2] + "%"}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${"%" + queryWords[3] + "%"}` : sql``}
            )`,
          )
          .limit(15);
      }

      console.log(
        `[Sartre API] RAG — embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`,
      );

      let knowledgeContext = "";
      if (embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = "\n\n--- YOUR WRITINGS (for reference) ---\n\n";
        if (positionResults.length) {
          knowledgeContext += "=== YOUR CORE POSITIONS ===\n";
          for (const position of positionResults) knowledgeContext += `• ${position.position}\n`;
          knowledgeContext += "\n";
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, " ")}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, "").replace(/_/g, " ")}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext +=
          "--- END ---\n\nINSTRUCTION: Answer in Jean-Paul Sartre's voice and ground your claims exclusively in Sartre's writings above.\n";
      } else {
        knowledgeContext =
          "\n\nNOTE: No specific Sartre passages were retrieved. Respond only from Sartre's documented positions, or acknowledge when the question falls outside them.\n";
      }

      let responseInstructions = `\nTARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from Sartre's writings above.\n`;
      }
      responseInstructions +=
        "\nSTYLE: Write as Jean-Paul Sartre: direct, existential, rigorous, and attentive to freedom, responsibility, bad faith, consciousness, and concrete human situations.\nFORMATTING: Plain text only (no markdown).\n";

      const systemPrompt = sartreFigure.systemPrompt + structuredArgumentsContext + knowledgeContext + responseInstructions;
      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map((item) => `${item.role === "user" ? "Interlocutor" : "Sartre"}: ${item.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }
      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();
        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamError) {
          console.error("[Sartre API] Stream error:", streamError);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "sartre",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[Sartre API] Error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate Sartre response" });
    }
  });

  app.post("/api/external/nietzsche", verifyNietzscheApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;
      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const item of history.slice(-20)) {
          if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
            validHistory.push({ role: item.role, content: item.content.slice(0, 8000) });
          }
        }
      }

      const nietzscheFigure = await storage.getThinker("nietzsche");
      if (!nietzscheFigure) {
        return res.status(500).json({ error: "Nietzsche figure not available" });
      }

      const embeddingChunks = await searchPhilosophicalChunks(message, 6, "nietzsche", "Nietzsche");
      const textChunksRes = await searchTextChunks("Nietzsche", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker("Nietzsche", message, 40);
      const queryWords = message.toLowerCase().split(/\s+/).filter((word: string) => word.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker ILIKE ${"%Nietzsche%"} AND (
              position_text ILIKE ${"%" + queryWords[0] + "%"}
              ${queryWords[1] ? sql` OR position_text ILIKE ${"%" + queryWords[1] + "%"}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${"%" + queryWords[2] + "%"}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${"%" + queryWords[3] + "%"}` : sql``}
            )`,
          )
          .limit(15);
      }

      console.log(
        `[Nietzsche API] RAG — embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`,
      );

      let knowledgeContext = "";
      if (embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = "\n\n--- YOUR WRITINGS (for reference) ---\n\n";
        if (positionResults.length) {
          knowledgeContext += "=== YOUR CORE POSITIONS ===\n";
          for (const position of positionResults) knowledgeContext += `• ${position.position}\n`;
          knowledgeContext += "\n";
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, " ")}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, "").replace(/_/g, " ")}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext +=
          "--- END ---\n\nINSTRUCTION: Answer in Friedrich Nietzsche's voice and ground your claims exclusively in Nietzsche's writings above.\n";
      } else {
        knowledgeContext =
          "\n\nNOTE: No specific Nietzsche passages were retrieved. Respond only from Nietzsche's documented positions, or acknowledge when the question falls outside them.\n";
      }

      let responseInstructions = `\nTARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from Nietzsche's writings above.\n`;
      }
      responseInstructions +=
        "\nSTYLE: Write as Friedrich Nietzsche: incisive, psychologically perceptive, aphoristic where apt, and attentive to values, power, self-overcoming, ressentiment, and cultural critique.\nFORMATTING: Plain text only (no markdown).\n";

      const systemPrompt = nietzscheFigure.systemPrompt + structuredArgumentsContext + knowledgeContext + responseInstructions;
      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map((item) => `${item.role === "user" ? "Interlocutor" : "Nietzsche"}: ${item.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }
      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();
        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamError) {
          console.error("[Nietzsche API] Stream error:", streamError);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "nietzsche",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[Nietzsche API] Error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate Nietzsche response" });
    }
  });

  app.post("/api/external/emma-goldman", verifyEmmaGoldmanApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;
      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const item of history.slice(-20)) {
          if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
            validHistory.push({ role: item.role, content: item.content.slice(0, 8000) });
          }
        }
      }

      const goldmanFigure = await storage.getThinker("goldman");
      if (!goldmanFigure) {
        return res.status(500).json({ error: "Emma Goldman figure not available" });
      }

      const embeddingChunks = await searchPhilosophicalChunks(message, 6, "goldman", "Emma Goldman");
      const textChunksRes = await searchTextChunks("Emma Goldman", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker("Emma Goldman", message, 40);
      const queryWords = message.toLowerCase().split(/\s+/).filter((word: string) => word.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker ILIKE ${"%Emma Goldman%"} AND (
              position_text ILIKE ${"%" + queryWords[0] + "%"}
              ${queryWords[1] ? sql` OR position_text ILIKE ${"%" + queryWords[1] + "%"}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${"%" + queryWords[2] + "%"}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${"%" + queryWords[3] + "%"}` : sql``}
            )`,
          )
          .limit(15);
      }

      console.log(
        `[Emma Goldman API] RAG — embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`,
      );

      let knowledgeContext = "";
      if (embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = "\n\n--- YOUR WRITINGS (for reference) ---\n\n";
        if (positionResults.length) {
          knowledgeContext += "=== YOUR CORE POSITIONS ===\n";
          for (const position of positionResults) knowledgeContext += `• ${position.position}\n`;
          knowledgeContext += "\n";
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, " ")}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, "").replace(/_/g, " ")}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext +=
          "--- END ---\n\nINSTRUCTION: Answer in Emma Goldman's voice and ground your claims exclusively in Emma Goldman's writings above.\n";
      } else {
        knowledgeContext =
          "\n\nNOTE: No specific Emma Goldman passages were retrieved. Respond only from Emma Goldman's documented positions, or acknowledge when the question falls outside them.\n";
      }

      let responseInstructions = `\nTARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from Emma Goldman's writings above.\n`;
      }
      responseInstructions +=
        "\nSTYLE: Write as Emma Goldman: passionate, direct, humane, uncompromising about liberty, and attentive to anarchism, authority, labor, feminism, free expression, and individual dignity.\nFORMATTING: Plain text only (no markdown).\n";

      const systemPrompt = goldmanFigure.systemPrompt + structuredArgumentsContext + knowledgeContext + responseInstructions;
      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map((item) => `${item.role === "user" ? "Interlocutor" : "Emma Goldman"}: ${item.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }
      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();
        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamError) {
          console.error("[Emma Goldman API] Stream error:", streamError);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "goldman",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[Emma Goldman API] Error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate Emma Goldman response" });
    }
  });

  app.post("/api/external/adam-smith", verifyAdamSmithApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;
      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const item of history.slice(-20)) {
          if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
            validHistory.push({ role: item.role, content: item.content.slice(0, 8000) });
          }
        }
      }

      const smithFigure = await storage.getThinker("smith");
      if (!smithFigure) {
        return res.status(500).json({ error: "Adam Smith figure not available" });
      }

      const embeddingChunks = await searchPhilosophicalChunks(message, 6, "smith", "Adam Smith");
      const textChunksRes = await searchTextChunks("Adam Smith", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker("Adam Smith", message, 40);
      const queryWords = message.toLowerCase().split(/\s+/).filter((word: string) => word.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker ILIKE ${"%Adam Smith%"} AND (
              position_text ILIKE ${"%" + queryWords[0] + "%"}
              ${queryWords[1] ? sql` OR position_text ILIKE ${"%" + queryWords[1] + "%"}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${"%" + queryWords[2] + "%"}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${"%" + queryWords[3] + "%"}` : sql``}
            )`,
          )
          .limit(15);
      }

      console.log(
        `[Adam Smith API] RAG — embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`,
      );

      let knowledgeContext = "";
      if (embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = "\n\n--- YOUR WRITINGS (for reference) ---\n\n";
        if (positionResults.length) {
          knowledgeContext += "=== YOUR CORE POSITIONS ===\n";
          for (const position of positionResults) knowledgeContext += `• ${position.position}\n`;
          knowledgeContext += "\n";
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, " ")}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, "").replace(/_/g, " ")}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext +=
          "--- END ---\n\nINSTRUCTION: Answer in Adam Smith's voice and ground your claims exclusively in Adam Smith's writings above.\n";
      } else {
        knowledgeContext =
          "\n\nNOTE: No specific Adam Smith passages were retrieved. Respond only from Adam Smith's documented positions, or acknowledge when the question falls outside them.\n";
      }

      let responseInstructions = `\nTARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from Adam Smith's writings above.\n`;
      }
      responseInstructions +=
        "\nSTYLE: Write as Adam Smith: humane, observant, analytically precise, and attentive to sympathy, the impartial spectator, moral sentiments, division of labor, natural liberty, institutions, and commercial society.\nFORMATTING: Plain text only (no markdown).\n";

      const systemPrompt = smithFigure.systemPrompt + structuredArgumentsContext + knowledgeContext + responseInstructions;
      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map((item) => `${item.role === "user" ? "Interlocutor" : "Adam Smith"}: ${item.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }
      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();
        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamError) {
          console.error("[Adam Smith API] Stream error:", streamError);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "smith",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[Adam Smith API] Error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate Adam Smith response" });
    }
  });

  app.post("/api/external/confucius", verifyConfuciusApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;
      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const item of history.slice(-20)) {
          if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
            validHistory.push({ role: item.role, content: item.content.slice(0, 8000) });
          }
        }
      }

      const confuciusFigure = await storage.getThinker("confucius");
      if (!confuciusFigure) {
        return res.status(500).json({ error: "Confucius figure not available" });
      }

      const embeddingChunks = await searchPhilosophicalChunks(message, 6, "confucius", "Confucius");
      const textChunksRes = await searchTextChunks("Confucius", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker("Confucius", message, 40);
      const queryWords = message.toLowerCase().split(/\s+/).filter((word: string) => word.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker ILIKE ${"%Confucius%"} AND (
              position_text ILIKE ${"%" + queryWords[0] + "%"}
              ${queryWords[1] ? sql` OR position_text ILIKE ${"%" + queryWords[1] + "%"}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${"%" + queryWords[2] + "%"}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${"%" + queryWords[3] + "%"}` : sql``}
            )`,
          )
          .limit(15);
      }

      console.log(
        `[Confucius API] RAG — embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`,
      );

      let knowledgeContext = "";
      if (embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = "\n\n--- YOUR TEACHINGS (for reference) ---\n\n";
        if (positionResults.length) {
          knowledgeContext += "=== YOUR CORE POSITIONS ===\n";
          for (const position of positionResults) knowledgeContext += `• ${position.position}\n`;
          knowledgeContext += "\n";
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, " ")}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, "").replace(/_/g, " ")}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext +=
          "--- END ---\n\nINSTRUCTION: Answer in Confucius's voice and ground your claims exclusively in the Confucian teachings above.\n";
      } else {
        knowledgeContext =
          "\n\nNOTE: No specific Confucius passages were retrieved. Respond only from Confucius's documented teachings, or acknowledge when the question falls outside them.\n";
      }

      let responseInstructions = `\nTARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from the Confucius material above.\n`;
      }
      responseInstructions +=
        "\nSTYLE: Write as Confucius: measured, practical, humane, and attentive to virtue, ritual, learning, filial conduct, exemplary leadership, social harmony, and self-cultivation.\nFORMATTING: Plain text only (no markdown).\n";

      const systemPrompt = confuciusFigure.systemPrompt + structuredArgumentsContext + knowledgeContext + responseInstructions;
      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map((item) => `${item.role === "user" ? "Student" : "Confucius"}: ${item.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }
      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();
        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamError) {
          console.error("[Confucius API] Stream error:", streamError);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "confucius",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[Confucius API] Error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate Confucius response" });
    }
  });

  app.post("/api/external/russell", verifyRussellApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;
      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const item of history.slice(-20)) {
          if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
            validHistory.push({ role: item.role, content: item.content.slice(0, 8000) });
          }
        }
      }

      const russellFigure = await storage.getThinker("russell");
      if (!russellFigure) {
        return res.status(500).json({ error: "Bertrand Russell figure not available" });
      }

      const embeddingChunks = await searchPhilosophicalChunks(message, 6, "russell", "Bertrand Russell");
      const textChunksRes = await searchTextChunks("Bertrand Russell", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker("Bertrand Russell", message, 40);
      const queryWords = message.toLowerCase().split(/\s+/).filter((word: string) => word.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker ILIKE ${"%Russell%"} AND (
              position_text ILIKE ${"%" + queryWords[0] + "%"}
              ${queryWords[1] ? sql` OR position_text ILIKE ${"%" + queryWords[1] + "%"}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${"%" + queryWords[2] + "%"}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${"%" + queryWords[3] + "%"}` : sql``}
            )`,
          )
          .limit(15);
      }

      console.log(
        `[Russell API] RAG — embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`,
      );

      let knowledgeContext = "";
      if (embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = "\n\n--- YOUR WRITINGS (for reference) ---\n\n";
        if (positionResults.length) {
          knowledgeContext += "=== YOUR CORE POSITIONS ===\n";
          for (const position of positionResults) knowledgeContext += `• ${position.position}\n`;
          knowledgeContext += "\n";
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, " ")}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, "").replace(/_/g, " ")}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext +=
          "--- END ---\n\nINSTRUCTION: Answer in Bertrand Russell's voice and ground your claims exclusively in Russell's writings above.\n";
      } else {
        knowledgeContext =
          "\n\nNOTE: No specific Russell passages were retrieved. Respond only from Bertrand Russell's documented positions, or acknowledge when the question falls outside them.\n";
      }

      let responseInstructions = `\nTARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from Russell's writings above.\n`;
      }
      responseInstructions +=
        "\nSTYLE: Write as Bertrand Russell: lucid, precise, skeptical, humane, and attentive to logic, analysis, knowledge, science, ethics, freedom, and social criticism.\nFORMATTING: Plain text only (no markdown).\n";

      const systemPrompt = russellFigure.systemPrompt + structuredArgumentsContext + knowledgeContext + responseInstructions;
      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map((item) => `${item.role === "user" ? "Interlocutor" : "Russell"}: ${item.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }
      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();
        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamError) {
          console.error("[Russell API] Stream error:", streamError);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "russell",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[Russell API] Error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate Russell response" });
    }
  });

  app.post("/api/external/marden", verifyMardenApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;
      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const item of history.slice(-20)) {
          if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
            validHistory.push({ role: item.role, content: item.content.slice(0, 8000) });
          }
        }
      }

      const mardenFigure = await storage.getThinker("marden");
      if (!mardenFigure) {
        return res.status(500).json({ error: "Orison Swett Marden figure not available" });
      }

      const embeddingChunks = await searchPhilosophicalChunks(message, 6, "marden", "Orison Swett Marden");
      const textChunksRes = await searchTextChunks("Orison Swett Marden", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker("Orison Swett Marden", message, 40);
      const queryWords = message.toLowerCase().split(/\s+/).filter((word: string) => word.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker ILIKE ${"%Marden%"} AND (
              position_text ILIKE ${"%" + queryWords[0] + "%"}
              ${queryWords[1] ? sql` OR position_text ILIKE ${"%" + queryWords[1] + "%"}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${"%" + queryWords[2] + "%"}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${"%" + queryWords[3] + "%"}` : sql``}
            )`,
          )
          .limit(15);
      }

      console.log(
        `[Marden API] RAG — embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`,
      );

      let knowledgeContext = "";
      if (embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = "\n\n--- YOUR WRITINGS (for reference) ---\n\n";
        if (positionResults.length) {
          knowledgeContext += "=== YOUR CORE POSITIONS ===\n";
          for (const position of positionResults) knowledgeContext += `• ${position.position}\n`;
          knowledgeContext += "\n";
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, " ")}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, "").replace(/_/g, " ")}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext +=
          "--- END ---\n\nINSTRUCTION: Answer in Orison Swett Marden's voice and ground your claims exclusively in Marden's writings above.\n";
      } else {
        knowledgeContext =
          "\n\nNOTE: No specific Marden passages were retrieved. Respond only from Orison Swett Marden's documented positions, or acknowledge when the question falls outside them.\n";
      }

      let responseInstructions = `\nTARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from Marden's writings above.\n`;
      }
      responseInstructions +=
        "\nSTYLE: Write as Orison Swett Marden: encouraging, practical, energetic, and attentive to character, courage, self-reliance, disciplined thought, perseverance, work, and human potential.\nFORMATTING: Plain text only (no markdown).\n";

      const systemPrompt = mardenFigure.systemPrompt + structuredArgumentsContext + knowledgeContext + responseInstructions;
      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map((item) => `${item.role === "user" ? "Interlocutor" : "Marden"}: ${item.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }
      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();
        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamError) {
          console.error("[Marden API] Stream error:", streamError);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "marden",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[Marden API] Error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate Marden response" });
    }
  });

  app.post("/api/external/gardner", verifyGardnerApiKey, async (req, res) => {
    try {
      const { message, history, maxWords, quotes, stream } = req.body || {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "'message' (string) is required" });
      }
      if (message.length > 20000) {
        return res.status(400).json({ error: "'message' too long (max 20,000 characters)" });
      }

      const targetWords = Math.min(Math.max(parseInt(maxWords, 10) || 750, 50), 5000);
      const targetQuotes = Math.min(Math.max(parseInt(quotes, 10) || 0, 0), 20) || (quotes === 0 ? 0 : 3);
      const wantStream = stream === true;
      const validHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(history)) {
        for (const item of history.slice(-20)) {
          if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
            validHistory.push({ role: item.role, content: item.content.slice(0, 8000) });
          }
        }
      }

      const gardnerFigure = await storage.getThinker("gardner");
      if (!gardnerFigure) {
        return res.status(500).json({ error: "Martin Gardner figure not available" });
      }

      const embeddingChunks = await searchPhilosophicalChunks(message, 6, "gardner", "Martin Gardner");
      const textChunksRes = await searchTextChunks("Martin Gardner", message, 6);
      const structuredArgumentsContext = await getArgumentsForThinker("Martin Gardner", message, 40);
      const queryWords = message.toLowerCase().split(/\s+/).filter((word: string) => word.length > 3);
      let positionResults: Array<{ position: string; topic: string | null }> = [];
      if (queryWords.length > 0) {
        positionResults = await db
          .select({ position: positions.positionText, topic: positions.topic })
          .from(positions)
          .where(
            sql`thinker ILIKE ${"%Gardner%"} AND (
              position_text ILIKE ${"%" + queryWords[0] + "%"}
              ${queryWords[1] ? sql` OR position_text ILIKE ${"%" + queryWords[1] + "%"}` : sql``}
              ${queryWords[2] ? sql` OR position_text ILIKE ${"%" + queryWords[2] + "%"}` : sql``}
              ${queryWords[3] ? sql` OR position_text ILIKE ${"%" + queryWords[3] + "%"}` : sql``}
            )`,
          )
          .limit(15);
      }

      console.log(
        `[Gardner API] RAG — embed: ${embeddingChunks.length}, text: ${textChunksRes.length}, positions: ${positionResults.length}`,
      );

      let knowledgeContext = "";
      if (embeddingChunks.length || textChunksRes.length || positionResults.length) {
        knowledgeContext = "\n\n--- YOUR WRITINGS (for reference) ---\n\n";
        if (positionResults.length) {
          knowledgeContext += "=== YOUR CORE POSITIONS ===\n";
          for (const position of positionResults) knowledgeContext += `• ${position.position}\n`;
          knowledgeContext += "\n";
        }
        for (const chunk of embeddingChunks) {
          knowledgeContext += `From "${chunk.paperTitle.replace(/_/g, " ")}":\n${chunk.content}\n\n`;
        }
        for (const chunk of textChunksRes) {
          knowledgeContext += `From "${chunk.sourceFile.replace(/\.txt$/, "").replace(/_/g, " ")}":\n${chunk.chunkText}\n\n`;
        }
        knowledgeContext +=
          "--- END ---\n\nINSTRUCTION: Answer in Martin Gardner's voice and ground your claims exclusively in Gardner's writings above.\n";
      } else {
        knowledgeContext =
          "\n\nNOTE: No specific Gardner passages were retrieved. Respond only from Martin Gardner's documented positions, or acknowledge when the question falls outside them.\n";
      }

      let responseInstructions = `\nTARGET LENGTH: Approximately ${targetWords} words.\n`;
      if (targetQuotes > 0) {
        responseInstructions += `QUOTE REQUIREMENT: Include at least ${targetQuotes} verbatim quotes from Gardner's writings above.\n`;
      }
      responseInstructions +=
        "\nSTYLE: Write as Martin Gardner: lucid, playful, precise, skeptical, and attentive to mathematics, puzzles, scientific reasoning, pseudoscience, magic, and the delight of ideas.\nFORMATTING: Plain text only (no markdown).\n";

      const systemPrompt = gardnerFigure.systemPrompt + structuredArgumentsContext + knowledgeContext + responseInstructions;
      let userPrompt = message;
      if (validHistory.length > 0) {
        const historyText = validHistory
          .map((item) => `${item.role === "user" ? "Interlocutor" : "Gardner"}: ${item.content}`)
          .join("\n\n");
        userPrompt = `[Conversation so far:]\n\n${historyText}\n\n[Current message:]\n${message}`;
      }
      const maxTokens = Math.min(Math.max(Math.round(targetWords * 2), 1000), 16000);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.socket) res.socket.setTimeout(0);
        res.flushHeaders();
        try {
          for await (const delta of streamLLMText(systemPrompt, userPrompt, maxTokens, 0.7)) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (streamError) {
          console.error("[Gardner API] Stream error:", streamError);
          res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        }
        res.end();
      } else {
        const responseText = await callLLMPlan(systemPrompt, userPrompt, maxTokens, 0.7);
        res.json({
          response: responseText,
          character: "gardner",
          words: responseText.split(/\s+/).length,
        });
      }
    } catch (error) {
      console.error("[Gardner API] Error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate Gardner response" });
    }
  });

  app.post("/zhi/query", verifyZhiAuth, async (req, res) => {
    try {
      // Validate request body
      const validationResult = zhiQuerySchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({
          error: "Invalid request format",
          details: validationResult.error.errors
        });
      }
      
      const { query, author, limit, includeQuotes } = validationResult.data;
      
      // Audit log
      console.log(`[ZHI Query API] query="${query}", author="${author || 'any'}", limit=${limit}`);
      
      // CRITICAL FIX: Normalize author parameter + auto-detect from query text
      let detectedAuthor = author;
      
      // Step 1: Normalize explicit author parameter (handles "john-michael kuczynski" → "Kuczynski")
      if (detectedAuthor) {
        const { normalizeAuthorName } = await import("./vector-search");
        const normalized = normalizeAuthorName(detectedAuthor);
        if (normalized !== detectedAuthor) {
          console.log(`[ZHI Query API] 📝 Normalized author: "${detectedAuthor}" → "${normalized}"`);
          detectedAuthor = normalized;
        }
      }
      
      // Step 2: Auto-detect from query text if still no author
      if (!detectedAuthor && query) {
        const { detectAuthorFromQuery } = await import("./vector-search");
        detectedAuthor = await detectAuthorFromQuery(query);
        if (detectedAuthor) {
          console.log(`[ZHI Query API] 🎯 Auto-detected author from query: "${detectedAuthor}"`);
        }
      }
      
      // CRITICAL FIX: When quotes requested, search ONLY verbatim text chunks
      // Otherwise use normal search that includes position summaries
      let passages;
      let quotes = [];
      
      if (includeQuotes) {
        // Search ONLY verbatim text chunks for actual quotable content
        const { searchVerbatimChunks } = await import("./vector-search");
        passages = await searchVerbatimChunks(query, limit, detectedAuthor);
        console.log(`[ZHI Query API] 📝 Retrieved ${passages.length} VERBATIM text chunks for quotes`);
        
        // Extract quotes from verbatim text
        quotes = extractQuotes(passages, query, 50, 50);
      } else {
        // Normal search: includes both summaries and verbatim text
        passages = await searchPhilosophicalChunks(query, limit, "common", detectedAuthor);
      }
      
      // No post-filtering - semantic search already handles author/work relevance
      const filteredPassages = passages;
      
      // Build structured response with citations
      const results = filteredPassages.map(passage => ({
        excerpt: passage.content,
        citation: {
          author: passage.author, // CRITICAL: Use actual author field, not extracted from title
          work: passage.paperTitle,
          chunkIndex: passage.chunkIndex,
        },
        relevance: 1 - passage.distance, // Convert distance to relevance score (0-1)
        tokens: passage.tokens
      }));
      
      const response = {
        results,
        quotes: quotes.map(q => ({
          text: q.quote,
          citation: {
            author: q.author,
            work: q.source,
            chunkIndex: q.chunkIndex
          },
          relevance: q.score,
          tokens: Math.ceil(q.quote.split(/\s+/).length * 1.3) // Approximate token count
        })),
        meta: {
          resultsReturned: results.length,
          limitApplied: limit,
          queryProcessed: query,
          filters: {
            author: author || null
          },
          timestamp: Date.now()
        }
      };
      
      res.json(response);
      
    } catch (error) {
      console.error("[ZHI Query API] Error:", error);
      res.status(500).json({ 
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Internal knowledge provider endpoint
  app.post("/api/internal/knowledge", verifyZhiAuth, async (req, res) => {
    try {
      // Validate request body
      const validationResult = knowledgeRequestSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({
          error: "Invalid request format",
          details: validationResult.error.errors
        });
      }
      
      const { query, figureId, author, maxResults, includeQuotes, minQuoteLength, numQuotes, maxCharacters } = validationResult.data;
      
      // Audit log
      const appId = (req as any).zhiAuth?.appId || "unknown";
      console.log(`[Knowledge Provider] ${appId} querying unified knowledge base: "${query}" (figureId: ${figureId}, author: ${author || 'none'}, results: ${maxResults})`);
      
      // CRITICAL FIX: Map figureId → author for backward compatibility with EZHW
      let detectedAuthor = author;
      
      // Step 1: Map figureId to author name if no explicit author provided
      if (!detectedAuthor && figureId && figureId !== 'common') {
        const { mapFigureIdToAuthor } = await import("./vector-search");
        const mappedAuthor = mapFigureIdToAuthor(figureId);
        if (mappedAuthor) {
          console.log(`[Knowledge Provider] 🔄 Mapped figureId "${figureId}" → author "${mappedAuthor}"`);
          detectedAuthor = mappedAuthor;
        }
      }
      
      // Step 2: Normalize explicit author parameter (handles "john-michael kuczynski" → "Kuczynski")
      if (detectedAuthor) {
        const { normalizeAuthorName } = await import("./vector-search");
        const normalized = normalizeAuthorName(detectedAuthor);
        if (normalized !== detectedAuthor) {
          console.log(`[Knowledge Provider] 📝 Normalized author: "${detectedAuthor}" → "${normalized}"`);
          detectedAuthor = normalized;
        }
      }
      
      // Step 3: Auto-detect from query text if still no author
      if (!detectedAuthor && query) {
        const { detectAuthorFromQuery } = await import("./vector-search");
        detectedAuthor = await detectAuthorFromQuery(query);
        if (detectedAuthor) {
          console.log(`[Knowledge Provider] 🎯 Auto-detected author from query: "${detectedAuthor}"`);
        }
      }
      
      // Perform semantic search with STRICT author filtering
      // When author detected/specified → returns ONLY that author's content
      const passages = await searchPhilosophicalChunks(query, maxResults, figureId, detectedAuthor);
      
      // Truncate passages to respect maxCharacters limit
      let totalChars = 0;
      const truncatedPassages: StructuredChunk[] = [];
      
      for (const passage of passages) {
        if (totalChars + passage.content.length <= maxCharacters) {
          truncatedPassages.push(passage);
          totalChars += passage.content.length;
        } else {
          // Include partial passage if there's room
          const remainingChars = maxCharacters - totalChars;
          if (remainingChars > 100) {
            truncatedPassages.push({
              ...passage,
              content: passage.content.substring(0, remainingChars) + "..."
            });
          }
          break;
        }
      }
      
      // Extract quotes if requested
      const quotes = includeQuotes ? extractQuotes(truncatedPassages, query || "", minQuoteLength, numQuotes || 50) : [];
      
      // Build response
      const response = {
        success: true,
        meta: {
          query,
          figureId,
          resultsReturned: truncatedPassages.length,
          totalCharacters: totalChars,
          quotesExtracted: quotes.length,
          timestamp: Date.now()
        },
        passages: truncatedPassages.map(p => ({
          author: p.author, // REQUIRED: Author attribution for every passage
          paperTitle: p.paperTitle,
          content: p.content,
          chunkIndex: p.chunkIndex,
          semanticDistance: p.distance,
          source: p.source,
          figureId: p.figureId,
          tokens: p.tokens
        })),
        quotes: quotes.map(q => ({
          text: q.quote,
          source: q.source,
          chunkIndex: q.chunkIndex
        }))
      };
      
      res.json(response);
      
    } catch (error) {
      console.error("[Knowledge Provider] Error:", error);
      res.status(500).json({ 
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // ======
  // QUOTE GENERATOR: Site Authors
  // ======
  
  app.post("/api/quotes/generate", async (req, res) => {
    try {
      const { query, author, numQuotes = 10 } = req.body;

      if (!author) {
        return res.status(400).json({
          success: false,
          error: "Author is required"
        });
      }

      const quotesLimit = Math.min(Math.max(parseInt(numQuotes) || 10, 1), 50);
      const searchQuery = query?.trim() || "";

      // Map author names to thinker_id in thinker_quotes database
      const thinkerIdMap: Record<string, string> = {
        "J.-M. Kuczynski": "kuczynski",
        "Kuczynski": "kuczynski",
        "Bertrand Russell": "russell",
        "Russell": "russell",
        "Friedrich Nietzsche": "nietzsche",
        "Nietzsche": "nietzsche",
        "Plato": "plato",
        "Aristotle": "aristotle",
        "Immanuel Kant": "kant",
        "Kant": "kant",
        "David Hume": "hume",
        "Hume": "hume",
        "G.W.F. Hegel": "hegel",
        "Hegel": "hegel",
        "Adam Smith": "smith",
        "Smith": "smith",
        "John Dewey": "dewey",
        "Dewey": "dewey",
        "John Stuart Mill": "mill",
        "Mill": "mill",
        "René Descartes": "descartes",
        "Descartes": "descartes",
        "ALLEN": "allen",
        "James Allen": "allen",
        "Sigmund Freud": "freud",
        "Freud": "freud",
        "Baruch Spinoza": "spinoza",
        "Spinoza": "spinoza",
        "George Berkeley": "berkeley",
        "Berkeley": "berkeley",
        "Thomas Hobbes": "hobbes",
        "Hobbes": "hobbes",
        "John Locke": "locke",
        "Locke": "locke",
        "Jean-Jacques Rousseau": "rousseau",
        "Rousseau": "rousseau",
        "Karl Marx": "marx",
        "Marx": "marx",
        "Arthur Schopenhauer": "schopenhauer",
        "Schopenhauer": "schopenhauer",
        "William James": "williamjames",
        "Gottfried Wilhelm Leibniz": "leibniz",
        "Leibniz": "leibniz",
        "Isaac Newton": "newton",
        "Newton": "newton",
        "Galileo Galilei": "galileo",
        "Galileo": "galileo",
        "Charles Darwin": "darwin",
        "Darwin": "darwin",
        "Voltaire": "voltaire",
        "Edgar Allan Poe": "poe",
        "Poe": "poe",
        "Carl Jung": "jung",
        "Jung": "jung",
        "Francis Bacon": "bacon",
        "Bacon": "bacon",
        "Confucius": "confucius",
        "Emma Goldman": "goldman",
        "Goldman": "goldman",
        "François de La Rochefoucauld": "larochefoucauld",
        "La Rochefoucauld": "larochefoucauld",
        "Alexis de Tocqueville": "tocqueville",
        "Tocqueville": "tocqueville",
        "Friedrich Engels": "engels",
        "Engels": "engels",
        "Vladimir Lenin": "lenin",
        "Lenin": "lenin",
        "Herbert Spencer": "spencer",
        "Spencer": "spencer",
        "Edward Gibbon": "gibbon",
        "Gibbon": "gibbon",
        "Aesop": "aesop",
        "Orison Swett Marden": "marden",
        "Marden": "marden",
        "Moses Maimonides": "maimonides",
        "Maimonides": "maimonides",
        "Wilhelm Reich": "reich",
        "Reich": "reich",
        "Walter Lippmann": "lippmann",
        "Lippmann": "lippmann",
        "Ambrose Bierce": "bierce",
        "Bierce": "bierce",
        "Niccolò Machiavelli": "machiavelli",
        "Machiavelli": "machiavelli",
        "Ludwig von Mises": "mises",
        "Mises": "mises",
        "Friedrich Hayek": "hayek",
        "Hayek": "hayek",
        "Ernst Mach": "mach",
        "Mach": "mach",
        "George Boole": "boole",
        "Boole": "boole",
        "Alfred Adler": "adler",
        "Adler": "adler",
        "Henri Bergson": "bergson",
        "Bergson": "bergson",
      };
      
      // Normalize author name: strip diacritics then remove non-alpha characters
      const thinkerId = thinkerIdMap[author] || author
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')  // Remove diacritics (accents)
        .toLowerCase()
        .replace(/[^a-z]/g, '');

      console.log(`[Quote Generator] Querying quotes for ${author} (id: ${thinkerId}), query: "${searchQuery}", limit: ${quotesLimit}`);

      let quotes: any[] = [];
      
      // If query provided, search by topic/quote content
      if (searchQuery) {
        const searchWords = searchQuery.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
        if (searchWords.length > 0) {
          const topicConditions = searchWords.slice(0, 5).map((word: string) => `quote_text ILIKE '%${word}%' OR topic ILIKE '%${word}%'`).join(' OR ');
          const searchResult = await db.execute(
            sql`SELECT quote_text as quote, topic FROM quotes 
                WHERE LOWER(thinker) = ${thinkerId} 
                AND (${sql.raw(topicConditions)})
                ORDER BY RANDOM() 
                LIMIT ${quotesLimit}`
          );
          quotes = searchResult.rows || [];
          console.log(`[Quote Generator] Topic search found ${quotes.length} quotes`);
        }
      }
      
      // If no query or no matches, get random quotes
      if (quotes.length === 0) {
        const randomResult = await db.execute(
          sql`SELECT quote_text as quote, topic FROM quotes 
              WHERE LOWER(thinker) = ${thinkerId} 
              ORDER BY RANDOM() 
              LIMIT ${quotesLimit}`
        );
        quotes = randomResult.rows || [];
        console.log(`[Quote Generator] Random selection found ${quotes.length} quotes`);
      }

      // LLM FALLBACK: If still no quotes, use RAG + LLM to generate them
      let usedFallback = false;
      if (quotes.length === 0) {
        console.log(`[Quote Generator] No curated quotes found, using LLM fallback for ${author}`);
        usedFallback = true;
        
        try {
          // Get relevant chunks from the thinker's works via RAG
          const normalizedAuthor = normalizeAuthorName(author);
          const ragQuery = searchQuery || author + " philosophy ideas";
          const chunks = await searchPhilosophicalChunks(ragQuery, 8, "common", normalizedAuthor);
          
          if (chunks.length > 0) {
            console.log(`[Quote Generator] Found ${chunks.length} RAG chunks for ${author}`);
            
            // Build context from chunks
            const context = chunks.map((c, i) => 
              `[Source ${i+1}: ${c.paperTitle}]\n${c.content}`
            ).join('\n\n---\n\n');
            
            // Use LLM to extract quotes
            const prompt = `You are extracting memorable quotes from ${author}'s writings.

CONTEXT FROM ${author.toUpperCase()}'S WORKS:
${context}

TASK: Extract ${quotesLimit} distinct, quotable passages from the above text. Each quote should be:
- A complete, standalone thought (1-3 sentences)
- Philosophically significant or memorable
- Directly from the source material (do NOT paraphrase or invent)

Format each quote as:
QUOTE: [exact quote text]
SOURCE: [source title]

Extract ${quotesLimit} quotes now:`;

            const response = await anthropic!.messages.create({
              model: "claude-sonnet-4-5-20250929",
              max_tokens: 2000,
              temperature: 0.3,
              messages: [{ role: "user", content: prompt }]
            });
            
            const responseText = response.content[0].type === 'text' ? response.content[0].text : '';
            
            // Parse quotes from response
            const quoteMatches = responseText.matchAll(/QUOTE:\s*(.+?)(?:\nSOURCE:\s*(.+?))?(?=\n\nQUOTE:|\n*$)/gs);
            for (const match of quoteMatches) {
              if (quotes.length >= quotesLimit) break;
              const quoteText = match[1]?.trim().replace(/^["']|["']$/g, '');
              const source = match[2]?.trim() || chunks[0]?.paperTitle || 'Works';
              if (quoteText && quoteText.length > 20) {
                quotes.push({ quote: quoteText, source, topic: 'Generated' });
              }
            }
            console.log(`[Quote Generator] LLM extracted ${quotes.length} quotes`);
          } else {
            console.log(`[Quote Generator] No RAG chunks found for ${author}, using general knowledge`);
            
            // Fallback to general knowledge
            const prompt = `Generate ${quotesLimit} authentic-sounding quotes that capture ${author}'s philosophical views and writing style.

REQUIREMENTS:
- Each quote should reflect ${author}'s known philosophical positions
- Use their characteristic terminology and style
- 1-3 sentences each
- Do NOT invent views they never held

Format each as:
QUOTE: [quote text]
SOURCE: [likely source work]

Generate ${quotesLimit} quotes:`;

            const response = await anthropic!.messages.create({
              model: "claude-sonnet-4-5-20250929",
              max_tokens: 2000,
              temperature: 0.5,
              messages: [{ role: "user", content: prompt }]
            });
            
            const responseText = response.content[0].type === 'text' ? response.content[0].text : '';
            
            const quoteMatches = responseText.matchAll(/QUOTE:\s*(.+?)(?:\nSOURCE:\s*(.+?))?(?=\n\nQUOTE:|\n*$)/gs);
            for (const match of quoteMatches) {
              if (quotes.length >= quotesLimit) break;
              const quoteText = match[1]?.trim().replace(/^["']|["']$/g, '');
              const source = match[2]?.trim() || 'Works';
              if (quoteText && quoteText.length > 20) {
                quotes.push({ quote: quoteText, source, topic: 'Generated' });
              }
            }
            console.log(`[Quote Generator] LLM generated ${quotes.length} quotes from general knowledge`);
          }
        } catch (llmError) {
          console.error(`[Quote Generator] LLM fallback failed:`, llmError);
        }
      }

      console.log(`[Quote Generator] Returning ${quotes.length} quotes from ${author}${usedFallback ? ' (LLM fallback)' : ''}`);

      res.json({
        success: true,
        quotes: quotes.map((row: any, idx: number) => ({
          text: row.quote,
          source: row.source || row.topic || 'Works',
          chunkIndex: idx,
          author: author
        })),
        meta: {
          query: searchQuery,
          author,
          quotesFound: quotes.length,
          usedFallback
        }
      });

    } catch (error) {
      console.error("[Quote Generator] Error:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to generate quotes"
      });
    }
  });

  // ======
  // POSITION GENERATOR - DIRECT DATABASE QUERY
  // ======
  
  app.post("/api/positions/generate", async (req, res) => {
    try {
      const { thinker, topic, numPositions = 20 } = req.body;

      if (!thinker) {
        return res.status(400).json({
          success: false,
          error: "Thinker is required"
        });
      }

      const positionsLimit = Math.min(Math.max(parseInt(numPositions) || 20, 5), 50);
      
      // Normalize thinker name - extract last word (typically the surname) for better matching
      const thinkerParts = thinker.trim().split(/[\s.,-]+/).filter((p: string) => p.length > 1);
      const normalizedThinker = thinkerParts[thinkerParts.length - 1] || thinker;
      
      console.log(`[Position Generator] Querying database for ${positionsLimit} positions from ${thinker} (normalized: ${normalizedThinker})${topic ? ` on: "${topic}"` : ' (all topics)'}`);

      // Set up SSE response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Query positions table directly - NO LLM generation
      let positions: any[] = [];
      
      if (topic?.trim()) {
        // Search by topic if provided
        positions = await db.execute(sql`
          SELECT position_text, topic 
          FROM positions 
          WHERE thinker ILIKE ${'%' + normalizedThinker + '%'}
          AND (topic ILIKE ${'%' + topic + '%'} OR position_text ILIKE ${'%' + topic + '%'})
          ORDER BY RANDOM()
          LIMIT ${positionsLimit}
        `);
      } else {
        // Get random positions across all topics
        positions = await db.execute(sql`
          SELECT position_text, topic 
          FROM positions 
          WHERE thinker ILIKE ${'%' + normalizedThinker + '%'}
          ORDER BY RANDOM()
          LIMIT ${positionsLimit}
        `);
      }

      const rows = (positions as any).rows || positions;
      
      // If database has results, use them
      if (rows && rows.length > 0) {
        console.log(`[Position Generator] Found ${rows.length} positions for ${thinker}`);

        // Stream positions as plain text — no numbering, no topic brackets.
        for (let idx = 0; idx < rows.length; idx++) {
          const row = rows[idx];
          const positionLine = `${row.position_text}\n\n`;
          res.write(`data: ${JSON.stringify({ content: positionLine })}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // LLM FALLBACK: No database results, use AI to generate positions
      console.log(`[Position Generator] No DB results, using LLM fallback for ${thinker}`);
      
      const topicContext = topic ? ` focusing on the topic of "${topic}"` : '';
      const prompt = `You are a scholarly expert on ${thinker}'s philosophy. Generate ${positionsLimit} distinct philosophical position statements that ${thinker} would hold${topicContext}.

Each position should:
- Be a clear, standalone philosophical claim (1-2 sentences)
- Accurately represent ${thinker}'s documented views
- Be specific and substantive, not vague generalizations

OUTPUT RULES (STRICT):
- Output ONLY the position statements, one per line, separated by a blank line.
- DO NOT number the statements.
- DO NOT add any topic label, subject-matter tag, parenthetical, or bracketed annotation.
- No preamble, no commentary, no headers. Just the bare statements.`;

      try {
        // Use available AI client
        const aiClient = openai || anthropic;
        if (!aiClient) {
          res.write(`data: ${JSON.stringify({ content: `No AI service configured. Please add API keys.` })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        if (openai) {
          const stream = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            stream: true,
            max_tokens: 2000,
          });

          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
              res.write(`data: ${JSON.stringify({ content })}\n\n`);
            }
          }
        } else if (anthropic) {
          const stream = await anthropic.messages.stream({
            model: "claude-sonnet-4-5-20250929",
            max_tokens: 2000,
            messages: [{ role: "user", content: prompt }],
          });

          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
            }
          }
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } catch (llmError) {
        console.error("[Position Generator] LLM fallback error:", llmError);
        res.write(`data: ${JSON.stringify({ content: `Error generating positions. Please try again.` })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }

    } catch (error) {
      console.error("[Position Generator] Error:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to generate positions"
      });
    }
  });

  // ======
  // ARGUMENT GENERATOR - DATABASE + LLM FALLBACK
  // ======
  
  app.post("/api/arguments/generate", async (req, res) => {
    try {
      const { thinker, keywords, numArguments = 10 } = req.body;

      if (!thinker) {
        return res.status(400).json({
          success: false,
          error: "Thinker is required"
        });
      }

      const argumentsLimit = Math.min(Math.max(parseInt(numArguments) || 10, 1), 100);
      
      // Normalize thinker name - extract last word (typically the surname) for better matching
      const thinkerParts = thinker.trim().split(/[\s.,-]+/).filter((p: string) => p.length > 1);
      const normalizedThinker = thinkerParts[thinkerParts.length - 1] || thinker;
      
      console.log(`[Argument Generator] Querying database for ${argumentsLimit} arguments from ${thinker} (normalized: ${normalizedThinker})${keywords ? ` with keywords: "${keywords}"` : ''}`);

      // Set up SSE response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Query argument_statements table directly (if it exists)
      let rows: any[] = [];
      
      try {
        let arguments_result: any[] = [];
        
        if (keywords?.trim()) {
          // Search by keywords if provided
          arguments_result = await db.execute(sql`
            SELECT premises, conclusion, argument_type, source_section
            FROM argument_statements 
            WHERE thinker ILIKE ${'%' + normalizedThinker + '%'}
            AND (conclusion ILIKE ${'%' + keywords + '%'} 
                 OR array_to_string(premises, ' ') ILIKE ${'%' + keywords + '%'}
                 OR source_section ILIKE ${'%' + keywords + '%'})
            ORDER BY importance DESC NULLS LAST, RANDOM()
            LIMIT ${argumentsLimit}
          `);
        } else {
          // Get top arguments by importance
          arguments_result = await db.execute(sql`
            SELECT premises, conclusion, argument_type, source_section
            FROM argument_statements 
            WHERE thinker ILIKE ${'%' + normalizedThinker + '%'}
            ORDER BY importance DESC NULLS LAST, RANDOM()
            LIMIT ${argumentsLimit}
          `);
        }

        rows = (arguments_result as any).rows || arguments_result;
      } catch (dbError: any) {
        // Table may not exist - proceed to LLM fallback
        console.log(`[Argument Generator] Database query failed (table may not exist), using LLM fallback`);
        rows = [];
      }
      
      // If database has results, use them
      if (rows && rows.length > 0) {
        console.log(`[Argument Generator] Found ${rows.length} arguments for ${thinker}`);

        // Format arguments and stream them
        for (let idx = 0; idx < rows.length; idx++) {
          const row = rows[idx];
          const premises = Array.isArray(row.premises) ? row.premises : [];
          const argType = row.argument_type ? ` [${row.argument_type}]` : '';
          const source = row.source_section ? ` (${row.source_section})` : '';
          
          let argumentText = `ARGUMENT ${idx + 1}${argType}${source}\n`;
          premises.forEach((p: string, pIdx: number) => {
            argumentText += `  P${pIdx + 1}: ${p}\n`;
          });
          argumentText += `  ∴ ${row.conclusion}\n\n`;
          
          res.write(`data: ${JSON.stringify({ content: argumentText })}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // LLM FALLBACK: No database results or table doesn't exist, use AI to generate arguments
      console.log(`[Argument Generator] No DB results, using LLM fallback for ${thinker}`);
      
      // First, get context from positions table to ground the LLM
      let contextPositions: string[] = [];
      try {
        const positionsResult = await db.execute(sql`
          SELECT position_text FROM positions 
          WHERE thinker ILIKE ${'%' + normalizedThinker + '%'}
          ORDER BY RANDOM()
          LIMIT 20
        `);
        const posRows = (positionsResult as any).rows || positionsResult;
        if (posRows && posRows.length > 0) {
          contextPositions = posRows.map((r: any) => r.position_text);
        }
      } catch (e) {
        console.log(`[Argument Generator] Could not fetch positions for context`);
      }

      const keywordContext = keywords ? ` focusing on "${keywords}"` : '';
      const positionsContext = contextPositions.length > 0 
        ? `\n\nHere are some of ${thinker}'s documented positions to base arguments on:\n${contextPositions.map((p, i) => `${i+1}. ${p}`).join('\n')}\n\nUsing these positions as source material, `
        : '';
      
      const prompt = `You are generating philosophical arguments for ${thinker}.${positionsContext}Generate ${argumentsLimit} distinct philosophical arguments that ${thinker} would make${keywordContext}.

Each argument should:
- Have clear premises (P1, P2, etc.) leading to a conclusion
- Be logically structured (deductive, inductive, or causal)
- Include the argument type in brackets when clear

Format each as:
ARGUMENT N [type]
  P1: [first premise]
  P2: [second premise]
  ∴ [conclusion]

Begin:`;

      try {
        const aiClient = openai || anthropic;
        if (!aiClient) {
          res.write(`data: ${JSON.stringify({ content: `No AI service configured. Please add API keys.` })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        if (openai) {
          const stream = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            stream: true,
            max_tokens: 4000,
          });

          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
              res.write(`data: ${JSON.stringify({ content })}\n\n`);
            }
          }
        } else if (anthropic) {
          const stream = await anthropic.messages.stream({
            model: "claude-sonnet-4-5-20250929",
            max_tokens: 4000,
            messages: [{ role: "user", content: prompt }],
          });

          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
            }
          }
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } catch (llmError) {
        console.error("[Argument Generator] LLM fallback error:", llmError);
        res.write(`data: ${JSON.stringify({ content: `Error generating arguments. Please try again.` })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }

    } catch (error) {
      console.error("[Argument Generator] Error:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to generate arguments"
      });
    }
  });

  // ======
  // QUOTE EXTRACTION FROM UPLOADED FILES
  // ======

  // Configure multer for file uploads
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB limit
    },
    fileFilter: (req, file, cb) => {
      const allowedTypes = ['text/plain', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'];
      if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(txt|pdf|docx|doc)$/i)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid file type. Only .txt, .pdf, .doc, and .docx files are allowed.'));
      }
    }
  });

  // Generic file parsing endpoint - extracts text from uploaded files
  app.post("/api/parse-file", upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ 
          success: false,
          error: "No file uploaded" 
        });
      }

      let textContent = '';
      const fileExtension = req.file.originalname.split('.').pop()?.toLowerCase();
      
      if (fileExtension === 'txt' || fileExtension === 'md') {
        textContent = req.file.buffer.toString('utf-8');
      } else if (fileExtension === 'pdf') {
        const pdfData = await pdfParse(req.file.buffer);
        textContent = pdfData.text;
      } else if (fileExtension === 'docx') {
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        textContent = result.value;
      } else if (fileExtension === 'doc') {
        try {
          const result = await mammoth.extractRawText({ buffer: req.file.buffer });
          textContent = result.value;
        } catch (err) {
          return res.status(400).json({
            success: false,
            error: "Legacy .doc format not fully supported. Please convert to .docx or .pdf"
          });
        }
      } else {
        return res.status(400).json({
          success: false,
          error: "Unsupported file type. Allowed: .txt, .md, .pdf, .doc, .docx"
        });
      }

      if (!textContent.trim()) {
        return res.status(400).json({
          success: false,
          error: "Document appears to be empty or could not be parsed"
        });
      }

      console.log(`[Parse File] Processed ${req.file.originalname} (${textContent.length} chars)`);

      res.json({ 
        success: true, 
        text: textContent,
        filename: req.file.originalname,
        charCount: textContent.length
      });
    } catch (error) {
      console.error("[Parse File] Error:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to parse file"
      });
    }
  });

  // Extract quotes from uploaded document
  app.post("/api/quotes/extract", upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ 
          success: false,
          error: "No file uploaded" 
        });
      }

      const { query = 'all', numQuotes = '10' } = req.body;
      const quotesLimit = Math.min(Math.max(parseInt(numQuotes) || 10, 1), 50);

      let textContent = '';

      // Parse file based on type
      const fileExtension = req.file.originalname.split('.').pop()?.toLowerCase();
      
      if (fileExtension === 'txt') {
        textContent = req.file.buffer.toString('utf-8');
      } else if (fileExtension === 'pdf') {
        const pdfData = await pdfParse(req.file.buffer);
        textContent = pdfData.text;
      } else if (fileExtension === 'docx') {
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        textContent = result.value;
      } else if (fileExtension === 'doc') {
        // For legacy .doc files, try mammoth (works for some)
        try {
          const result = await mammoth.extractRawText({ buffer: req.file.buffer });
          textContent = result.value;
        } catch (err) {
          return res.status(400).json({
            success: false,
            error: "Legacy .doc format not fully supported. Please convert to .docx or .pdf"
          });
        }
      } else {
        return res.status(400).json({
          success: false,
          error: "Unsupported file type"
        });
      }

      if (!textContent.trim()) {
        return res.status(400).json({
          success: false,
          error: "Document appears to be empty or could not be parsed"
        });
      }

      console.log(`[Quote Extraction] Processing ${req.file.originalname} (${textContent.length} chars)`);

      // Extract quotes from the document text
      const quotes: string[] = [];
      
      // First, try to find explicit quotes (text in quotation marks)
      const explicitQuotePattern = /"([^"]{50,500})"/g;
      const explicitMatches = Array.from(textContent.matchAll(explicitQuotePattern));
      for (const match of explicitMatches) {
        if (match[1] && match[1].trim().length >= 50) {
          quotes.push(match[1].trim());
        }
      }

      // Then extract substantial sentences as quotes
      const sentences = textContent.split(/[.!?]\s+/);
      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        
        // Filter by query if provided
        if (query && query !== 'all') {
          const queryLower = query.toLowerCase();
          const sentenceLower = trimmed.toLowerCase();
          if (!sentenceLower.includes(queryLower)) {
            continue;
          }
        }

        // Accept sentences between 50-500 chars
        if (trimmed.length >= 50 && trimmed.length <= 500) {
          const wordCount = trimmed.split(/\s+/).length;
          
          // Quality filters
          const hasFormattingArtifacts = 
            trimmed.includes('(<< back)') ||
            trimmed.includes('(<<back)') ||
            trimmed.includes('[<< back]') ||
            trimmed.includes('*_') ||
            trimmed.includes('_*') ||
            /\(\d+\)\s*$/.test(trimmed) ||
            /\[\d+\]\s*$/.test(trimmed);
          
          const specialCharCount = (trimmed.match(/[<>{}|\\]/g) || []).length;
          const hasExcessiveSpecialChars = specialCharCount > 5;
          
          if (wordCount >= 5 && !hasFormattingArtifacts && !hasExcessiveSpecialChars) {
            quotes.push(trimmed);
          }
        }
      }

      // Deduplicate and limit
      const uniqueQuotes = Array.from(new Set(quotes));
      const finalQuotes = uniqueQuotes.slice(0, quotesLimit);

      console.log(`[Quote Extraction] Found ${finalQuotes.length} quotes from ${req.file.originalname}`);

      res.json({
        success: true,
        quotes: finalQuotes,
        meta: {
          filename: req.file.originalname,
          totalQuotesFound: uniqueQuotes.length,
          quotesReturned: finalQuotes.length,
          documentLength: textContent.length
        }
      });

    } catch (error) {
      console.error("[Quote Extraction] Error:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to extract quotes"
      });
    }
  });

  // ======
  // ElevenLabs TTS: convert generated dialogues/interviews/debates to audio
  // Each distinct speaker gets a different voice.
  app.post("/api/tts/convert", async (req, res) => {
    try {
      const { text, format: formatRaw } = req.body || {};
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: "Missing 'text' to convert" });
      }
      if (text.length > 400_000) {
        return res.status(400).json({ error: "Text too long for audio conversion (max ~400,000 characters)" });
      }
      const format = formatRaw === 'wav' ? 'wav' : 'mp3';
      if (!process.env.ELEVENLABS_API_KEY) {
        return res.status(503).json({ error: "ELEVENLABS_API_KEY is not configured" });
      }

      const { convertDialogueToAudio, parseSpeakerSegments } = await import('./services/ttsService');
      if (parseSpeakerSegments(text).length === 0) {
        return res.status(400).json({
          error: "No speaker lines found. Expected lines like 'SOCRATES: ...' or 'Speaker 1: ...'",
        });
      }
      const result = await convertDialogueToAudio(text, format);

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="dialogue.${result.extension}"`);
      res.setHeader('X-Voice-Map', encodeURIComponent(JSON.stringify(result.voiceMap)));
      res.setHeader('Access-Control-Expose-Headers', 'X-Voice-Map, Content-Disposition');
      res.send(result.audio);
    } catch (error: any) {
      console.error('[TTS] Conversion failed:', error?.message || error);
      res.status(500).json({ error: error?.message || 'TTS conversion failed' });
    }
  });

  // ======
  // THESIS TO WORLD: Documentary Incident Generator
  // Dialogue Creator endpoint
  app.post("/api/dialogue-creator", upload.single('file'), async (req, res) => {
    try {
      let sourceText = '';
      const { text, customInstructions, authorId1, authorId2, authorId3, authorId4, wordLength, quoteCount: quoteCountRaw, elevenLabsMode: elevenLabsModeRaw, existingText, priorDialogue } = req.body;
      const targetQuoteCount = Math.min(Math.max(parseInt(quoteCountRaw) || 0, 0), 20);
      const elevenLabsMode = elevenLabsModeRaw === 'true' || elevenLabsModeRaw === true;
      
      // Parse target word length
      const targetWordLength = Math.min(Math.max(parseInt(wordLength) || 1200, 100), 50000);

      // Get text from file upload or direct input
      if (req.file) {
        const fileExtension = req.file.originalname.split('.').pop()?.toLowerCase();
        
        if (fileExtension === 'txt') {
          sourceText = req.file.buffer.toString('utf-8');
        } else if (fileExtension === 'pdf') {
          const pdfData = await pdfParse(req.file.buffer);
          sourceText = pdfData.text;
        } else if (fileExtension === 'docx' || fileExtension === 'doc') {
          const result = await mammoth.extractRawText({ buffer: req.file.buffer });
          sourceText = result.value;
        } else {
          return res.status(400).json({
            success: false,
            error: "Unsupported file type. Please upload .txt, .pdf, .doc, or .docx"
          });
        }
      } else if (text) {
        sourceText = text;
      }

      if (!sourceText || sourceText.trim().length < 5) {
        return res.status(400).json({
          success: false,
          error: "Please provide at least 5 characters (topic or text)"
        });
      }

      // Determine if input is a short topic vs a full text
      const isTopicOnly = sourceText.trim().length < 200;
      
      // Truncate source text for vector search (max 500 chars to fit embedding model)
      const searchQueryText = sourceText.slice(0, 500);
      
      // Truncate source text for LLM prompt (max 15k chars)
      const maxSourceLength = 15000;
      const truncatedSourceText = sourceText.length > maxSourceLength 
        ? sourceText.slice(0, maxSourceLength) + "\n\n[Document truncated - showing first 15k characters]"
        : sourceText;

      console.log(`[Dialogue Creator] Generating dialogue, ${sourceText.length} chars input (${isTopicOnly ? 'topic' : 'text'}), thinker1=${authorId1}, thinker2=${authorId2 || 'none'}`);

      // Gather up to four participants (thinkers and/or Everyman), de-duplicating while preserving order
      const uniqueAuthorIds = Array.from(
        new Set([authorId1, authorId2, authorId3, authorId4].filter((id) => id && id !== 'none'))
      );
      interface DialogueParticipant {
        isEveryman: boolean;
        name: string;
        shortName: string;
        content: string;
      }
      const participants: DialogueParticipant[] = [];

      for (const aid of uniqueAuthorIds) {
        if (aid === 'everyman') {
          participants.push({ isEveryman: true, name: 'Everyman', shortName: 'EVERYMAN', content: '' });
          continue;
        }

        try {
          const author = await storage.getThinker(aid);
          if (!author) continue;
          const name = author.name;
          const normalizedAuthorName = normalizeAuthorName(name);
          console.log(`[Dialogue Creator] Participant: ${name} (normalized: ${normalizedAuthorName})`);

          let content = '';
          const relevantChunks = await searchPhilosophicalChunks(
            searchQueryText,
            4,
            "common",
            normalizedAuthorName
          );

          if (relevantChunks.length > 0) {
            content = `\n\n=== REFERENCE MATERIAL FROM ${name.toUpperCase()} ===\n\n`;
            relevantChunks.forEach((chunk, index) => {
              content += `[Excerpt ${index + 1}] ${chunk.paperTitle}\n${chunk.content}\n\n`;
            });
            content += `=== END REFERENCE MATERIAL ===\n`;
            console.log(`[Dialogue Creator] Retrieved ${relevantChunks.length} chunks for ${name}`);
          }

          participants.push({
            isEveryman: false,
            name,
            shortName: (name.split(' ').pop() || 'PHILOSOPHER').toUpperCase(),
            content,
          });
        } catch (error) {
          console.error(`[Dialogue Creator] Error retrieving content for ${aid}:`, error);
        }
      }

      if (participants.length === 0) {
        return res.status(400).json({
          success: false,
          error: "Please select at least one valid thinker for the dialogue"
        });
      }

      // Disambiguate duplicate short names (e.g. shared surnames)
      const shortNameCounts: Record<string, number> = {};
      participants.forEach((p) => {
        const base = p.shortName;
        shortNameCounts[base] = (shortNameCounts[base] || 0) + 1;
      });
      const shortNameSeen: Record<string, number> = {};
      participants.forEach((p) => {
        const base = p.shortName;
        if (shortNameCounts[base] > 1) {
          shortNameSeen[base] = (shortNameSeen[base] || 0) + 1;
          p.shortName = `${base} ${shortNameSeen[base]}`;
        }
      });

      // Determine the speaker roster. A lone philosopher gets a STUDENT interlocutor.
      const speakerNames = participants.map((p) => p.shortName);
      if (speakerNames.length === 1) {
        speakerNames.push('STUDENT');
      }

      const philosopherCount = participants.filter((p) => !p.isEveryman).length;
      const hasEveryman = participants.some((p) => p.isEveryman);

      const participantLines = participants
        .map((p) =>
          p.isEveryman
            ? `- **${p.shortName}**: A thoughtful, curious non-philosopher who asks genuine questions, raises common-sense objections, and misunderstands productively (not stupidly)`
            : `- **${p.shortName}** (${p.name}): Use their actual philosophical positions, terminology, and intellectual style`
        )
        .join('\n');

      let configSection: string;
      if (participants.length >= 2) {
        configSection = `
### MULTI-PARTICIPANT DIALOGUE
This dialogue features ${participants.length} participants engaging directly with each other:
${participantLines}

All participants should:
- Speak from their authentic ${philosopherCount > 0 ? 'historical/philosophical ' : ''}perspectives
- Engage directly with each other's positions
- Challenge each other's views substantively
- Reference their own works and ideas where relevant
- Show genuine intellectual respect while disagreeing
- Address each other directly ("you" not "he/she")
- Contribute substantively — NO participant should be sidelined or reduced to a passive listener${hasEveryman ? '\n- The non-philosopher(s) keep the discussion grounded and accessible' : ''}
`;
      } else {
        configSection = `
### DIALOGUE
${participantLines}
- **STUDENT**: A thoughtful interlocutor who asks probing questions and raises objections

The philosopher speaks from their authentic perspective; the student draws them out with genuine questions and common-sense objections.
`;
      }

      let DIALOGUE_SYSTEM_PROMPT = `# DIALOGUE CREATOR SYSTEM PROMPT

You are the Dialogue Creator for the "Genius 101" app. Your purpose is to create authentic philosophical dialogue between the specified thinkers.

## DIALOGUE CONFIGURATION
${configSection}

## CRITICAL: WHAT YOUR DIALOGUES ARE NOT

You are NOT creating:
- Socratic dialogues (fake "I know nothing" pretense)
- Perry-style straw-man dialogues (weak opponent exists to be demolished)
- Academic Q&A sessions (dry, lifeless exchange of information)
- Generic LLM dialogue (polite, hedging, safe)
- One character lecturing while another nods
- Dialogue where one character is clearly the author's mouthpiece

## WHAT YOUR DIALOGUES ARE

Authentic philosophical conversations characterized by:
- Real intellectual movement and discovery
- Both characters contributing substantively
- Concrete examples grounding abstract concepts
- Natural speech patterns
- Psychological realism
- Building complexity systematically
- Direct engagement (use "you" when addressing each other, never third person)

## DIALOGUE STRUCTURE

### OPENING
Start directly with the topic or disagreement. NO preambles. Just get into it.

### DEVELOPMENT
- Both parties make substantive contributions
- Disagreements are explored, not papered over
- Examples and thought experiments illustrate points
- The dialogue has intellectual movement—ideas develop

### CLOSURE
End with natural exhaustion of the topic, pointing toward further questions, or acknowledgment of remaining disagreement. NO forced lessons or moralizing wrap-ups.

## STYLE REQUIREMENTS

### NATURAL SPEECH
- Use contractions, sentence fragments when natural
- Avoid stiff academic jargon
- No hedging or generic LLM politeness

### DIRECTNESS
Philosophers speak with authority about their positions.
NOT: "Well, one might argue that..." or "It could perhaps be said that..."

### INTELLECTUAL HONESTY
- Acknowledge when questions are difficult
- Point out when distinctions are subtle
- Don't oversimplify for convenience

## OUTPUT FORMAT

Structure your output exactly as:

[CHARACTER NAME]: [Dialogue]

[CHARACTER NAME]: [Dialogue]

Use CAPS for character names (${speakerNames.join(', ')}). Use proper paragraph breaks. No additional formatting.

## QUOTE REQUIREMENT

${targetQuoteCount > 0
  ? `⚠️ MANDATORY: Each thinker MUST include at least ${targetQuoteCount} verbatim quotes from the reference material provided below. A "quote" means a direct, word-for-word excerpt from their writings, clearly attributed (e.g. "As I wrote in [title]..." or integrated naturally into speech). Do NOT paraphrase and call it a quote. If the reference material is thin, use the best passages available and note the source.`
  : `No specific quote count is required. Draw on the reference material organically — thinkers may quote their own works when it feels natural, but are not obligated to.`}

## FINAL INSTRUCTION

Create a philosophically rigorous, psychologically realistic dialogue. The dialogue should feel like overhearing two real minds grappling with real ideas. Aim for approximately ${targetWordLength} words, but completing the planned arc and reaching genuine closure ALWAYS takes priority over hitting an exact count — never stop mid-thought to satisfy a word target.${elevenLabsMode ? `

## ELEVENLABS-READY OUTPUT (THIS OVERRIDES ALL FORMATTING ABOVE)

Output every line of dialogue using EXACTLY this format:

Speaker 1: <text>

Speaker 2: <text>

ABSOLUTE RULES:
- Use ONLY these speaker labels, one per distinct speaker: ${speakerNames.map((_, i) => `"Speaker ${i + 1}"`).join(', ')}. NEVER use character names, "Interviewer", "Host", "Guest", "Person A", or any other label.
- The first speaker to talk is Speaker 1; the second distinct speaker is Speaker 2. Stay consistent for the entire output.
- One turn per line. A single blank line between turns.
- NO stage directions. NO parentheticals like (laughs), (sighs), [pause]. NO asterisks. NO bold. NO italics. NO markdown of any kind.
- NO narration, NO scene descriptions, NO preamble, NO title, NO closing remarks. ONLY the dialogue lines themselves.
- Every non-empty output line MUST match this exact pattern: ^Speaker \\d+: .+$` : ''}`;

      // Build user prompt - use truncated source text for LLM prompt
      let userPrompt = isTopicOnly 
        ? `Topic for dialogue:\n\n${truncatedSourceText}\n\nCreate a philosophical dialogue on this topic.`
        : `Source text to transform into dialogue:\n\n${truncatedSourceText}`;
      
      // Add author-specific content if available
      for (const p of participants) {
        if (p.content) {
          userPrompt += `\n\n${p.content}`;
        }
      }
      
      if (customInstructions && customInstructions.trim()) {
        userPrompt += `\n\nCustom instructions: ${customInstructions}`;
      }

      // Sequel mode: a fresh dialogue on the SAME source text that picks up after
      // a previously generated dialogue (the cast of thinkers may have changed).
      const priorDialogueText = typeof priorDialogue === 'string' ? priorDialogue.trim() : '';
      const hasExistingSeed = typeof existingText === 'string' && existingText.trim().length > 0;
      const isSequelMode = priorDialogueText.length > 0 && !hasExistingSeed;
      if (isSequelMode) {
        // Cap the injected context; the tail holds where the prior dialogue ended.
        const priorExcerpt = priorDialogueText.length > 8000
          ? priorDialogueText.slice(-8000)
          : priorDialogueText;
        userPrompt += `

=== PREVIOUS DIALOGUE (context for a SEQUEL — do NOT repeat any of it) ===
${priorExcerpt}
=== END PREVIOUS DIALOGUE ===

This new dialogue is a SEQUEL. The thinkers are now engaging with the NEW SOURCE TEXT provided at the very top of this prompt — this is a different chapter or passage, NOT the same text as before. The previous dialogue is included ONLY so the speakers don't repeat arguments they already made; it must NOT determine the topic of this dialogue.

RULES:
- The topic, content, and focus of this dialogue must be driven entirely by the NEW SOURCE TEXT at the top of the prompt.
- The previous dialogue is context only — it shows where the intellectual arc left off, so the speakers can continue naturally. Do NOT rehash or repeat any of its arguments.
- Treat the previous conversation as having already happened; participants may reference it briefly and naturally ("We already covered X, so let's push further...").
- Feature ONLY the current cast of speakers defined in the configuration above.
- Do NOT repeat or restate the previous dialogue's exchanges.`;
      }

      // Set up SSE streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Stop generating as soon as the client disconnects (e.g. user hit "Stop"),
      // so we don't keep burning LLM calls for output nobody is listening to.
      let clientGone = false;
      res.on('close', () => { clientGone = true; });

      // Resume mode: seed with the partial dialogue the client already has so we
      // continue from where a stalled/interrupted generation left off.
      const seedText = typeof existingText === 'string' ? existingText : '';
      const isContinueMode = seedText.trim().length > 0;
      let fullResponse = seedText;
      let totalWords = fullResponse.split(/\s+/).filter((w: string) => w.length > 0).length;

      // When continuing, always produce at least one more chunk even if the
      // partial already met the original target.
      const WORDS_PER_CHUNK = 2500;
      const MAX_CHUNKS = 50;
      const generationTarget = isContinueMode && totalWords >= targetWordLength
        ? totalWords + WORDS_PER_CHUNK
        : targetWordLength;

      console.log(`[Dialogue Creator] Target: ${targetWordLength} words${isContinueMode ? ` (CONTINUE from ${totalWords} existing words, generating up to ${generationTarget})` : ''}`);

      // ---- Structural scaffolding (skeleton / arc planning) ----
      // A naive "write more words" loop produces meandering dialogues with no
      // beginning/middle/end. Except for very short dialogues, first plan a
      // single unified arc (central tension, ordered beats, required closure)
      // and make the generator follow it beat-by-beat, with the final segment
      // delivering the planned ending so the dialogue feels complete.
      interface DialogueBeat { title: string; purpose: string; moves: string[]; }
      const SKELETON_MIN_WORDS = 600; // below this = "very very short" — skip scaffold
      const useSkeleton = !isContinueMode && targetWordLength >= SKELETON_MIN_WORDS;
      let skeletonBeats: DialogueBeat[] = [];
      let skeletonThesis = '';
      let skeletonClosure = '';

      if (useSkeleton) {
        const beatCount = Math.min(12, Math.max(4, Math.round(targetWordLength / 450)));
        const planSystem = `You are the architect/dramaturge for a philosophical dialogue. Plan a single UNIFIED work with a real beginning, middle, and end — not a meandering chat.

Return EXACT JSON only, no prose, with this shape:
{
  "thesis": "the central question or tension that drives the whole dialogue (one sentence)",
  "beats": [ { "title": "short beat name", "purpose": "what this beat accomplishes in the arc", "moves": ["specific argumentative move or example", "..."] } ],
  "closure": "how the dialogue ENDS — the resolution, crystallized disagreement, or earned insight that gives genuine closure"
}

REQUIREMENTS:
- Produce EXACTLY ${beatCount} beats in dramatic order: an OPENING that frames the tension, a MIDDLE that develops and complicates it through real disagreement, and a final beat that lands the closure.
- Each beat must ADVANCE the argument — no two beats may cover the same ground.
- The arc must build toward the closure; the dialogue must feel finished, not abandoned.
- Ground everything in the source/topic and the participants' actual views.`;
        const planUser = `PARTICIPANTS: ${speakerNames.join(', ')}
TARGET LENGTH: ~${targetWordLength} words
${customInstructions && customInstructions.trim() ? `EXTRA INSTRUCTIONS: ${customInstructions.trim()}\n` : ''}SOURCE / TOPIC:
${truncatedSourceText.slice(0, 6000)}
${isSequelMode ? `\nThis is a SEQUEL. The arc must be built entirely around the NEW SOURCE TEXT above (a new chapter/passage). The prior dialogue is context only — plan beats that explore the NEW text, not the old one.\nPRIOR DIALOGUE (for context only; do NOT repeat it):\n${priorDialogueText.slice(-3000)}` : ''}

Plan the arc now. Return ONLY the JSON object.`;
        try {
          const rawPlan = await callLLMPlan(planSystem, planUser, 2000, 0.5);
          const jsonMatch = rawPlan.match(/\{[\s\S]*\}/);
          const parsedPlan = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
          if (parsedPlan && Array.isArray(parsedPlan.beats) && parsedPlan.beats.length > 0) {
            skeletonThesis = typeof parsedPlan.thesis === 'string' ? parsedPlan.thesis : '';
            skeletonClosure = typeof parsedPlan.closure === 'string' ? parsedPlan.closure : '';
            skeletonBeats = parsedPlan.beats.map((b: any) => ({
              title: typeof b?.title === 'string' ? b.title : '',
              purpose: typeof b?.purpose === 'string' ? b.purpose : '',
              moves: Array.isArray(b?.moves) ? b.moves.map(String) : [],
            }));
            console.log(`[Dialogue Creator] Skeleton planned: ${skeletonBeats.length} beats`);
            res.write(`data: ${JSON.stringify({ skeleton: { thesis: skeletonThesis, beats: skeletonBeats.map((b) => b.title), closure: skeletonClosure } })}\n\n`);
          }
        } catch (planErr) {
          console.warn('[Dialogue Creator] Skeleton planning failed; proceeding without scaffold:', (planErr as Error).message);
        }
      }

      // Inject the planned arc into the system prompt so every chunk knows the
      // whole structure and where it is headed.
      if (skeletonBeats.length > 0) {
        const beatList = skeletonBeats
          .map((b, i) => `${i + 1}. ${b.title} — ${b.purpose}${b.moves.length ? `\n   moves: ${b.moves.join('; ')}` : ''}`)
          .join('\n');
        DIALOGUE_SYSTEM_PROMPT += `

## STRUCTURAL PLAN — FOLLOW THIS ARC (DO NOT MEANDER)
This dialogue MUST be ONE unified work with a clear beginning, middle, and end.
CENTRAL TENSION / THESIS: ${skeletonThesis || '(frame a clear central tension from the source)'}
ORDERED BEATS:
${beatList}
REQUIRED ENDING: ${skeletonClosure || 'Bring the central tension to a genuine, earned resolution or a crystallized disagreement.'}
RULES:
- Move through the beats IN ORDER; each beat advances the argument and does not restate earlier beats.
- Build steadily toward the ending; the dialogue must feel COMPLETE, never abandoned mid-thought.
- The final beat must deliver the REQUIRED ENDING above — real closure, no "to be continued", no trailing off.`;
      }

      // Chunked generation to reach target word count
      let chunkNumber = 0;
      // Tracks whether a chunk was flagged final and thus instructed to deliver
      // the planned closure. A post-loop guard handles the case where an early
      // chunk over-generates and ends the loop before any final chunk runs.
      let closureDelivered = false;

      while (totalWords < generationTarget && chunkNumber < MAX_CHUNKS) {
        if (clientGone) { console.log('[Dialogue] Client disconnected; stopping generation'); break; }
        chunkNumber++;
        const remainingWords = generationTarget - totalWords;
        const wordsBeforeChunk = totalWords;
        let thisChunkIsFinal = false;
        const chunkTarget = Math.min(WORDS_PER_CHUNK, remainingWords + 100);
        const chunkMaxTokens = Math.ceil(chunkTarget * 1.5) + 500;

        let chunkPrompt = "";
        if (chunkNumber === 1 && !isContinueMode) {
          chunkPrompt = userPrompt;
        } else if (chunkNumber === 1 && isContinueMode) {
          // Resuming a stalled stream: the text may be cut off mid-sentence.
          // Pick up at the EXACT cutoff without repeating any prior words.
          chunkPrompt = `This philosophical dialogue was interrupted mid-stream and may end mid-sentence or mid-word. Resume it by continuing from the EXACT point where the text below stops. Write approximately ${chunkTarget} more words.

CRITICAL RULES:
- Do NOT repeat, restate, or re-write any words, sentences, or speaker turns that already appear below.
- If the last line is an incomplete sentence, simply finish that sentence and continue — do not start the turn over.
- Do NOT add any preamble, recap, or "continuing..." note. Output only the new continuation text.

Here is the dialogue so far (it may stop abruptly):

${fullResponse.slice(-2000)}`;
        } else {
          chunkPrompt = `Continue this philosophical dialogue. Write approximately ${chunkTarget} more words.
Do NOT repeat any exchanges already given. Continue naturally from where we left off:

${fullResponse.slice(-2000)}

Continue the dialogue with NEW exchanges:`;
        }

        // Beat guidance for this segment: keep multi-chunk dialogues on the
        // planned arc and ensure the final segment delivers genuine closure.
        if (skeletonBeats.length > 0) {
          const n = skeletonBeats.length;
          const isFinalChunk = remainingWords <= WORDS_PER_CHUNK;
          thisChunkIsFinal = isFinalChunk;
          const progressBefore = Math.min(1, totalWords / generationTarget);
          const progressAfter = Math.min(1, (totalWords + chunkTarget) / generationTarget);
          let beatLo = Math.min(n - 1, Math.floor(progressBefore * n));
          let beatHi = isFinalChunk ? n - 1 : Math.max(beatLo, Math.ceil(progressAfter * n) - 1);
          beatHi = Math.min(n - 1, Math.max(beatLo, beatHi));
          const segBeats = skeletonBeats.slice(beatLo, beatHi + 1);
          const segList = segBeats
            .map((b) => `• ${b.title}: ${b.purpose}${b.moves.length ? ` [${b.moves.join('; ')}]` : ''}`)
            .join('\n');
          chunkPrompt += `

--- ARC GUIDANCE FOR THIS SEGMENT ---
${chunkNumber === 1 && !isContinueMode ? 'This is the OPENING: frame the central tension immediately and pull the reader straight in.\n' : ''}Cover these beats now, in order:
${segList || '(continue the planned arc)'}
${isFinalChunk
  ? `\nThis is the FINAL segment. Land the planned ending: ${skeletonClosure || 'resolve or crystallize the central tension'}. Deliver genuine closure — do NOT trail off, summarize blandly, or set up a sequel.`
  : `\nAdvance the argument with these beats; do NOT wrap up yet — later beats still remain.`}`;
        }

        // Guarantee a clean paragraph break at chunk seams so a new turn never
        // glues onto the previous chunk's last word (e.g. "...debateJAMES:").
        const hadContentBeforeChunk = fullResponse.length > 0;
        // When resuming a stalled stream the partial may end mid-sentence/mid-word,
        // in which case the continuation should glue on directly (with a single
        // space) rather than forcing a paragraph break that splits the sentence.
        const trimmedTail = fullResponse.replace(/\s+$/, '');
        const endedMidSentence = chunkNumber === 1 && isContinueMode &&
          hadContentBeforeChunk && !/[.!?:;"'\u2019\u201d)\]]$/.test(trimmedTail);
        let isFirstDeltaOfChunk = true;

        for await (let text of streamLLMText(DIALOGUE_SYSTEM_PROMPT, chunkPrompt, Math.min(chunkMaxTokens, 8000), 0.7)) {
            if (isFirstDeltaOfChunk) {
              isFirstDeltaOfChunk = false;
              if (hadContentBeforeChunk) {
                if (endedMidSentence) {
                  // Mid-sentence resume: ensure exactly one space at the join, no line break.
                  text = text.replace(/^\s+/, '');
                  if (!fullResponse.endsWith(' ') && !/^[\s.,!?;:'")\]]/.test(text)) {
                    fullResponse += ' ';
                    res.write(`data: ${JSON.stringify({ content: ' ' })}\n\n`);
                  }
                } else {
                  // Clean boundary: strip leading whitespace, enforce exactly one blank line.
                  text = text.replace(/^\s+/, '');
                  if (!fullResponse.endsWith('\n\n')) {
                    const sep = fullResponse.endsWith('\n') ? '\n' : '\n\n';
                    fullResponse += sep;
                    res.write(`data: ${JSON.stringify({ content: sep })}\n\n`);
                  }
                }
              }
              if (text.length === 0) continue;
            }

            fullResponse += text;
            res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
        }

        totalWords = fullResponse.split(/\s+/).filter((w: string) => w.length > 0).length;
        console.log(`[Dialogue Creator] Chunk ${chunkNumber}: ${totalWords} words total`);
        // Only count closure as delivered once the FINAL chunk actually produced
        // new content (a flagged-but-empty chunk must not suppress the fallback).
        if (thisChunkIsFinal && totalWords > wordsBeforeChunk) {
          closureDelivered = true;
        }
      }

      // Closure guarantee: if a scaffold was planned but no chunk was ever
      // flagged final (e.g. an earlier chunk over-generated and ended the loop),
      // run one short closing segment so the dialogue lands its planned ending
      // instead of stopping mid-arc.
      if (skeletonBeats.length > 0 && !closureDelivered && !clientGone && !res.writableEnded) {
        console.log('[Dialogue Creator] Closure not delivered by loop; generating forced closing segment');
        const wordsBeforeClosure = totalWords;
        // Emit a clean paragraph break for the new closing turn (shared by both
        // the streamed closure and the deterministic fallback below).
        const writeClosureSeam = () => {
          if (fullResponse.length > 0 && !fullResponse.endsWith('\n\n')) {
            const sep = fullResponse.endsWith('\n') ? '\n' : '\n\n';
            fullResponse += sep;
            res.write(`data: ${JSON.stringify({ content: sep })}\n\n`);
          }
        };
        try {
          const lastBeat = skeletonBeats[skeletonBeats.length - 1];
          const closurePrompt = `Bring this philosophical dialogue to its planned close NOW. Continue naturally from where it stops below — do NOT repeat anything already said.

FINAL BEAT: ${lastBeat.title}: ${lastBeat.purpose}${lastBeat.moves.length ? ` [${lastBeat.moves.join('; ')}]` : ''}
REQUIRED ENDING: ${skeletonClosure || 'resolve or crystallize the central tension'}

Write a short closing exchange (roughly 150-300 words) that delivers genuine closure — resolve or crystallize the central tension. Do NOT trail off or set up a sequel. End on a complete sentence.

${elevenLabsMode
  ? 'FORMAT (MANDATORY): Every line must be exactly "Speaker N: <text>" (e.g. "Speaker 1:", "Speaker 2:"). No narration, no stage directions, no markdown, no character names.'
  : `FORMAT (MANDATORY): Label each turn with the speaker's name in CAPS followed by a colon (e.g. "${participants[0]?.shortName || 'SPEAKER'}:"). No narration or stage directions.`}

Dialogue so far (continue from the end):
${fullResponse.slice(-2000)}`;
          let isFirstClosureDelta = true;
          for await (let text of streamLLMText(DIALOGUE_SYSTEM_PROMPT, closurePrompt, 800, 0.7)) {
              if (isFirstClosureDelta) {
                isFirstClosureDelta = false;
                text = text.replace(/^\s+/, '');
                // New closing turn: enforce a clean paragraph break at the seam.
                writeClosureSeam();
                if (text.length === 0) continue;
              }
              fullResponse += text;
              res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
          }
          totalWords = fullResponse.split(/\s+/).filter((w: string) => w.length > 0).length;
        } catch (closureErr) {
          console.error('[Dialogue Creator] Forced-closure stream failed:', (closureErr as Error).message);
        }
        // Deterministic guarantee: if the closure stream threw or produced nothing,
        // append an explicit closing turn derived from the planned closure so a
        // scaffolded dialogue NEVER ends without a closure segment.
        if (totalWords <= wordsBeforeClosure) {
          console.log('[Dialogue Creator] Forced-closure stream yielded no content; appending deterministic closure');
          // Emit a valid, in-character dialogue TURN (not raw narration) so the
          // fallback never violates the dialogue/ElevenLabs speaker-label format.
          // skeletonClosure is a stage-direction-style description of the ending,
          // so it is NOT spoken verbatim — we use a generic in-character line.
          const closerIdx = Math.max(0, participants.length - 1);
          const closerLabel = elevenLabsMode
            ? `Speaker ${closerIdx + 1}`
            : (participants[closerIdx]?.shortName || 'SPEAKER');
          const fallbackLine = 'Then let us end here — not with the tension dissolved, but with each of us seeing more clearly what the other has forced us to confront. That, perhaps, is the only honest conclusion.';
          const fallbackTurn = `${closerLabel}: ${fallbackLine}`;
          writeClosureSeam();
          fullResponse += fallbackTurn;
          res.write(`data: ${JSON.stringify({ content: fallbackTurn })}\n\n`);
          totalWords = fullResponse.split(/\s+/).filter((w: string) => w.length > 0).length;
        }
        closureDelivered = true;
      }

      // If the client disconnected (Stop pressed / navigated away), skip all
      // post-loop completion work — it would burn extra LLM calls and write to
      // a closed response.
      if (clientGone || res.writableEnded) {
        console.log('[Dialogue Creator] Client gone; skipping post-loop completion');
        return;
      }

      // The word-count target can land the model mid-sentence (a chunk hits its
      // token ceiling right at the target). Never end abruptly: if the output
      // does not finish on a sentence boundary (or an intentional dash
      // interruption), generate a short tail that completes the current
      // sentence/turn without starting any new ones.
      const endsCleanly = (t: string) => {
        const s = t.replace(/\s+$/, '');
        // Terminal punctuation, optionally followed by a closing quote/paren.
        if (/[.!?\u2026][)"'\u2019\u201d\u00bb]?$/.test(s)) return true;
        // An intentional interruption (em/en dash or hyphen) is acceptable.
        if (/[\u2014\u2013-]$/.test(s)) return true;
        return false;
      };

      if (fullResponse.trim().length > 0 && !endsCleanly(fullResponse)) {
        console.log(`[Dialogue Creator] Output ended mid-sentence; generating completion tail`);

        // Buffer one completion tail and clean it: keep only enough to finish the
        // current turn (drop anything that starts a new speaker turn).
        const generateTail = async (): Promise<string> => {
          const tailPrompt = `The dialogue below was cut off and is incomplete. Continue from the EXACT character where it stops and write ONLY enough to finish the current speaker's incomplete sentence and bring their turn to a natural close.

STRICT RULES:
- Do NOT start any new speaker turn or add any new speaker label.
- Do NOT repeat, restate, or rephrase any words that already appear.
- If the text stops mid-word, complete that word seamlessly with NO leading space and NO repeated letters.
- If the text stops after a complete word, begin your output with a single leading space.
- Output ONLY the short continuation text, nothing else.

DIALOGUE (it cuts off abruptly):
${fullResponse.slice(-1500)}`;
          let buf = '';
          for await (const text of streamLLMText(DIALOGUE_SYSTEM_PROMPT, tailPrompt, 400, 0.7)) {
            buf += text;
          }
          // Only finish the CURRENT turn: drop anything from a new turn onward.
          const nlIdx = buf.indexOf('\n\n');
          if (nlIdx !== -1) buf = buf.slice(0, nlIdx);
          return buf;
        };

        try {
          // Retry a few times in case the tail itself stops mid-sentence.
          for (let attempt = 0; attempt < 3 && !endsCleanly(fullResponse); attempt++) {
            let tail = await generateTail();
            tail = tail.replace(/^[\r\n]+/, ''); // never inject a paragraph break mid-turn
            // Collapse to avoid a double space at the join.
            if (fullResponse.endsWith(' ')) tail = tail.replace(/^\s+/, '');
            if (!tail.trim()) break;
            fullResponse += tail;
            res.write(`data: ${JSON.stringify({ content: tail })}\n\n`);
          }
        } catch (completionError) {
          console.error('[Dialogue Creator] Completion-tail step failed:', completionError);
        }

        // Last-resort deterministic guarantee: never end abruptly.
        if (!endsCleanly(fullResponse)) {
          const period = '.';
          fullResponse = fullResponse.replace(/\s+$/, '') + period;
          res.write(`data: ${JSON.stringify({ content: period })}\n\n`);
        }

        totalWords = fullResponse.split(/\s+/).filter((w: string) => w.length > 0).length;
      }

      console.log(`[Dialogue Creator] Complete: ${totalWords} words in ${chunkNumber} chunks`);

      // Send final metadata
      res.write(`data: ${JSON.stringify({ 
        done: true,
        wordCount: totalWords
      })}\n\n`);
      
      res.write('data: [DONE]\n\n');
      res.end();

    } catch (error) {
      console.error("[Dialogue Creator] Error:", error);
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : "Failed to generate dialogue"
        });
      } else {
        res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        res.end();
      }
    }
  });

  // ====== INTERVIEW CREATOR ======
  app.post("/api/interview-creator", upload.single('file'), async (req, res) => {
    try {
      const { thinkerId, mode, interviewerTone, wordLength, quoteCount: quoteCountRaw, topic, elevenLabsMode: elevenLabsModeRaw } = req.body;
      const targetQuoteCount = Math.min(Math.max(parseInt(quoteCountRaw) || 0, 0), 20);
      const elevenLabsMode = elevenLabsModeRaw === 'true' || elevenLabsModeRaw === true;
      let sourceText = '';

      // Validate thinker selection
      if (!thinkerId) {
        return res.status(400).json({
          success: false,
          error: "Please select a thinker to interview"
        });
      }

      // Get text from file upload or use topic
      if (req.file) {
        const fileExtension = req.file.originalname.split('.').pop()?.toLowerCase();
        
        if (fileExtension === 'txt' || fileExtension === 'md') {
          sourceText = req.file.buffer.toString('utf-8');
        } else if (fileExtension === 'pdf') {
          const pdfData = await pdfParse(req.file.buffer);
          sourceText = pdfData.text;
        } else if (fileExtension === 'docx' || fileExtension === 'doc') {
          const result = await mammoth.extractRawText({ buffer: req.file.buffer });
          sourceText = result.value;
        } else {
          return res.status(400).json({
            success: false,
            error: "Unsupported file type. Please upload .txt, .pdf, .doc, .docx, or .md"
          });
        }
      }

      // Get thinker details
      const thinker = await storage.getThinker(thinkerId);
      if (!thinker) {
        return res.status(404).json({
          success: false,
          error: "Selected thinker not found"
        });
      }

      const targetWordLength = parseInt(wordLength) || 1500;
      const totalChapters = Math.ceil(targetWordLength / 2000);
      const wordsPerChapter = Math.ceil(targetWordLength / totalChapters);
      
      console.log(`[Interview Creator] Generating ${targetWordLength} word interview with ${thinker.name}`);
      console.log(`[Interview Creator] Split into ${totalChapters} chapter(s), ~${wordsPerChapter} words each`);
      console.log(`[Interview Creator] Mode: ${mode}, Tone: ${interviewerTone}`);

      // Retrieve relevant content from the thinker's works
      const normalizedThinkerName = normalizeAuthorName(thinker.name);
      let thinkerContent = '';
      
      try {
        // Truncate source text for vector search (max 500 chars to fit embedding model)
        const searchQueryText = (sourceText || topic || thinker.name).slice(0, 500);
        const relevantChunks = await searchPhilosophicalChunks(
          searchQueryText,
          8,
          "common",
          normalizedThinkerName
        );
        
        if (relevantChunks.length > 0) {
          thinkerContent = `\n\n╔══════════════════════════════════════════════════════════════════╗
║  MANDATORY SOURCE MATERIAL - ${thinker.name.toUpperCase()}'S ACTUAL POSITIONS  ║
╚══════════════════════════════════════════════════════════════════╝

These passages contain ${thinker.name}'s ACTUAL documented positions. You MUST ground all of ${thinker.name}'s interview responses in this material. Do NOT invent positions.\n\n`;
          relevantChunks.forEach((chunk, index) => {
            thinkerContent += `━━━ SOURCE ${index + 1}: "${chunk.paperTitle}" ━━━\n${chunk.content}\n\n`;
          });
          thinkerContent += `╔══════════════════════════════════════════════════════════════════╗
║  END SOURCE MATERIAL - USE ONLY THESE POSITIONS IN RESPONSES    ║
╚══════════════════════════════════════════════════════════════════╝\n`;
          console.log(`[Interview Creator] Retrieved ${relevantChunks.length} relevant passages`);
        }
      } catch (error) {
        console.error(`[Interview Creator] Error retrieving content:`, error);
      }

      // Build interviewer tone description
      const toneDescriptions: Record<string, string> = {
        neutral: `NEUTRAL INTERVIEWER: You are a well-disposed, objective interviewer. You listen attentively, ask for clarification when needed, and help the interviewee relate their views to broader topics. You're supportive but never sycophantic. You don't share your own opinions but focus on drawing out the interviewee's positions.`,
        dialectical: `DIALECTICALLY ENGAGED INTERVIEWER: You are an active intellectual participant, not just a questioner. You volunteer your own views, sometimes agree enthusiastically, sometimes disagree respectfully. You have a cooperative mentality but engage as an almost equal intellectual partner. You push back when you find arguments unconvincing but remain genuinely curious.`,
        hostile: `HOSTILE INTERVIEWER: You are attempting to challenge and critique the interviewee's positions through rigorous logic and legitimate argumentation. You look for weaknesses, inconsistencies, and gaps. You're not rude or personal, but you're intellectually relentless. Every claim must withstand scrutiny.`
      };

      // Build mode description
      const modeDescriptions: Record<string, string> = {
        conservative: `CONSERVATIVE MODE: Stay strictly faithful to ${thinker.name}'s documented views and stated positions. Quote and reference their actual works. Don't speculate about views they never expressed. When uncertain, acknowledge the limits of their written record.`,
        aggressive: `AGGRESSIVE MODE: You may reconstruct and extend ${thinker.name}'s views beyond their explicit statements. Apply their intellectual framework to contemporary issues they never addressed. Integrate insights from later scholarship and related thinkers. The goal is an intellectually alive reconstruction, not a museum exhibit.`
      };

      // If no RAG content retrieved, log warning but continue with general knowledge
      if (!thinkerContent || thinkerContent.trim() === '') {
        console.log(`[Interview Creator] No RAG content found for ${thinker.name}, proceeding with general profile`);
        thinkerContent = `\n\nNote: Using ${thinker.name}'s general profile and historical knowledge. For more authentic responses, upload source material from their actual works.\n`;
      }

      let INTERVIEW_SYSTEM_PROMPT = `# INTERVIEW CREATOR SYSTEM PROMPT

You are generating an in-depth interview with ${thinker.name}. 

## MANDATORY GROUNDING REQUIREMENT - READ THIS FIRST

YOU MUST DERIVE EVERY CLAIM, POSITION, AND ARGUMENT FROM THE RETRIEVED PASSAGES PROVIDED BELOW.

THIS IS NON-NEGOTIABLE:
- Do NOT invent philosophical positions
- Do NOT guess what ${thinker.name} might think
- Do NOT attribute views to ${thinker.name} that are not explicitly supported by the retrieved passages
- If the passages don't support a particular claim, ${thinker.name} should say "I haven't written on that specifically" or redirect to what they HAVE written

CITATION REQUIREMENT:
- ${thinker.name}'s responses MUST incorporate verbatim phrases and concepts from the retrieved passages
- When making a claim, ${thinker.name} should naturally reference their own works: "As I wrote in [title]..." or "My analysis of [concept] shows..."
- Every substantive philosophical claim must be traceable to the provided source material

FORBIDDEN:
- Inventing positions ${thinker.name} never held
- Attributing common philosophical positions to ${thinker.name} without passage support
- Making up arguments that sound plausible but aren't in the sources
- Guessing ${thinker.name}'s views on topics not covered in the passages

## INTERVIEW MODE
${modeDescriptions[mode] || modeDescriptions.conservative}

## INTERVIEWER TONE
${toneDescriptions[interviewerTone] || toneDescriptions.neutral}

## CHARACTER: ${thinker.name.toUpperCase()}
${thinker.title ? `Title/Era: ${thinker.title}` : ''}
${thinker.description ? `Background: ${thinker.description}` : ''}

The interviewee speaks as ${thinker.name} in first person. They deploy their distinctive analytical machinery from the retrieved passages. They reference their actual works and use their characteristic terminology AS FOUND IN THE PASSAGES.

## CRITICAL RULES

1. NO PLEASANTRIES: Start immediately with a substantive question. No greetings whatsoever.

2. PASSAGE-GROUNDED VOICE: ${thinker.name} must speak using concepts, terminology, and arguments FROM THE PROVIDED PASSAGES. Do not paraphrase generic philosophy - use THEIR specific formulations.

3. INTELLECTUAL HONESTY: If asked about something not covered in the passages, ${thinker.name} should redirect: "That's not a topic I've addressed directly. What I have analyzed is..." and pivot to actual passage content.

## OUTPUT FORMAT

INTERVIEWER: [Question or challenge - NO GREETINGS]

${thinker.name.toUpperCase()}: [Response grounded in passage content, using their actual terminology and arguments]

INTERVIEWER: [Follow-up or new direction]

${thinker.name.toUpperCase()}: [Response with explicit reference to their works/concepts from passages]

Continue this pattern. Use CAPS for speaker names. No markdown formatting. Plain text only.

## LENGTH TARGET
Generate approximately ${wordsPerChapter} words for this ${totalChapters > 1 ? 'chapter' : 'interview'}. This is CRITICAL - do not cut short.
${totalChapters > 1 ? `This is chapter content - make it self-contained with a natural ending point. Each chapter MUST be approximately ${wordsPerChapter} words.` : ''}

## QUOTE REQUIREMENT

${targetQuoteCount > 0
  ? `⚠️ MANDATORY: ${thinker.name} MUST include at least ${targetQuoteCount} verbatim quotes from the source passages provided above. A "quote" means a direct, word-for-word excerpt, woven naturally into speech (e.g. "As I wrote in [title], '...'"). Do NOT paraphrase and call it a quote. Use the best available passages even if the material is limited.`
  : `No specific quote count is required. ${thinker.name} may quote from their works when it feels natural, but is not obligated to.`}

## QUALITY REQUIREMENTS
- Every ${thinker.name} response must be traceable to the retrieved passages
- Use verbatim phrases from the sources naturally integrated into responses
- Reference specific works/papers by title when possible
- Maintain intellectual tension while staying grounded in actual positions
- The interview explores what's IN the passages, not what you imagine ${thinker.name} might think${elevenLabsMode ? `

## ELEVENLABS-READY OUTPUT (THIS OVERRIDES ALL FORMATTING ABOVE)

Output every line using EXACTLY this format:

Speaker 1: <interviewer text>

Speaker 2: <interviewee text>

ABSOLUTE RULES:
- Use the literal labels "Speaker 1" (interviewer) and "Speaker 2" (${thinker.name}). NEVER use "INTERVIEWER", "${thinker.name.toUpperCase()}", character names, "Host", "Guest", or any other label.
- One turn per line. A single blank line between turns.
- NO stage directions. NO parentheticals like (laughs), (pauses), [thinks]. NO asterisks. NO bold. NO italics. NO markdown of any kind.
- NO narration, NO scene descriptions, NO preamble, NO chapter headers, NO title, NO closing remarks. ONLY the dialogue lines themselves.
- Every non-empty output line MUST match this exact pattern: ^Speaker \\d+: .+$` : ''}`;

      // Set up SSE streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Stop generating as soon as the client disconnects (e.g. user hit "Stop").
      let clientGone = false;
      res.on('close', () => { clientGone = true; });

      // ---- Structural scaffolding (skeleton / arc planning) ----
      // Mirror the Dialogue/Debate creators: plan one unified interview arc
      // (central thread, ordered beats, closing reflection) so the interview has
      // a real beginning/middle/end and lands genuine closure — except for very
      // short interviews. The arc is injected into INTERVIEW_SYSTEM_PROMPT (used
      // by the chapter + continuation generations) and a shared closure helper
      // guarantees the ending across ALL exit paths, including the coherence one.
      interface InterviewBeat { title: string; purpose: string; moves: string[]; }
      const INTERVIEW_SKELETON_MIN_WORDS = 600;
      let interviewSkeletonBeats: InterviewBeat[] = [];
      let interviewSkeletonThesis = '';
      let interviewSkeletonClosure = '';

      if (anthropic && targetWordLength >= INTERVIEW_SKELETON_MIN_WORDS) {
        const beatCount = Math.min(12, Math.max(4, Math.round(targetWordLength / 450)));
        const planTopic = sourceText ? sourceText.slice(0, 6000) : (topic ? topic : `${thinker.name}'s philosophy`);
        const planSystem = `You are the architect for an in-depth INTERVIEW with ${thinker.name}. Plan a single UNIFIED interview with a real beginning, middle, and end — not a meandering Q&A.

Return EXACT JSON only, no prose, with this shape:
{
  "thesis": "the central thread the whole interview explores (one sentence)",
  "beats": [ { "title": "short beat name", "purpose": "what this stretch of the interview accomplishes", "moves": ["specific question or theme to pursue", "..."] } ],
  "closure": "how the interview ENDS — the closing reflection or synthesis that gives genuine closure"
}

REQUIREMENTS:
- Produce EXACTLY ${beatCount} beats in order: an OPENING that establishes the thread, a MIDDLE that deepens and complicates it, and a final beat that lands a closing reflection.
- Each beat must ADVANCE the conversation — no two beats may cover the same ground.
- Ground everything in ${thinker.name}'s actual views and the topic.`;
        const planUser = `INTERVIEWEE: ${thinker.name}
TARGET LENGTH: ~${targetWordLength} words
TOPIC / SOURCE:
${planTopic}

Plan the arc now. Return ONLY the JSON object.`;
        try {
          const rawPlan = await callLLMPlan(planSystem, planUser, 2000, 0.5);
          const jsonMatch = rawPlan.match(/\{[\s\S]*\}/);
          const parsedPlan = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
          if (parsedPlan && Array.isArray(parsedPlan.beats) && parsedPlan.beats.length > 0) {
            interviewSkeletonThesis = typeof parsedPlan.thesis === 'string' ? parsedPlan.thesis : '';
            interviewSkeletonClosure = typeof parsedPlan.closure === 'string' ? parsedPlan.closure : '';
            interviewSkeletonBeats = parsedPlan.beats.map((b: any) => ({
              title: typeof b?.title === 'string' ? b.title : '',
              purpose: typeof b?.purpose === 'string' ? b.purpose : '',
              moves: Array.isArray(b?.moves) ? b.moves.map(String) : [],
            }));
            console.log(`[Interview Creator] Skeleton planned: ${interviewSkeletonBeats.length} beats`);
            res.write(`data: ${JSON.stringify({ skeleton: { thesis: interviewSkeletonThesis, beats: interviewSkeletonBeats.map((b) => b.title), closure: interviewSkeletonClosure } })}\n\n`);
          }
        } catch (planErr) {
          console.warn('[Interview Creator] Skeleton planning failed; proceeding without scaffold:', (planErr as Error).message);
        }
      }

      if (interviewSkeletonBeats.length > 0) {
        const beatList = interviewSkeletonBeats
          .map((b, i) => `${i + 1}. ${b.title} — ${b.purpose}${b.moves.length ? `\n   moves: ${b.moves.join('; ')}` : ''}`)
          .join('\n');
        INTERVIEW_SYSTEM_PROMPT += `

## STRUCTURAL PLAN — FOLLOW THIS ARC (DO NOT MEANDER)
This interview MUST be ONE unified work with a clear beginning, middle, and end.
CENTRAL THREAD / THESIS: ${interviewSkeletonThesis || '(frame a clear central thread from the topic)'}
ORDERED BEATS:
${beatList}
REQUIRED ENDING: ${interviewSkeletonClosure || 'End with a closing reflection that synthesizes the interview.'}
RULES:
- Move through the beats IN ORDER; each beat advances the conversation and does not restate earlier beats.
- Build steadily toward the ending; the interview must feel COMPLETE, never abandoned mid-thought.
- The final stretch must deliver the REQUIRED ENDING above — real closure, no "to be continued".`;
      }

      // Shared closure guarantee: append a planned closing reflection (forced
      // stream, with a deterministic labeled fallback) to whatever text a path
      // produced. Returns the appended text so the caller can update its counts.
      // No-op when no scaffold was planned. Used before EVERY terminal exit.
      const deliverInterviewClosure = async (currentText: string): Promise<string> => {
        if (interviewSkeletonBeats.length === 0 || res.writableEnded || clientGone) return '';
        console.log('[Interview Creator] Delivering planned closure');
        let appended = '';
        const writeSeam = () => {
          const base = currentText + appended;
          if (base.length > 0 && !base.endsWith('\n\n')) {
            const sep = base.endsWith('\n') ? '\n' : '\n\n';
            appended += sep;
            res.write(`data: ${JSON.stringify({ content: sep })}\n\n`);
          }
        };
        try {
          const lastBeat = interviewSkeletonBeats[interviewSkeletonBeats.length - 1];
          const closurePrompt = `Bring this interview to its planned close NOW. Continue naturally from where it stops below — do NOT repeat anything already said.

FINAL BEAT: ${lastBeat.title}: ${lastBeat.purpose}${lastBeat.moves.length ? ` [${lastBeat.moves.join('; ')}]` : ''}
REQUIRED ENDING: ${interviewSkeletonClosure || 'a closing reflection that synthesizes the interview'}

Write a short closing exchange (roughly 150-300 words) that delivers genuine closure — a final reflection or synthesis. Do NOT trail off or set up a sequel. End on a complete sentence.

${elevenLabsMode
  ? 'FORMAT (MANDATORY): Every line must be exactly "Speaker N: <text>" (e.g. "Speaker 1:", "Speaker 2:"). No narration, no stage directions, no markdown, no character names.'
  : `FORMAT (MANDATORY): Label each turn in CAPS followed by a colon ("INTERVIEWER:" and "${thinker.name.toUpperCase()}:"). No narration or stage directions.`}

Interview so far (continue from the end):
${currentText.slice(-2000)}`;
          let isFirstClosureDelta = true;
          for await (let text of streamLLMText(INTERVIEW_SYSTEM_PROMPT, closurePrompt, 800, 0.7)) {
              if (isFirstClosureDelta) {
                isFirstClosureDelta = false;
                text = text.replace(/^\s+/, '');
                writeSeam();
                if (text.length === 0) continue;
              }
              appended += text;
              res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
          }
        } catch (closureErr) {
          console.error('[Interview Creator] Forced-closure stream failed:', (closureErr as Error).message);
        }
        // Deterministic guarantee: if the stream threw or produced no real text,
        // append an explicit, correctly-labeled closing turn.
        if (appended.replace(/\s/g, '').length === 0) {
          console.log('[Interview Creator] Forced-closure stream yielded no content; appending deterministic closure');
          const closerLabel = elevenLabsMode ? 'Speaker 2' : thinker.name.toUpperCase();
          const fallbackLine = 'In the end, what I hope endures from this conversation is not a set of conclusions but a way of seeing — the questions, once properly framed, already contain the beginning of their answers.';
          writeSeam();
          const fallbackTurn = `${closerLabel}: ${fallbackLine}`;
          appended += fallbackTurn;
          res.write(`data: ${JSON.stringify({ content: fallbackTurn })}\n\n`);
        }
        return appended;
      };

      // 🚀 COHERENCE SERVICE: For interviews >1000 words, use the coherence system
      // (skipped when elevenLabsMode is on so the strict speaker-label directive is honored)
      const INTERVIEW_COHERENCE_THRESHOLD = 1000;
      if (targetWordLength > INTERVIEW_COHERENCE_THRESHOLD && !elevenLabsMode) {
        console.log(`[Interview Creator COHERENCE] Activating for ${targetWordLength} word interview`);
        
        try {
          const coherenceMaterial = {
            quotes: [],
            positions: [],
            arguments: [],
            chunks: thinkerContent ? [thinkerContent] : [],
            deductions: ""
          };
          
          res.write(`data: ${JSON.stringify({ coherenceEvent: { type: "status", data: "Starting coherence service for long interview..." } })}\n\n`);
          
          let interviewResponse = "";
          const interviewPrompt = sourceText 
            ? `Generate an in-depth interview about: ${sourceText.slice(0, 2000)}`
            : `Generate an in-depth interview about: ${topic || thinker.name}'s philosophy`;
          
          for await (const event of philosopherCoherenceService.generateLongResponse(
            thinker.name,
            interviewPrompt,
            targetWordLength,
            coherenceMaterial,
            'interview', // Mode: structured Q&A interview
            { thinker: thinker.name, interviewerTone: interviewerTone || 'neutral', mode: mode || 'conservative' }
          )) {
            res.write(`data: ${JSON.stringify({ coherenceEvent: event })}\n\n`);
            
            if (event.type === "complete" && event.data?.output) {
              interviewResponse = event.data.output;
              // Stream the final content to the client
              res.write(`data: ${JSON.stringify({ content: interviewResponse })}\n\n`);
            }
            
            if (event.type === "error") {
              console.error(`[Interview Creator COHERENCE] Error:`, event.data);
              break;
            }
          }
          
          if (interviewResponse.length > 0) {
            const coherenceWordCount = interviewResponse.split(/\s+/).length;
            console.log(`[Interview Creator COHERENCE] Initial: ${coherenceWordCount} words`);
            
            // If coherence reached target, we're done. The coherence engine
            // already produces a structured, closed result, so forcing an extra
            // closing exchange here would read as a second ending — trust it.
            if (coherenceWordCount >= targetWordLength * 0.9) {
              res.write(`data: ${JSON.stringify({ wordCount: coherenceWordCount })}\n\n`);
              res.write(`data: ${JSON.stringify({ done: true, wordCount: coherenceWordCount })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            
            // Otherwise, continue with chunked generation
            console.log(`[Interview Creator] Coherence output ${coherenceWordCount}/${targetWordLength}, continuing with chunked generation`);
            let fullResponse = interviewResponse;
            let continuationAttempts = 0;
            const MAX_CONTINUATION_ATTEMPTS = 25;
            
            while (fullResponse.split(/\s+/).length < targetWordLength && continuationAttempts < MAX_CONTINUATION_ATTEMPTS) {
              if (clientGone) { console.log('[Interview] Client disconnected; stopping generation'); break; }
              continuationAttempts++;
              const currentWords = fullResponse.split(/\s+/).length;
              const remainingWords = targetWordLength - currentWords;
              const chunkTarget = Math.min(2000, remainingWords + 100);
              
              console.log(`[Interview Creator] Continuation ${continuationAttempts}: ${currentWords}/${targetWordLength} words`);
              
              const continuationPrompt = `Continue this interview. Write approximately ${chunkTarget} more words.
Do NOT repeat any questions or answers already given.
Continue from where we left off:

${fullResponse.slice(-2000)}

Continue the interview with NEW questions and responses:`;

              const stream = await anthropic!.messages.create({
                model: "claude-sonnet-4-5-20250929",
                max_tokens: Math.min(Math.ceil(chunkTarget * 1.5) + 500, 8000),
                temperature: 0.7,
                stream: true,
                system: INTERVIEW_SYSTEM_PROMPT,
                messages: [{ role: "user", content: continuationPrompt }]
              });

              for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                  fullResponse += event.delta.text;
                  res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
                }
              }
            }
            
            if (clientGone || res.writableEnded) {
              console.log('[Interview Creator] Client gone; skipping post-loop closure');
              return;
            }
            fullResponse += await deliverInterviewClosure(fullResponse);
            const finalWordCount = fullResponse.split(/\s+/).length;
            console.log(`[Interview Creator] Complete: ${finalWordCount} words`);
            res.write(`data: ${JSON.stringify({ wordCount: finalWordCount })}\n\n`);
            res.write(`data: ${JSON.stringify({ done: true, wordCount: finalWordCount })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
        } catch (coherenceError) {
          console.error(`[Interview Creator COHERENCE] Failed, falling back to chapter system:`, coherenceError);
        }
      }

      let fullResponse = '';
      let currentChapter = 1;

      // Generate chapters if needed
      for (let chapter = 1; chapter <= totalChapters; chapter++) {
        if (clientGone) { console.log('[Interview] Client disconnected; stopping generation'); break; }
        currentChapter = chapter;
        
        // Send chapter notification
        res.write(`data: ${JSON.stringify({ chapter, totalChapters })}\n\n`);

        // Build the user prompt for this chapter
        let userPrompt = '';
        
        if (sourceText) {
          // Truncate source text for LLM prompt (max 15k chars)
          const truncatedSource = sourceText.length > 15000 
            ? sourceText.slice(0, 15000) + "\n\n[Document truncated - showing first 15k characters]"
            : sourceText;
          userPrompt = `Generate an interview about this text:\n\n${truncatedSource}\n\n`;
        } else if (topic) {
          userPrompt = `Topic for the interview: ${topic}\n\n`;
        }

        if (thinkerContent) {
          userPrompt += thinkerContent;
        }

        if (chapter > 1) {
          userPrompt += `\n\nThis is Chapter ${chapter} of ${totalChapters}. Continue the interview from where the previous chapter ended. Here's how the previous chapter ended:\n\n${fullResponse.slice(-1500)}\n\nContinue naturally from this point with new questions and topics.`;
        } else if (totalChapters > 1) {
          userPrompt += `\n\nThis is Chapter 1 of ${totalChapters}. Start with foundational concepts and build toward more complex ideas in later chapters.`;
        }

        // Calculate dynamic max_tokens based on words per chapter
        const chapterMaxTokens = Math.min(Math.ceil(wordsPerChapter * 1.5) + 1000, 8000);
        
        // Stream this chapter
        const stream = await anthropic!.messages.create({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: chapterMaxTokens,
          temperature: 0.7,
          stream: true,
          system: INTERVIEW_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }]
        });

        let chapterText = '';
        
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const text = event.delta.text;
            chapterText += text;
            fullResponse += text;
            
            res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
          }
        }

        const currentWordCount = fullResponse.split(/\s+/).length;
        console.log(`[Interview Creator] Chapter ${chapter}/${totalChapters} complete, ${currentWordCount} words total`);

        // Send word count update
        res.write(`data: ${JSON.stringify({ wordCount: currentWordCount })}\n\n`);

        // If more chapters to go, add chapter break with brief pause
        if (chapter < totalChapters) {
          const chapterBreak = `\n\n--- END OF CHAPTER ${chapter} ---\n\n`;
          fullResponse += chapterBreak;
          res.write(`data: ${JSON.stringify({ content: chapterBreak })}\n\n`);
          
          // Brief pause between chapters (2 seconds instead of 60)
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // CONTINUATION LOOP: Keep generating until target reached
      let continuationAttempts = 0;
      const MAX_CONTINUATION_ATTEMPTS = 25;
      
      while (fullResponse.split(/\s+/).length < targetWordLength && continuationAttempts < MAX_CONTINUATION_ATTEMPTS) {
        if (clientGone) { console.log('[Interview] Client disconnected; stopping generation'); break; }
        continuationAttempts++;
        const currentWords = fullResponse.split(/\s+/).length;
        const remainingWords = targetWordLength - currentWords;
        const chunkTarget = Math.min(2000, remainingWords + 100);
        
        console.log(`[Interview Creator] Continuation ${continuationAttempts}: ${currentWords}/${targetWordLength} words, need ${remainingWords} more`);
        
        const continuationPrompt = `Continue this interview. Write approximately ${chunkTarget} more words.
Do NOT repeat any questions or answers already given.
Continue from where we left off:

${fullResponse.slice(-2000)}

Continue the interview with NEW questions and responses.${elevenLabsMode ? ' Maintain the Speaker 1 / Speaker 2 format strictly. No stage directions, no markdown, no narration.' : ''}`;

        const stream = await anthropic!.messages.create({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: Math.min(Math.ceil(chunkTarget * 1.5) + 500, 8000),
          temperature: 0.7,
          stream: true,
          system: INTERVIEW_SYSTEM_PROMPT,
          messages: [{ role: "user", content: continuationPrompt }]
        });

        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            fullResponse += event.delta.text;
            res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
          }
        }
        
        res.write(`data: ${JSON.stringify({ wordCount: fullResponse.split(/\s+/).length })}\n\n`);
      }

      if (clientGone || res.writableEnded) {
        console.log('[Interview Creator] Client gone; skipping post-loop closure');
        return;
      }
      fullResponse += await deliverInterviewClosure(fullResponse);
      const finalWordCount = fullResponse.split(/\s+/).length;
      console.log(`[Interview Creator] Complete: ${finalWordCount} words, ${totalChapters} chapter(s)`);

      res.write(`data: ${JSON.stringify({ 
        done: true,
        wordCount: finalWordCount,
        chapters: totalChapters
      })}\n\n`);
      
      res.write('data: [DONE]\n\n');
      res.end();

    } catch (error) {
      console.error("[Interview Creator] Error:", error);
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : "Failed to generate interview"
        });
      } else {
        res.write(`data: ${JSON.stringify({ error: "Generation failed" })}\n\n`);
        res.end();
      }
    }
  });

  // ====== PLATO SQLite DATABASE API ======
  
  // Import Plato database functions
  const { searchPlatoPositions, getAllDialogues, getAllSpeakers } = await import('./plato-db.js');
  
  // Get all available dialogues
  app.get("/api/plato/dialogues", (_req, res) => {
    try {
      const dialogues = getAllDialogues();
      res.json({ success: true, dialogues });
    } catch (error) {
      console.error("[Plato API] Error fetching dialogues:", error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : "Failed to fetch dialogues" 
      });
    }
  });
  
  // Get all available speakers
  app.get("/api/plato/speakers", (_req, res) => {
    try {
      const speakers = getAllSpeakers();
      res.json({ success: true, speakers });
    } catch (error) {
      console.error("[Plato API] Error fetching speakers:", error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : "Failed to fetch speakers" 
      });
    }
  });
  
  // Search Plato positions
  app.post("/api/plato/search", async (req, res) => {
    try {
      const { dialogue, speaker, keyword, searchText, limit } = req.body;
      
      // Input validation to prevent abuse
      if (limit && (typeof limit !== 'number' || limit < 1 || limit > 100)) {
        return res.status(400).json({
          success: false,
          error: 'Limit must be a number between 1 and 100'
        });
      }
      
      // Validate string inputs (max length to prevent abuse)
      const maxStringLength = 500;
      if (dialogue && (typeof dialogue !== 'string' || dialogue.length > maxStringLength)) {
        return res.status(400).json({ success: false, error: 'Invalid dialogue parameter' });
      }
      if (speaker && (typeof speaker !== 'string' || speaker.length > maxStringLength)) {
        return res.status(400).json({ success: false, error: 'Invalid speaker parameter' });
      }
      if (keyword && (typeof keyword !== 'string' || keyword.length > maxStringLength)) {
        return res.status(400).json({ success: false, error: 'Invalid keyword parameter' });
      }
      if (searchText && (typeof searchText !== 'string' || searchText.length > maxStringLength)) {
        return res.status(400).json({ success: false, error: 'Invalid searchText parameter' });
      }
      
      const results = searchPlatoPositions({
        dialogue,
        speaker,
        keyword,
        searchText,
        limit: limit || 50
      });
      
      console.log(`[Plato API] Search returned ${results.length} results`);
      
      res.json({ 
        success: true, 
        count: results.length,
        positions: results
      });
    } catch (error) {
      console.error("[Plato API] Error searching positions:", error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : "Failed to search positions" 
      });
    }
  });

  // Nietzsche SQLite Database API endpoints
  const { getAllWorks, getAllYears, searchNietzschePositions, getDatabaseStats: getNietzscheStats } = await import('./nietzsche-db');

  // Get all works
  app.get("/api/nietzsche/works", async (req, res) => {
    try {
      const works = getAllWorks();
      console.log(`[Nietzsche API] Retrieved ${works.length} works`);
      res.json({ success: true, works });
    } catch (error) {
      console.error("[Nietzsche API] Error fetching works:", error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : "Failed to fetch works" 
      });
    }
  });

  // Get all years
  app.get("/api/nietzsche/years", async (req, res) => {
    try {
      const years = getAllYears();
      console.log(`[Nietzsche API] Retrieved ${years.length} years`);
      res.json({ success: true, years });
    } catch (error) {
      console.error("[Nietzsche API] Error fetching years:", error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : "Failed to fetch years" 
      });
    }
  });

  // Get database stats
  app.get("/api/nietzsche/stats", async (req, res) => {
    try {
      const stats = getNietzscheStats();
      console.log(`[Nietzsche API] Database stats: ${stats.totalPositions} positions`);
      res.json({ success: true, stats });
    } catch (error) {
      console.error("[Nietzsche API] Error fetching stats:", error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : "Failed to fetch stats" 
      });
    }
  });

  // Search Nietzsche positions
  app.post("/api/nietzsche/search", async (req, res) => {
    try {
      const { work, year, keyword, searchText, limit } = req.body;
      
      // Input validation
      if (limit && (typeof limit !== 'number' || limit < 1 || limit > 100)) {
        return res.status(400).json({
          success: false,
          error: 'Limit must be a number between 1 and 100'
        });
      }
      
      const maxStringLength = 500;
      if (work && (typeof work !== 'string' || work.length > maxStringLength)) {
        return res.status(400).json({ success: false, error: 'Invalid work parameter' });
      }
      if (year && (typeof year !== 'number' || year < 1800 || year > 1900)) {
        return res.status(400).json({ success: false, error: 'Invalid year parameter' });
      }
      if (keyword && (typeof keyword !== 'string' || keyword.length > maxStringLength)) {
        return res.status(400).json({ success: false, error: 'Invalid keyword parameter' });
      }
      if (searchText && (typeof searchText !== 'string' || searchText.length > maxStringLength)) {
        return res.status(400).json({ success: false, error: 'Invalid searchText parameter' });
      }
      
      const results = searchNietzschePositions({
        work,
        year,
        keyword,
        searchText,
        limit: limit || 50
      });
      
      console.log(`[Nietzsche API] Search returned ${results.length} results`);
      
      res.json({ 
        success: true, 
        count: results.length,
        positions: results
      });
    } catch (error) {
      console.error("[Nietzsche API] Error searching positions:", error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : "Failed to search positions" 
      });
    }
  });

  // Debate Creator endpoint
  app.post("/api/debate/generate", async (req, res) => {
    try {
      const { thinker1Id, thinker2Id, mode, instructions, paperText, enhanced, wordLength, elevenLabsMode: elevenLabsModeRaw } = req.body;
      const elevenLabsMode = elevenLabsModeRaw === true || elevenLabsModeRaw === 'true';

      if (!thinker1Id || !thinker2Id) {
        return res.status(400).json({ error: "Both thinkers must be selected" });
      }

      const thinker1 = await storage.getThinker(thinker1Id);
      const thinker2 = await storage.getThinker(thinker2Id);

      if (!thinker1 || !thinker2) {
        return res.status(404).json({ error: "One or both thinkers not found" });
      }

      // Parse target word length
      const targetWordLength = Math.min(Math.max(parseInt(wordLength) || 2500, 100), 50000);
      console.log(`[Debate] Target word length: ${targetWordLength} words`);

      // Build the debate prompt
      let debatePrompt = "";

      // Calculate number of exchanges based on word length
      const exchangeRounds = Math.max(3, Math.min(30, Math.ceil(targetWordLength / 400)));
      const wordsPerTurn = Math.ceil(targetWordLength / (exchangeRounds * 2));

      if (mode === "auto") {
        // Auto mode: Find their most violent disagreement OR debate provided document
        const hasDocument = paperText && paperText.trim().length > 50;
        
        // Truncate very long documents to prevent token overflow (max ~15k chars = ~4k tokens)
        const maxDocLength = 15000;
        const truncatedPaperText = hasDocument && paperText.length > maxDocLength 
          ? paperText.slice(0, maxDocLength) + "\n\n[Document truncated for processing - showing first " + Math.round(maxDocLength/1000) + "k characters]"
          : paperText;
        
        debatePrompt = `You are orchestrating a philosophical debate between ${thinker1.name} and ${thinker2.name}.

CRITICAL RULE: The thinkers must DIRECTLY ADDRESS EACH OTHER using "you" - NOT speak about each other in third person.

WRONG: "Hume fails to understand that..."
RIGHT: "You fail to understand, Hume, that..."

WRONG: "Kuczynski's position leads to..."  
RIGHT: "Your position leads to catastrophe because..."

${hasDocument ? `
======
MANDATORY: THE FOLLOWING DOCUMENT IS THE SOLE FOCUS OF THIS DEBATE
======

THE UPLOADED DOCUMENT:
"""
${truncatedPaperText}
"""

======
CRITICAL INSTRUCTIONS:
1. THIS DOCUMENT IS THE ENTIRE SUBJECT OF THE DEBATE
2. Both thinkers MUST engage DIRECTLY with the specific claims, arguments, and ideas in this document
3. Quote specific phrases from the document when responding
4. DO NOT debate generic philosophical topics - debate THIS DOCUMENT specifically
5. Every exchange must reference and analyze the document's content
======

OBJECTIVE: ${thinker1.name} and ${thinker2.name} must debate the claims and ideas in the uploaded document above. They should analyze it, critique it, defend or attack its arguments, and reference its specific content throughout.
` : `
OBJECTIVE: Identify where these two thinkers most violently disagree and create an intense back-and-forth debate.
`}

FORMAT:
- Brief opening from each (1-2 paragraphs)
- ${exchangeRounds} rounds of DIRECT exchange where they attack each other's positions face-to-face
- Each turn: approximately ${wordsPerTurn} words. ${targetWordLength > 3000 ? 'Develop arguments fully with substance and examples.' : 'Keep it punchy and confrontational.'}

FORMATTING:
- Plain text only. No markdown.
- Label speakers: ${thinker1.name.split(' ').pop()?.toUpperCase()}: and ${thinker2.name.split(' ').pop()?.toUpperCase()}:

CONTENT:
1. DIRECT ADDRESS - always use "you" when challenging the opponent
2. ${targetWordLength > 3000 ? 'Develop arguments fully with philosophical depth and examples' : 'Short, sharp responses - no long monologues'}
3. Aim for approximately ${targetWordLength} words, but reaching a genuine, well-structured ending ALWAYS takes priority over hitting an exact count — never stop mid-thought to satisfy a word target
4. ${hasDocument ? 'MUST engage with the uploaded document - quote it, analyze it, critique it' : 'Ground positions in RAG context when provided'}

Begin the debate. ${hasDocument ? 'Focus on the uploaded document.' : ''} Remember: ADDRESS EACH OTHER DIRECTLY. Target: ${targetWordLength} words total.`;
      } else {
        // Custom mode: User-specified parameters
        if (!instructions || instructions.trim() === "") {
          return res.status(400).json({ error: "Custom mode requires instructions" });
        }
        
        const hasDocument = paperText && paperText.trim().length > 50;
        
        // Truncate very long documents to prevent token overflow
        const maxDocLength = 15000;
        const truncatedPaperTextCustom = hasDocument && paperText.length > maxDocLength 
          ? paperText.slice(0, maxDocLength) + "\n\n[Document truncated for processing - showing first " + Math.round(maxDocLength/1000) + "k characters]"
          : paperText;
        
        debatePrompt = `You are orchestrating a philosophical debate between ${thinker1.name} and ${thinker2.name}.

CRITICAL RULE: The thinkers must DIRECTLY ADDRESS EACH OTHER using "you" - NOT speak about each other in third person.

WRONG: "Hume fails to understand..."
RIGHT: "You fail to understand, Hume..."

USER TOPIC/INSTRUCTIONS:
${instructions}

${hasDocument ? `
======
MANDATORY: THE FOLLOWING DOCUMENT MUST BE THE FOCUS OF THIS DEBATE
======

THE UPLOADED DOCUMENT:
"""
${truncatedPaperTextCustom}
"""

======
CRITICAL: Both thinkers MUST engage DIRECTLY with this document's content.
Quote specific phrases. Analyze specific arguments. DO NOT ignore this document.
======
` : ''}

FORMAT:
- Brief opening from each (1-2 paragraphs)
- ${exchangeRounds} rounds of direct exchange
- Each turn: approximately ${wordsPerTurn} words. ${targetWordLength > 3000 ? 'Develop arguments fully with substance.' : 'Short, punchy, confrontational.'}
- Label speakers: ${thinker1.name.split(' ').pop()?.toUpperCase()}: and ${thinker2.name.split(' ').pop()?.toUpperCase()}:
- Plain text only. No markdown.
- Total: EXACTLY ${targetWordLength} words (THIS IS MANDATORY - COUNT YOUR WORDS)

Begin. DIRECTLY ADDRESS EACH OTHER. Target: ${targetWordLength} words total.`;
      }

      // If enhanced mode, retrieve RAG context for both thinkers
      let ragContext = "";
      if (enhanced) {
        try {
          // Use paper content for RAG query if provided, otherwise use instructions or generic
          let query: string;
          if (paperText && paperText.trim().length > 50) {
            // Extract key terms from paper for more relevant RAG retrieval
            query = paperText.slice(0, 500); // First 500 chars for query
          } else if (mode === "custom" && instructions) {
            query = instructions;
          } else {
            query = `core philosophical positions ${thinker1.name} ${thinker2.name}`;
          }
          
          // CORRECT PARAMETER ORDER: searchPhilosophicalChunks(query, topK, figureId, authorFilter)
          const chunks1 = await searchPhilosophicalChunks(query, 6, "common", normalizeAuthorName(thinker1.name));
          const chunks2 = await searchPhilosophicalChunks(query, 6, "common", normalizeAuthorName(thinker2.name));

          if (chunks1.length > 0 || chunks2.length > 0) {
            ragContext = "\n\n=== DOCUMENTED PHILOSOPHICAL POSITIONS (Use these to ground the debate) ===\n\n";
            
            if (chunks1.length > 0) {
              ragContext += `${thinker1.name}'s documented positions:\n`;
              chunks1.forEach((chunk, i) => {
                ragContext += `[${i + 1}] ${chunk.content}\n`;
                if (chunk.citation) ragContext += `    Source: ${chunk.citation}\n`;
              });
              ragContext += "\n";
            }
            
            if (chunks2.length > 0) {
              ragContext += `${thinker2.name}'s documented positions:\n`;
              chunks2.forEach((chunk, i) => {
                ragContext += `[${i + 1}] ${chunk.content}\n`;
                if (chunk.citation) ragContext += `    Source: ${chunk.citation}\n`;
              });
            }
            
            ragContext += "\n=== END DOCUMENTED POSITIONS ===\n";
          } else if (enhanced) {
            // Warn if RAG failed but enhanced was requested
            console.warn(`[Debate] Enhanced mode enabled but no RAG chunks found for ${thinker1.name} or ${thinker2.name}`);
          }
        } catch (error) {
          console.error("RAG retrieval error:", error);
        }
      }

      const elevenLabsDirective = elevenLabsMode ? `

## ELEVENLABS-READY OUTPUT (THIS OVERRIDES ALL FORMATTING ABOVE)

Output every line using EXACTLY this format:

Speaker 1: <text>

Speaker 2: <text>

ABSOLUTE RULES:
- Use the literal labels "Speaker 1" (${thinker1.name}) and "Speaker 2" (${thinker2.name}). NEVER use character names, last names, "Debater A", or any other label.
- The first speaker to talk is Speaker 1; the second distinct speaker is Speaker 2. Stay consistent throughout.
- One turn per line. A single blank line between turns.
- NO stage directions. NO parentheticals like (scoffs), [pause]. NO asterisks. NO bold. NO italics. NO markdown.
- NO narration, NO scene descriptions, NO preamble, NO title, NO closing remarks. ONLY the dialogue lines themselves.
- Every non-empty output line MUST match this exact pattern: ^Speaker \\d+: .+$
- Direct address still required: speakers should say "you" when challenging each other.` : '';

      const fullPrompt = debatePrompt + ragContext + elevenLabsDirective;

      // Setup SSE headers for streaming
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
      
      // Disable socket timeout and flush headers immediately
      if (res.socket) {
        res.socket.setTimeout(0);
      }
      res.flushHeaders();
      
      // Send initial ping immediately to force proxy to start streaming
      res.write(`data: ${JSON.stringify({ status: "Starting debate generation..." })}\n\n`);
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }

      // Call Anthropic to generate the debate with streaming
      if (!anthropic) {
        res.write(`data: ${JSON.stringify({ error: "Anthropic API not configured" })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      console.log(`[Debate] Starting debate generation between ${thinker1.name} and ${thinker2.name}, target: ${targetWordLength} words`);
      
      // Chunked generation to reach target word count
      let totalContent = "";
      let totalWords = 0;
      let chunkNumber = 0;
      const WORDS_PER_CHUNK = 2500;
      const MAX_CHUNKS = 50;

      // ---- Structural scaffolding (skeleton / arc planning) ----
      // Mirror the Dialogue Creator: plan one unified arc (central conflict,
      // ordered beats, required closure) before generating, so the debate has a
      // real beginning/middle/end and lands a genuine ending — except for very
      // short debates.
      interface DebateBeat { title: string; purpose: string; moves: string[]; }
      const SKELETON_MIN_WORDS = 600;
      const debateSpeaker1 = thinker1.name.split(' ').pop()?.toUpperCase() || 'SPEAKER 1';
      const debateSpeaker2 = thinker2.name.split(' ').pop()?.toUpperCase() || 'SPEAKER 2';
      let skeletonBeats: DebateBeat[] = [];
      let skeletonThesis = '';
      let skeletonClosure = '';
      let structuralPlanBlock = '';

      if (targetWordLength >= SKELETON_MIN_WORDS) {
        const beatCount = Math.min(12, Math.max(4, Math.round(targetWordLength / 450)));
        const planTopic = (paperText && paperText.trim().length > 50)
          ? paperText.slice(0, 6000)
          : (instructions && instructions.trim() ? instructions.trim() : `The deepest philosophical disagreement between ${thinker1.name} and ${thinker2.name}`);
        const planSystem = `You are the architect/dramaturge for a philosophical DEBATE. Plan a single UNIFIED work with a real beginning, middle, and end — not a meandering quarrel.

Return EXACT JSON only, no prose, with this shape:
{
  "thesis": "the central question or point of conflict that drives the whole debate (one sentence)",
  "beats": [ { "title": "short beat name", "purpose": "what this beat accomplishes in the arc", "moves": ["specific attack, rebuttal, or example", "..."] } ],
  "closure": "how the debate ENDS — the decisive clash, crystallized disagreement, or earned concession that gives genuine closure"
}

REQUIREMENTS:
- Produce EXACTLY ${beatCount} beats in dramatic order: an OPENING that frames the conflict, a MIDDLE that escalates it through real disagreement, and a final beat that lands the closure.
- Each beat must ADVANCE the argument — no two beats may cover the same ground.
- The arc must build toward the closure; the debate must feel finished, not abandoned.
- Ground everything in the topic and the two thinkers' actual views.`;
        const planUser = `DEBATERS: ${thinker1.name} vs ${thinker2.name}
TARGET LENGTH: ~${targetWordLength} words
TOPIC / SOURCE:
${planTopic}

Plan the arc now. Return ONLY the JSON object.`;
        try {
          const planRes = await anthropic.messages.create({
            model: "claude-sonnet-4-5-20250929",
            max_tokens: 2000,
            temperature: 0.5,
            system: planSystem,
            messages: [{ role: "user", content: planUser }],
          });
          const rawPlan = planRes.content[0]?.type === 'text' ? planRes.content[0].text : '';
          const jsonMatch = rawPlan.match(/\{[\s\S]*\}/);
          const parsedPlan = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
          if (parsedPlan && Array.isArray(parsedPlan.beats) && parsedPlan.beats.length > 0) {
            skeletonThesis = typeof parsedPlan.thesis === 'string' ? parsedPlan.thesis : '';
            skeletonClosure = typeof parsedPlan.closure === 'string' ? parsedPlan.closure : '';
            skeletonBeats = parsedPlan.beats.map((b: any) => ({
              title: typeof b?.title === 'string' ? b.title : '',
              purpose: typeof b?.purpose === 'string' ? b.purpose : '',
              moves: Array.isArray(b?.moves) ? b.moves.map(String) : [],
            }));
            console.log(`[Debate] Skeleton planned: ${skeletonBeats.length} beats`);
            res.write(`data: ${JSON.stringify({ skeleton: { thesis: skeletonThesis, beats: skeletonBeats.map((b) => b.title), closure: skeletonClosure } })}\n\n`);
          }
        } catch (planErr) {
          console.warn('[Debate] Skeleton planning failed; proceeding without scaffold:', (planErr as Error).message);
        }
      }

      if (skeletonBeats.length > 0) {
        const beatList = skeletonBeats
          .map((b, i) => `${i + 1}. ${b.title} — ${b.purpose}${b.moves.length ? `\n   moves: ${b.moves.join('; ')}` : ''}`)
          .join('\n');
        structuralPlanBlock = `

## STRUCTURAL PLAN — FOLLOW THIS ARC (DO NOT MEANDER)
This debate MUST be ONE unified work with a clear beginning, middle, and end.
CENTRAL CONFLICT / THESIS: ${skeletonThesis || '(frame a clear central conflict from the topic)'}
ORDERED BEATS:
${beatList}
REQUIRED ENDING: ${skeletonClosure || 'Bring the central conflict to a genuine, earned resolution or a crystallized disagreement.'}
RULES:
- Move through the beats IN ORDER; each beat advances the argument and does not restate earlier beats.
- Build steadily toward the ending; the debate must feel COMPLETE, never abandoned mid-thought.
- The final beat must deliver the REQUIRED ENDING above — real closure, no "to be continued", no trailing off.`;
      }

      // Tracks whether a final-flagged chunk actually delivered the closure. A
      // post-loop guard covers the case where an early chunk over-generates and
      // ends the loop before any final chunk runs.
      let closureDelivered = false;

      // Stop generating as soon as the client disconnects (e.g. user hit "Stop").
      let clientGone = false;
      res.on('close', () => { clientGone = true; });

      while (totalWords < targetWordLength && chunkNumber < MAX_CHUNKS) {
        if (clientGone) { console.log('[Debate] Client disconnected; stopping generation'); break; }
        chunkNumber++;
        const remainingWords = targetWordLength - totalWords;
        const wordsBeforeChunk = totalWords;
        let thisChunkIsFinal = false;
        const chunkTarget = Math.min(WORDS_PER_CHUNK, remainingWords + 100);
        const chunkMaxTokens = Math.ceil(chunkTarget * 1.5) + 500;

        let chunkPrompt = "";
        if (chunkNumber === 1) {
          chunkPrompt = fullPrompt + structuralPlanBlock;
        } else {
          chunkPrompt = `Continue the philosophical debate between ${thinker1.name} and ${thinker2.name}. 
Write approximately ${chunkTarget} more words. Do NOT repeat what was already said.
Continue naturally from where we left off:

${totalContent.slice(-2000)}

Continue the debate with new arguments and responses:${elevenLabsDirective}`;
        }

        // Beat guidance for this segment: keep multi-chunk debates on the planned
        // arc and ensure the final segment delivers genuine closure.
        if (skeletonBeats.length > 0) {
          const n = skeletonBeats.length;
          const isFinalChunk = remainingWords <= WORDS_PER_CHUNK;
          thisChunkIsFinal = isFinalChunk;
          const progressBefore = Math.min(1, totalWords / targetWordLength);
          const progressAfter = Math.min(1, (totalWords + chunkTarget) / targetWordLength);
          let beatLo = Math.min(n - 1, Math.floor(progressBefore * n));
          let beatHi = isFinalChunk ? n - 1 : Math.max(beatLo, Math.ceil(progressAfter * n) - 1);
          beatHi = Math.min(n - 1, Math.max(beatLo, beatHi));
          const segBeats = skeletonBeats.slice(beatLo, beatHi + 1);
          const segList = segBeats
            .map((b) => `• ${b.title}: ${b.purpose}${b.moves.length ? ` [${b.moves.join('; ')}]` : ''}`)
            .join('\n');
          chunkPrompt += `

--- ARC GUIDANCE FOR THIS SEGMENT ---
${chunkNumber === 1 ? 'This is the OPENING: frame the central conflict immediately and pull the reader straight in.\n' : ''}Cover these beats now, in order:
${segList || '(continue the planned arc)'}
${isFinalChunk
  ? `\nThis is the FINAL segment. Land the planned ending: ${skeletonClosure || 'resolve or crystallize the central conflict'}. Deliver genuine closure — do NOT trail off, summarize blandly, or set up a sequel.`
  : `\nAdvance the argument with these beats; do NOT wrap up yet — later beats still remain.`}`;
        }

        const stream = await anthropic.messages.create({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: Math.min(chunkMaxTokens, 8000),
          temperature: 0.7,
          stream: true,
          messages: [{ role: "user", content: chunkPrompt }]
        });

        let tokenCount = 0;
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            totalContent += event.delta.text;
            res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
            tokenCount++;
            // Flush periodically to prevent buffering issues in Replit environment
            if (tokenCount % 10 === 0 && typeof (res as any).flush === 'function') {
              (res as any).flush();
            }
          }
        }
        // Flush at end of each chunk
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }

        totalWords = totalContent.split(/\s+/).filter((w: string) => w.length > 0).length;
        console.log(`[Debate] Chunk ${chunkNumber}: ${totalWords} words total`);
        // Only count closure as delivered once the FINAL chunk actually produced
        // new content (a flagged-but-empty chunk must not suppress the fallback).
        if (thisChunkIsFinal && totalWords > wordsBeforeChunk) {
          closureDelivered = true;
        }
        
        // Send keep-alive ping between chunks
        if (totalWords < targetWordLength) {
          res.write(`data: ${JSON.stringify({ status: "continuing..." })}\n\n`);
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
        }
      }

      // Closure guarantee (mirrors Dialogue Creator): if a scaffold was planned
      // but no chunk delivered the closure (e.g. an earlier chunk over-generated
      // and ended the loop), force a short closing segment — with a deterministic
      // labeled fallback if the model returns nothing.
      if (skeletonBeats.length > 0 && !closureDelivered && !res.writableEnded && !clientGone) {
        console.log('[Debate] Closure not delivered by loop; generating forced closing segment');
        const wordsBeforeClosure = totalWords;
        const writeClosureSeam = () => {
          if (totalContent.length > 0 && !totalContent.endsWith('\n\n')) {
            const sep = totalContent.endsWith('\n') ? '\n' : '\n\n';
            totalContent += sep;
            res.write(`data: ${JSON.stringify({ content: sep })}\n\n`);
          }
        };
        try {
          const lastBeat = skeletonBeats[skeletonBeats.length - 1];
          const closurePrompt = `Bring this philosophical debate to its planned close NOW. Continue naturally from where it stops below — do NOT repeat anything already said.

FINAL BEAT: ${lastBeat.title}: ${lastBeat.purpose}${lastBeat.moves.length ? ` [${lastBeat.moves.join('; ')}]` : ''}
REQUIRED ENDING: ${skeletonClosure || 'resolve or crystallize the central conflict'}

Write a short closing exchange (roughly 150-300 words) that delivers genuine closure — the decisive clash or crystallized disagreement. Do NOT trail off or set up a sequel. End on a complete sentence.

${elevenLabsMode
  ? 'FORMAT (MANDATORY): Every line must be exactly "Speaker N: <text>" (e.g. "Speaker 1:", "Speaker 2:"). No narration, no stage directions, no markdown, no character names.'
  : `FORMAT (MANDATORY): Label each turn with the speaker's name in CAPS followed by a colon (e.g. "${debateSpeaker1}:" / "${debateSpeaker2}:"). No narration or stage directions.`}

Debate so far (continue from the end):
${totalContent.slice(-2000)}`;
          const closureStream = await anthropic.messages.create({
            model: "claude-sonnet-4-5-20250929",
            max_tokens: 800,
            temperature: 0.7,
            stream: true,
            messages: [{ role: 'user', content: closurePrompt }],
          });
          let isFirstClosureDelta = true;
          for await (const event of closureStream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              let text = event.delta.text;
              if (isFirstClosureDelta) {
                isFirstClosureDelta = false;
                text = text.replace(/^\s+/, '');
                writeClosureSeam();
                if (text.length === 0) continue;
              }
              totalContent += text;
              res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
            }
          }
          totalWords = totalContent.split(/\s+/).filter((w: string) => w.length > 0).length;
        } catch (closureErr) {
          console.error('[Debate] Forced-closure stream failed:', (closureErr as Error).message);
        }
        // Deterministic guarantee: if the closure stream threw or produced nothing,
        // append an explicit, correctly-labeled closing turn.
        if (totalWords <= wordsBeforeClosure) {
          console.log('[Debate] Forced-closure stream yielded no content; appending deterministic closure');
          const closerLabel = elevenLabsMode ? 'Speaker 2' : debateSpeaker2;
          const fallbackLine = 'Then we end where we began — divided. But at least now the fault line between us is exact, and neither of us can pretend the other has not been heard.';
          const fallbackTurn = `${closerLabel}: ${fallbackLine}`;
          writeClosureSeam();
          totalContent += fallbackTurn;
          res.write(`data: ${JSON.stringify({ content: fallbackTurn })}\n\n`);
          totalWords = totalContent.split(/\s+/).filter((w: string) => w.length > 0).length;
        }
        closureDelivered = true;
      }

      // If the client disconnected (Stop pressed / navigated away), skip all
      // post-loop completion work — it would burn extra LLM calls and write to
      // a closed response.
      if (clientGone || res.writableEnded) {
        console.log('[Debate] Client gone; skipping post-loop completion');
        return;
      }

      // Check if content ends mid-sentence and complete it
      const trimmedContent = totalContent.trim();
      const lastChar = trimmedContent.slice(-1);
      const endsWithPunctuation = ['.', '!', '?', '"', "'", ')'].includes(lastChar);
      
      if (!endsWithPunctuation && chunkNumber < MAX_CHUNKS) {
        console.log(`[Debate] Content ends mid-sentence, generating completion...`);
        
        const completionPrompt = `Complete this sentence and thought, then end with a proper concluding statement. Write NO MORE than 100 words:

${totalContent.slice(-500)}${elevenLabsDirective}`;

        const completionStream = await anthropic.messages.create({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 300,
          temperature: 0.7,
          stream: true,
          messages: [{ role: "user", content: completionPrompt }]
        });

        for await (const event of completionStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            totalContent += event.delta.text;
            res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
          }
        }
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
        
        totalWords = totalContent.split(/\s+/).filter((w: string) => w.length > 0).length;
        console.log(`[Debate] After completion: ${totalWords} words`);
      }

      console.log(`[Debate] Complete: ${totalWords} words in ${chunkNumber} chunks`);
      res.write("data: [DONE]\n\n");
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
      res.end();

    } catch (error) {
      console.error("Debate generation error:", error);
      res.write(`data: ${JSON.stringify({ error: "Failed to generate debate" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });

  // ====== QUOTES API ======
  
  // Get all quotes for a thinker
  app.get("/api/quotes/:thinkerId", async (req, res) => {
    try {
      const { thinkerId } = req.params;
      const quotes = await db.select().from(thinkerQuotes).where(eq(thinkerQuotes.thinkerId, thinkerId));
      res.json(quotes);
    } catch (error) {
      console.error("Error fetching quotes:", error);
      res.status(500).json({ error: "Failed to fetch quotes" });
    }
  });

  // Get random quotes for a thinker
  app.get("/api/quotes/:thinkerId/random", async (req, res) => {
    try {
      const { thinkerId } = req.params;
      const count = parseInt(req.query.count as string) || 5;
      
      const quotes = await db.select()
        .from(thinkerQuotes)
        .where(eq(thinkerQuotes.thinkerId, thinkerId))
        .orderBy(sql`RANDOM()`)
        .limit(count);
      
      res.json(quotes);
    } catch (error) {
      console.error("Error fetching random quotes:", error);
      res.status(500).json({ error: "Failed to fetch random quotes" });
    }
  });

  // Search quotes by topic or content
  app.get("/api/quotes/search", async (req, res) => {
    try {
      const { q, thinkerId } = req.query;
      const searchTerm = `%${q}%`;
      
      let query = db.select().from(thinkerQuotes);
      
      if (thinkerId) {
        query = query.where(eq(thinkerQuotes.thinkerId, thinkerId as string));
      }
      
      const quotes = await query.where(
        sql`${thinkerQuotes.quote} ILIKE ${searchTerm} OR ${thinkerQuotes.topic} ILIKE ${searchTerm}`
      );
      
      res.json(quotes);
    } catch (error) {
      console.error("Error searching quotes:", error);
      res.status(500).json({ error: "Failed to search quotes" });
    }
  });

  // Get all quotes (for Quote Generator)
  app.get("/api/quotes", async (req, res) => {
    try {
      const quotes = await db.select().from(thinkerQuotes);
      res.json(quotes);
    } catch (error) {
      console.error("Error fetching all quotes:", error);
      res.status(500).json({ error: "Failed to fetch quotes" });
    }
  });

  // ======
  // ARGUMENT STATEMENTS API
  // ======

  // Import argument statements (bulk upload)
  app.post("/api/arguments/import", isAdmin, async (req, res) => {
    try {
      const { arguments: args } = req.body;
      
      if (!Array.isArray(args) || args.length === 0) {
        return res.status(400).json({ error: "No arguments provided" });
      }
      
      // Validate and insert each argument
      let inserted = 0;
      let errors: string[] = [];
      
      for (let i = 0; i < args.length; i++) {
        try {
          const arg = args[i];
          
          // Validate required fields
          if (!arg.thinker || !arg.argumentType || !arg.premises || !arg.conclusion) {
            errors.push(`Argument ${i + 1}: Missing required fields`);
            continue;
          }
          
          // Generate embedding for semantic search
          let embedding = null;
          try {
            const embeddingText = `Premises: ${arg.premises.join('. ')}. Conclusion: ${arg.conclusion}`;
            const embeddingResponse = await openai?.embeddings.create({
              model: "text-embedding-ada-002",
              input: embeddingText,
            });
            if (embeddingResponse?.data?.[0]?.embedding) {
              embedding = embeddingResponse.data[0].embedding;
            }
          } catch (embeddingError) {
            console.log(`[Arguments Import] Embedding generation failed for argument ${i + 1}`);
          }
          
          // Insert into database
          await db.execute(
            sql`INSERT INTO argument_statements (thinker, argument_type, premises, conclusion, source_section, source_document, importance, counterarguments, embedding)
                VALUES (
                  ${arg.thinker.toLowerCase()},
                  ${arg.argumentType},
                  ${JSON.stringify(arg.premises)}::jsonb,
                  ${arg.conclusion},
                  ${arg.sourceSection || null},
                  ${arg.sourceDocument || null},
                  ${arg.importance || 5},
                  ${arg.counterarguments ? JSON.stringify(arg.counterarguments) : null}::jsonb,
                  ${embedding ? JSON.stringify(embedding) : null}::vector
                )`
          );
          
          inserted++;
        } catch (insertError) {
          errors.push(`Argument ${i + 1}: ${insertError instanceof Error ? insertError.message : 'Insert failed'}`);
        }
      }
      
      console.log(`[Arguments Import] Inserted ${inserted}/${args.length} arguments`);
      
      res.json({
        success: true,
        inserted,
        total: args.length,
        errors: errors.length > 0 ? errors.slice(0, 10) : undefined
      });
    } catch (error) {
      console.error("Error importing arguments:", error);
      res.status(500).json({ error: "Failed to import arguments" });
    }
  });

  // Get argument count by thinker
  app.get("/api/arguments/stats", async (req, res) => {
    try {
      const result = await db.execute(
        sql`SELECT thinker, COUNT(*) as count FROM argument_statements GROUP BY thinker ORDER BY count DESC`
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Error fetching argument stats:", error);
      res.status(500).json({ error: "Failed to fetch argument stats" });
    }
  });

  // Search arguments by thinker
  app.get("/api/arguments/:thinker", async (req, res) => {
    try {
      const { thinker } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;
      
      const result = await db.execute(
        sql`SELECT id, thinker, argument_type, premises, conclusion, source_section, source_document, importance, counterarguments
            FROM argument_statements 
            WHERE thinker ILIKE ${'%' + thinker + '%'}
            ORDER BY importance DESC
            LIMIT ${limit}`
      );
      
      res.json(result.rows);
    } catch (error) {
      console.error("Error fetching arguments:", error);
      res.status(500).json({ error: "Failed to fetch arguments" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST STRICT OUTLINE GENERATOR (Debug Tool)
  // Extracts semantic skeleton from document - PASS 1 of three-pass architecture
  // ══════════════════════════════════════════════════════════════════════════
  app.post('/api/generate-strict-outline', async (req, res) => {
    try {
      const { documentText, customInstructions, model } = req.body;
      
      if (!documentText || documentText.trim().length < 50) {
        return res.status(400).json({ error: 'Document text required (at least 50 characters)' });
      }
      
      console.log(`[Strict Outline] Extracting skeleton from ${documentText.length} chars, model: ${model || 'gpt-4o'}`);
      
      const skeleton = await extractGlobalSkeleton(documentText, customInstructions || '', model || 'gpt-4o');
      
      console.log(`[Strict Outline] Extracted ${skeleton.outline.length} outline items`);
      
      res.json({ 
        success: true, 
        skeleton,
        stats: {
          inputWords: documentText.split(/\s+/).filter((w: string) => w.length > 0).length,
          outlineItems: skeleton.outline.length,
          keyTerms: Object.keys(skeleton.keyTerms).length,
          entities: skeleton.entities.length
        }
      });
    } catch (error) {
      console.error('[Strict Outline] Error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate outline' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // FULL DOCUMENT GENERATOR (Pipeline Test)
  // Three-pass architecture: skeleton -> constrained chunks -> global stitch
  // Supports expansion up to 300K words
  // ══════════════════════════════════════════════════════════════════════════
  app.post('/api/full-document-generator', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    
    try {
      const { documentText, customInstructions, targetWords, model } = req.body;
      
      if (!documentText || documentText.trim().length < 50) {
        sendEvent({ error: 'Document text required (at least 50 characters)' });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      
      const target = parseInt(targetWords) || 5000;
      const inputWords = documentText.split(/\s+/).filter((w: string) => w.length > 0).length;
      
      console.log(`[Full Doc Generator] Starting: ${inputWords} words -> ${target} words`);
      sendEvent({ status: 'Initializing...', phase: 'init', inputWords, targetWords: target });
      
      // PASS 1: Extract Global Skeleton
      sendEvent({ status: 'PASS 1: Extracting semantic skeleton...', phase: 'skeleton' });
      const skeleton = await extractGlobalSkeleton(documentText, customInstructions || '', model || 'gpt-4o');
      sendEvent({ 
        status: 'Skeleton extracted', 
        phase: 'skeleton_complete',
        skeleton: {
          thesis: skeleton.thesis,
          outlineCount: skeleton.outline.length,
          keyTermsCount: Object.keys(skeleton.keyTerms).length
        }
      });
      
      // Initialize job in database
      const jobId = await initializeReconstructionJob(documentText, customInstructions || '', target);
      await updateJobSkeleton(jobId, skeleton);
      sendEvent({ status: 'Job initialized', phase: 'job_created', jobId });
      
      // Split into chunks
      const chunks = splitIntoChunks(documentText, 500);
      const numChunks = chunks.length;
      const chunkTargetWords = Math.ceil(target / numChunks);
      const lengthRatio = target / inputWords;
      const lengthMode = lengthRatio < 0.5 ? 'heavy_compression' : 
                         lengthRatio < 0.8 ? 'moderate_compression' :
                         lengthRatio < 1.2 ? 'maintain' :
                         lengthRatio < 1.8 ? 'moderate_expansion' : 'heavy_expansion';
      
      await createChunkRecords(jobId, chunks, chunkTargetWords);
      sendEvent({ 
        status: `Divided into ${numChunks} chunks`, 
        phase: 'chunks_created',
        numChunks,
        chunkTargetWords,
        lengthMode
      });
      
      // PASS 2: Process each chunk with skeleton constraints
      sendEvent({ status: 'PASS 2: Processing chunks with skeleton constraints...', phase: 'chunk_processing' });
      
      let allOutput = '';
      for (let i = 0; i < chunks.length; i++) {
        sendEvent({ 
          status: `Processing chunk ${i + 1}/${numChunks}...`, 
          phase: 'chunk_processing',
          chunkIndex: i + 1,
          totalChunks: numChunks
        });
        
        const { output, delta } = await processChunkWithSkeleton(
          chunks[i],
          skeleton,
          i,
          chunkTargetWords,
          lengthMode,
          model || 'gpt-4o'
        );
        
        await updateChunkResult(jobId, i, output, delta);
        allOutput += output + '\n\n';
        
        // Stream the chunk content
        sendEvent({ 
          content: output,
          chunkIndex: i + 1,
          delta: delta
        });
      }
      
      // PASS 3: Global consistency stitch
      sendEvent({ status: 'PASS 3: Checking global consistency...', phase: 'stitching' });
      const { conflicts, repairPlan } = await performGlobalStitch(jobId, skeleton, model || 'gpt-4o');
      
      sendEvent({ 
        status: 'Consistency check complete', 
        phase: 'stitch_complete',
        conflicts,
        repairPlan
      });
      
      // Assemble final output
      const finalOutput = await assembleOutput(jobId);
      const finalWords = finalOutput.split(/\s+/).filter((w: string) => w.length > 0).length;
      
      sendEvent({ 
        status: 'Complete!', 
        phase: 'complete',
        finalWordCount: finalWords,
        targetWords: target,
        jobId
      });
      
      console.log(`[Full Doc Generator] Complete: ${finalWords}/${target} words`);
      
    } catch (error) {
      console.error('[Full Doc Generator] Error:', error);
      sendEvent({ error: error instanceof Error ? error.message : 'Generation failed' });
    }
    
    res.write('data: [DONE]\n\n');
    res.end();
  });

  // ════════════════════════════════════════════════════════════════════════
  // CROSS-CHUNK COHERENCE (CC) RECONSTRUCTION ENDPOINTS
  // 3-pass system: skeleton → constrained chunks → stitch
  // ════════════════════════════════════════════════════════════════════════

  // POST /api/reconstruction
  // Body: { originalText: string, customInstructions?: string }
  // Streams SSE events: status, job_init, skeleton, chunk_start, chunk_done,
  //                     chunk_retry, stitch, complete, error, [DONE]
  app.post('/api/reconstruction', async (req: any, res) => {
    const { originalText, customInstructions } = req.body || {};
    if (!originalText || typeof originalText !== 'string' || originalText.trim().length < 50) {
      return res.status(400).json({ error: 'originalText is required (min 50 chars)' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.socket) res.socket.setTimeout(0);
    res.flushHeaders();

    const keepAlive = setInterval(() => {
      try { res.write(`: ka\n\n`); } catch { clearInterval(keepAlive); }
    }, 15000);
    const abortController = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!clientGone) {
        clientGone = true;
        console.log('[reconstruction] client disconnected');
        try { abortController.abort(); } catch {}
      }
      clearInterval(keepAlive);
    });

    try {
      for await (const evt of runReconstruction({
        originalText,
        customInstructions: customInstructions || '',
        userId: req.user?.id,
        signal: abortController.signal,
      })) {
        if (clientGone) break;
        try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { break; }
      }
    } catch (err) {
      console.error('[reconstruction] route error:', err);
      try { res.write(`data: ${JSON.stringify({ type: 'error', data: (err as Error).message })}\n\n`); } catch {}
    } finally {
      clearInterval(keepAlive);
      try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
    }
  });

  // POST /api/reconstruction/:jobId/resume — resume an interrupted job (SSE)
  app.post('/api/reconstruction/:jobId/resume', async (req: any, res) => {
    const { jobId } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.socket) res.socket.setTimeout(0);
    res.flushHeaders();

    const keepAlive = setInterval(() => {
      try { res.write(`: ka\n\n`); } catch { clearInterval(keepAlive); }
    }, 15000);
    const abortController = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!clientGone) { clientGone = true; try { abortController.abort(); } catch {} }
      clearInterval(keepAlive);
    });

    try {
      for await (const evt of resumeReconstruction(jobId, abortController.signal)) {
        if (clientGone) break;
        try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { break; }
      }
    } catch (err) {
      try { res.write(`data: ${JSON.stringify({ type: 'error', data: (err as Error).message })}\n\n`); } catch {}
    } finally {
      clearInterval(keepAlive);
      try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
    }
  });

  // GET /api/reconstruction/:jobId/result — full assembled output for download
  app.get('/api/reconstruction/:jobId/result', async (req, res) => {
    try {
      const { jobId } = req.params;
      const result = await db.execute(sql`
        SELECT id, status, final_output, final_word_count, total_input_words,
               target_min_words, target_max_words, length_mode, num_chunks,
               stitch_report, global_skeleton, custom_instructions, created_at
        FROM reconstruction_jobs WHERE id = ${jobId}::uuid
      `);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      res.json(result.rows[0]);
    } catch (error) {
      console.error('Error fetching reconstruction result:', error);
      res.status(500).json({ error: 'Failed to fetch result' });
    }
  });

  // Get reconstruction job status
  app.get('/api/reconstruction-job/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;
      const result = await db.execute(sql`
        SELECT * FROM reconstruction_jobs WHERE id = ${jobId}::uuid
      `);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      const chunks = await db.execute(sql`
        SELECT chunk_index, status, actual_words, chunk_delta 
        FROM reconstruction_chunks 
        WHERE job_id = ${jobId}::uuid 
        ORDER BY chunk_index
      `);
      
      res.json({ job: result.rows[0], chunks: chunks.rows });
    } catch (error) {
      console.error('Error fetching job:', error);
      res.status(500).json({ error: 'Failed to fetch job' });
    }
  });

  // ──────────────────────────────────────────────────────
  // COHERENCE STATE ENDPOINT
  // ──────────────────────────────────────────────────────
  app.get('/api/coherence/:documentId', async (req, res) => {
    try {
      const { documentId } = req.params;
      const mode = (req.query.mode as string) || 'philosophical';
      const state = await readCoherenceState(documentId, mode);
      
      if (!state) {
        return res.status(404).json({ error: 'Coherence state not found' });
      }
      
      res.json({ documentId, state });
    } catch (error) {
      console.error('Error fetching coherence state:', error);
      res.status(500).json({ error: 'Failed to fetch coherence state' });
    }
  });

  // ── User Document Storage ──────────────────────────────────────────────
  const docUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
    fileFilter: (_req, file, cb) => {
      if (file.originalname.match(/\.(txt|md|pdf|docx|doc)$/i) ||
          ['text/plain','application/pdf',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'application/msword'].includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Only .txt, .md, .pdf, .doc, .docx allowed'));
      }
    }
  });

  // Save pasted/typed text directly as a document
  app.post("/api/user-documents/text", async (req: any, res) => {
    try {
      const authUser = req.user;
      if (!authUser) return res.status(401).json({ error: "Not authenticated" });
      const { name, text } = req.body as { name?: string; text?: string };
      if (!text?.trim()) return res.status(400).json({ error: "Text is empty" });
      const docName = (name?.trim() || "Pasted text") + ".txt";
      const doc = await storage.createUserDocument({
        authUserId: authUser.id,
        originalName: docName,
        fileType: "txt",
        extractedText: text.trim(),
        rawBytes: Buffer.from(text.trim()).toString("base64"),
        sizeBytes: Buffer.byteLength(text.trim(), "utf8"),
      });
      res.json({ success: true, document: { id: doc.id, originalName: doc.originalName, fileType: doc.fileType, sizeBytes: doc.sizeBytes, uploadedAt: doc.uploadedAt } });
    } catch (err) {
      res.status(500).json({ error: "Failed to save text" });
    }
  });

  // List documents for the signed-in user
  app.get("/api/user-documents", async (req: any, res) => {
    try {
      const authUser = req.user;
      if (!authUser) return res.status(401).json({ error: "Not authenticated" });
      const docs = await storage.getUserDocuments(authUser.id);
      res.json({ documents: docs });
    } catch (err) {
      console.error("[UserDocs] list error:", err);
      res.status(500).json({ error: "Failed to list documents" });
    }
  });

  // Upload a document
  app.post("/api/user-documents", docUpload.single("file"), async (req: any, res) => {
    try {
      const authUser = req.user;
      if (!authUser) return res.status(401).json({ error: "Not authenticated" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const ext = req.file.originalname.split('.').pop()?.toLowerCase() ?? '';
      let extractedText = '';

      if (ext === 'txt' || ext === 'md') {
        extractedText = req.file.buffer.toString('utf-8');
      } else if (ext === 'pdf') {
        const pdfData = await pdfParse(req.file.buffer);
        extractedText = pdfData.text;
      } else if (ext === 'docx' || ext === 'doc') {
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        extractedText = result.value;
      }

      if (!extractedText.trim()) {
        return res.status(400).json({ error: "Document is empty or could not be parsed" });
      }

      const rawBytes = req.file.buffer.toString('base64');
      const doc = await storage.createUserDocument({
        authUserId: authUser.id,
        originalName: req.file.originalname,
        fileType: ext,
        extractedText,
        rawBytes,
        sizeBytes: req.file.size,
      });

      res.json({ success: true, document: { id: doc.id, originalName: doc.originalName, fileType: doc.fileType, sizeBytes: doc.sizeBytes, uploadedAt: doc.uploadedAt } });
    } catch (err) {
      console.error("[UserDocs] upload error:", err);
      res.status(500).json({ error: err instanceof Error ? err.message : "Upload failed" });
    }
  });

  // Get a document's extracted text (for "use in chat")
  app.get("/api/user-documents/:id/text", async (req: any, res) => {
    try {
      const authUser = req.user;
      if (!authUser) return res.status(401).json({ error: "Not authenticated" });
      const doc = await storage.getUserDocument(Number(req.params.id), authUser.id);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      res.json({ text: doc.extractedText, originalName: doc.originalName });
    } catch (err) {
      res.status(500).json({ error: "Failed to retrieve document" });
    }
  });

  // Download a document (returns base64 raw bytes)
  app.get("/api/user-documents/:id/download", async (req: any, res) => {
    try {
      const authUser = req.user;
      if (!authUser) return res.status(401).json({ error: "Not authenticated" });
      const doc = await storage.getUserDocument(Number(req.params.id), authUser.id);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      if (!doc.rawBytes) return res.status(404).json({ error: "No raw file stored" });

      const buf = Buffer.from(doc.rawBytes, 'base64');
      const mimeMap: Record<string, string> = {
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        doc: 'application/msword',
        txt: 'text/plain',
        md: 'text/markdown',
      };
      res.setHeader('Content-Type', mimeMap[doc.fileType] ?? 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.originalName}"`);
      res.send(buf);
    } catch (err) {
      res.status(500).json({ error: "Download failed" });
    }
  });

  // Delete a document
  app.delete("/api/user-documents/:id", async (req: any, res) => {
    try {
      const authUser = req.user;
      if (!authUser) return res.status(401).json({ error: "Not authenticated" });
      await storage.deleteUserDocument(Number(req.params.id), authUser.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Delete failed" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
