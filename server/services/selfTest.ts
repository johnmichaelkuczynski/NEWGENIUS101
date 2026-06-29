import { db } from "../db";
import { storage } from "../storage";
import { coherentSessions } from "@shared/schema";
import { sql } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type TestStatus = "pass" | "fail" | "skip";

export interface TestResult {
  name: string;
  category: string;
  status: TestStatus;
  durationMs: number;
  message: string;
  details?: any;
}

export interface SelfTestEvent {
  type: "start" | "result" | "summary" | "log";
  data: any;
}

const TIMEOUT_MS = 15000;

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function timed(name: string, category: string, fn: () => Promise<{ message: string; details?: any }>): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const out = await withTimeout(fn());
    return { name, category, status: "pass", durationMs: Date.now() - t0, message: out.message, details: out.details };
  } catch (err: any) {
    return { name, category, status: "fail", durationMs: Date.now() - t0, message: err?.message || String(err) };
  }
}

function skip(name: string, category: string, reason: string): TestResult {
  return { name, category, status: "skip", durationMs: 0, message: reason };
}

// ---------------- INDIVIDUAL TESTS ----------------

async function testDatabaseConnectivity(): Promise<TestResult> {
  return timed("Database connection", "Infrastructure", async () => {
    // Mirror what /api/figures does — this is the real path used in production.
    const thinkers = await storage.getAllThinkers();
    if (!Array.isArray(thinkers) || thinkers.length === 0) {
      throw new Error("Storage returned no thinkers");
    }
    return { message: `Connected. ${thinkers.length} thinkers available.`, details: { thinkerCount: thinkers.length } };
  });
}

async function testDatabaseTables(): Promise<TestResult> {
  return timed("Database schema", "Infrastructure", async () => {
    const raw: any = await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    const list: any[] = Array.isArray(raw) ? raw : (raw.rows ?? []);
    const tables = list.map((r: any) => r.table_name).filter(Boolean);
    // Only require tables actually used by the long-form generator and chat persistence.
    const required = ["coherent_sessions", "coherent_chunks", "stitch_results", "messages"];
    const missing = required.filter((t) => !tables.includes(t));
    if (missing.length) throw new Error(`Missing required tables: ${missing.join(", ")} (found ${tables.length} total)`);
    return { message: `${tables.length} tables present, all required tables found.`, details: { tableCount: tables.length, required } };
  });
}

async function testStorageWrite(): Promise<TestResult> {
  return timed("Storage write/read", "Infrastructure", async () => {
    const [row] = await db.insert(coherentSessions).values({
      thinker: "__SELFTEST__",
      topic: "self-test write probe",
      status: "selftest",
      totalChunks: 0,
      completedChunks: 0,
    }).returning({ id: coherentSessions.id });
    if (!row?.id) throw new Error("Insert returned no id");
    await db.execute(sql`DELETE FROM coherent_sessions WHERE id = ${row.id}`);
    return { message: `Round-trip insert + delete succeeded (id ${row.id.slice(0, 8)}…).` };
  });
}

async function testAnthropic(): Promise<TestResult> {
  if (!process.env.ANTHROPIC_API_KEY) return skip("Anthropic (Claude)", "AI Providers", "ANTHROPIC_API_KEY not set");
  return timed("Anthropic (Claude)", "AI Providers", async () => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const resp = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 20,
      messages: [{ role: "user", content: "Reply with just the word OK." }],
    });
    const txt = resp.content.map((b: any) => b.text || "").join("").trim();
    if (!txt) throw new Error("Empty response");
    return { message: `Replied: "${txt.slice(0, 40)}"`, details: { model: resp.model, stopReason: resp.stop_reason } };
  });
}

async function testOpenAI(): Promise<TestResult> {
  if (!process.env.OPENAI_API_KEY) return skip("OpenAI (GPT-4o)", "AI Providers", "OPENAI_API_KEY not set");
  return timed("OpenAI (GPT-4o)", "AI Providers", async () => {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const resp = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 10,
      messages: [{ role: "user", content: "Reply with just the word OK." }],
    });
    const txt = resp.choices[0]?.message?.content?.trim() || "";
    if (!txt) throw new Error("Empty response");
    return { message: `Replied: "${txt.slice(0, 40)}"`, details: { model: resp.model } };
  });
}

async function testOpenAICompatible(name: string, envKey: string, baseURL: string, model: string, category = "AI Providers"): Promise<TestResult> {
  const key = process.env[envKey];
  if (!key) return skip(name, category, `${envKey} not set`);
  return timed(name, category, async () => {
    const client = new OpenAI({ apiKey: key, baseURL });
    const resp = await client.chat.completions.create({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with just the word OK." }],
    });
    const txt = resp.choices[0]?.message?.content?.trim() || "";
    if (!txt) throw new Error("Empty response");
    return { message: `Replied: "${txt.slice(0, 40)}"`, details: { model } };
  });
}

async function testEmbedding(): Promise<TestResult> {
  if (!process.env.OPENAI_API_KEY) return skip("Embeddings (text-embedding-ada-002)", "AI Providers", "OPENAI_API_KEY not set");
  return timed("Embeddings (text-embedding-ada-002)", "AI Providers", async () => {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const resp = await client.embeddings.create({ model: "text-embedding-ada-002", input: "self test embedding probe" });
    const dim = resp.data[0]?.embedding?.length ?? 0;
    if (dim !== 1536) throw new Error(`Expected 1536 dims, got ${dim}`);
    return { message: `Generated 1536-dim vector successfully.`, details: { dim } };
  });
}

function testAzureSpeechConfig(): TestResult {
  const haveKey = !!process.env.AZURE_SPEECH_KEY;
  const haveRegion = !!process.env.AZURE_SPEECH_REGION;
  if (haveKey && haveRegion) {
    return { name: "Azure Speech (TTS)", category: "Voice", status: "pass", durationMs: 0, message: `Configured (region: ${process.env.AZURE_SPEECH_REGION}).` };
  }
  return { name: "Azure Speech (TTS)", category: "Voice", status: "fail", durationMs: 0, message: `Missing ${!haveKey ? "AZURE_SPEECH_KEY " : ""}${!haveRegion ? "AZURE_SPEECH_REGION" : ""}` };
}

function testGoogleOAuthConfig(): TestResult {
  const ok = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  return ok
    ? { name: "Google OAuth", category: "Auth", status: "pass", durationMs: 0, message: "Client ID and secret are configured." }
    : { name: "Google OAuth", category: "Auth", status: "fail", durationMs: 0, message: "GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET missing." };
}

async function testFiguresEndpoint(originBase: string, signal?: AbortSignal): Promise<TestResult> {
  return timed("Figures API", "API Routes", async () => {
    const r = await fetch(`${originBase}/api/figures`, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as any[];
    if (!Array.isArray(data) || data.length === 0) throw new Error("No figures returned");
    return { message: `GET /api/figures returned ${data.length} figures.`, details: { sample: data.slice(0, 3).map((f) => f.id) } };
  });
}

async function testLongFormSkeleton(originBase: string, signal?: AbortSignal): Promise<TestResult> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return skip("Long-form generator (skeleton)", "Generators", "No LLM provider available");
  }
  // Long-form needs more headroom: skeleton extraction + first chunk streaming.
  const t0 = Date.now();
  try {
    const out = await new Promise<{ message: string; details?: any }>(async (resolve, reject) => {
      const hardTimer = setTimeout(() => reject(new Error("Timed out after 60000ms")), 60000);
      const onAbort = () => { clearTimeout(hardTimer); reject(new Error("Aborted by client")); };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        const r = await runLongFormProbe(originBase, signal);
        clearTimeout(hardTimer);
        resolve(r);
      } catch (e) { clearTimeout(hardTimer); reject(e); }
      finally { signal?.removeEventListener("abort", onAbort); }
    });
    return { name: "Long-form generator (skeleton)", category: "Generators", status: "pass", durationMs: Date.now() - t0, message: out.message, details: out.details };
  } catch (err: any) {
    return { name: "Long-form generator (skeleton)", category: "Generators", status: "fail", durationMs: Date.now() - t0, message: err?.message || String(err) };
  }
}

async function runLongFormProbe(originBase: string, externalSignal?: AbortSignal): Promise<{ message: string; details?: any }> {
  {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 55000);
    const onExternalAbort = () => ctrl.abort();
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      const r = await fetch(`${originBase}/api/figures/aristotle/long-form`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "the nature of virtue", mode: "essay", wordLength: 400 }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let got = { skeleton: false, content: false, complete: false };
      let buf = "";
      const start = Date.now();
      while (Date.now() - start < 50000) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop() || "";
        for (const block of lines) {
          if (!block.startsWith("data:")) continue;
          const payload = block.slice(5).trim();
          if (payload === "[DONE]") { got.complete = true; break; }
          try {
            const ev = JSON.parse(payload);
            // Endpoint emits flat shape: {skeleton: {...}}, {content: "..."}, {complete: {...}}.
            // Generator may also emit envelope shape: {type:"skeleton", data:{...}}. Handle both.
            if (ev.skeleton || ev.type === "skeleton") got.skeleton = true;
            if (ev.content !== undefined || ev.type === "content") got.content = true;
            if (ev.complete || ev.type === "complete") got.complete = true;
          } catch {}
        }
        // Stop early once we've seen both skeleton + content — that's enough
        // to call the pipeline healthy without waiting for full completion.
        if (got.skeleton && got.content) { got.complete = true; break; }
      }
      try { await reader.cancel(); } catch {}
      if (externalSignal?.aborted) throw new Error("Aborted by client");
      if (!got.skeleton) throw new Error("Did not receive skeleton event");
      if (!got.content) throw new Error("Did not receive any content");
      return { message: "Skeleton + streaming content received.", details: got };
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

// ---------------- ORCHESTRATOR ----------------

export async function* runSelfTest(originBase: string, signal?: AbortSignal): AsyncGenerator<SelfTestEvent> {
  const results: TestResult[] = [];
  const startedAt = Date.now();

  const queue: Array<{ name: string; category: string; run: () => Promise<TestResult> }> = [
    { name: "Database connection", category: "Infrastructure", run: testDatabaseConnectivity },
    { name: "Database schema", category: "Infrastructure", run: testDatabaseTables },
    { name: "Storage write/read", category: "Infrastructure", run: testStorageWrite },
    { name: "Anthropic (Claude)", category: "AI Providers", run: testAnthropic },
    { name: "OpenAI (GPT-4o)", category: "AI Providers", run: testOpenAI },
    { name: "DeepSeek", category: "AI Providers", run: () => testOpenAICompatible("DeepSeek", "DEEPSEEK_API_KEY", "https://api.deepseek.com", "deepseek-chat") },
    { name: "Grok (xAI)", category: "AI Providers", run: () => testOpenAICompatible("Grok (xAI)", "GROK_API_KEY", "https://api.x.ai/v1", "grok-3") },
    { name: "Perplexity", category: "AI Providers", run: () => testOpenAICompatible("Perplexity", "PERPLEXITY_API_KEY", "https://api.perplexity.ai", "sonar") },
    { name: "Venice", category: "AI Providers", run: () => testOpenAICompatible("Venice", "VENICE_API_KEY", "https://api.venice.ai/api/v1", "llama-3.3-70b") },
    { name: "Embeddings (text-embedding-ada-002)", category: "AI Providers", run: testEmbedding },
    { name: "Azure Speech (TTS)", category: "Voice", run: async () => testAzureSpeechConfig() },
    { name: "Google OAuth", category: "Auth", run: async () => testGoogleOAuthConfig() },
    { name: "Figures API", category: "API Routes", run: () => testFiguresEndpoint(originBase, signal) },
    { name: "Long-form generator (skeleton)", category: "Generators", run: () => testLongFormSkeleton(originBase, signal) },
  ];

  for (const item of queue) {
    if (signal?.aborted) {
      yield { type: "log", data: { message: `Aborted before "${item.name}". Stopping.` } };
      break;
    }
    yield { type: "start", data: { name: item.name, category: item.category } };
    let result: TestResult;
    try {
      result = await item.run();
    } catch (err: any) {
      result = { name: item.name, category: item.category, status: "fail", durationMs: 0, message: err?.message || String(err) };
    }
    results.push(result);
    yield { type: "result", data: result };
  }

  const summary = {
    totalTests: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skip").length,
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    environment: process.env.NODE_ENV || "development",
    results,
  };
  yield { type: "summary", data: summary };
}
