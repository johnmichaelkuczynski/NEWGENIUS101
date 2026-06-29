import Anthropic from "@anthropic-ai/sdk";
import { TestResult, SelfTestEvent } from "./selfTest";

// "Digital Accuracy" diagnostic: a synthetic user asks the app factual questions,
// captures the real output, then asks Claude to grade the answer's factual accuracy
// on a 0-100 scale. A feature passes if its accuracy is non-zero (above the floor).

const CONTENT_KEYS = ["content", "token", "delta", "text", "chunk"];
const PASS_FLOOR = 1; // user requirement: accuracy must not be zero

function extractJsonText(json: any): string {
  if (!json) return "";
  if (Array.isArray(json.quotes)) {
    return json.quotes
      .map((q: any) => (typeof q === "string" ? q : q?.text || q?.quote || ""))
      .join("\n");
  }
  if (typeof json.text === "string") return json.text;
  if (typeof json.content === "string") return json.content;
  return "";
}

async function drive(
  originBase: string,
  path: string,
  body: any,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const r = await fetch(`${originBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const contentType = r.headers.get("content-type") || "";
    if (!contentType.includes("event-stream")) {
      const json: any = await r.json().catch(() => null);
      if (json?.error) throw new Error(json.error);
      return extractJsonText(json).trim();
    }
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let text = "";
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop() || "";
      for (const block of blocks) {
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          try { await reader.cancel(); } catch {}
          return text.trim();
        }
        try {
          const ev = JSON.parse(payload);
          for (const k of CONTENT_KEYS) {
            if (typeof ev[k] === "string") text += ev[k];
          }
        } catch {}
      }
    }
    try { await reader.cancel(); } catch {}
    return text.trim();
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

async function gradeWithClaude(
  question: string,
  reference: string,
  answer: string,
): Promise<{ score: number; reason: string }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const resp = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content:
          `You are a strict but fair grader. Grade the FACTUAL ACCURACY and RELEVANCE of an answer.\n\n` +
          `QUESTION: ${question}\n\n` +
          `KEY FACTS THAT A CORRECT ANSWER SHOULD REFLECT: ${reference}\n\n` +
          `ANSWER TO GRADE:\n"""${answer.slice(0, 4000)}"""\n\n` +
          `Score 0-100 where 0 = empty/irrelevant/wrong, 100 = fully accurate and on-topic. ` +
          `Partial credit is fine. Respond with ONLY valid JSON: {"score": <number>, "reason": "<one short sentence>"}`,
      },
    ],
  });
  const raw = resp.content.map((b: any) => b.text || "").join("").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Grader returned no JSON: ${raw.slice(0, 80)}`);
  const parsed = JSON.parse(match[0]);
  const score = Math.max(0, Math.min(100, Number(parsed.score) || 0));
  return { score, reason: String(parsed.reason || "") };
}

interface AccuracyCase {
  name: string;
  question: string;
  reference: string;
  path: string;
  body: any;
  timeoutMs: number;
}

const CASES: AccuracyCase[] = [
  {
    name: "Chat — Freud on the id",
    question: "What does the term 'the id' refer to in Freud's structural model of the psyche?",
    reference:
      "The id is the primitive, unconscious part of the psyche driven by instinctual drives and the pleasure principle, present from birth, demanding immediate gratification.",
    path: "/api/figures/freud/chat",
    body: {
      message: "What does the term 'the id' refer to in your structural model of the psyche?",
      settings: { dialogueMode: true, enhancedMode: false },
    },
    timeoutMs: 240000,
  },
  {
    name: "Chat — Aristotle's four causes",
    question: "What are Aristotle's four causes?",
    reference:
      "The material cause (what something is made of), the formal cause (its form/essence), the efficient cause (what brings it about), and the final cause (its purpose/telos).",
    path: "/api/figures/aristotle/chat",
    body: {
      message: "Briefly, what are your four causes?",
      settings: { dialogueMode: true, enhancedMode: false },
    },
    timeoutMs: 240000,
  },
  {
    name: "Quotes — Nietzsche relevance",
    question: "Are the returned quotes plausibly about freedom and the will and in Nietzsche's voice?",
    reference:
      "Quotes should be thematically relevant to freedom/will/power and consistent with Nietzsche's style and ideas.",
    path: "/api/quotes/generate",
    body: { query: "freedom and the will to power", author: "Nietzsche", numQuotes: 3 },
    timeoutMs: 60000,
  },
  {
    name: "Paper — Hume on causation",
    question: "Does the paper accurately present Hume's view of causation?",
    reference:
      "Hume argues we never perceive necessary connection between cause and effect; causation is constant conjunction plus the mind's habit/custom of expecting the effect.",
    path: "/api/figures/hume/write-paper",
    body: { topic: "the problem of causation and necessary connection", wordLength: 200, numberOfQuotes: 0 },
    timeoutMs: 90000,
  },
];

async function runCase(c: AccuracyCase, originBase: string, signal?: AbortSignal): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const answer = await drive(originBase, c.path, c.body, c.timeoutMs, signal);
    if (!answer || answer.length < 20) {
      return {
        name: c.name,
        category: "Accuracy",
        status: "fail",
        durationMs: Date.now() - t0,
        message: "No output to grade — feature returned nothing.",
        details: { score: 0 },
      };
    }
    const { score, reason } = await gradeWithClaude(c.question, c.reference, answer);
    const status = score >= PASS_FLOOR ? "pass" : "fail";
    return {
      name: c.name,
      category: "Accuracy",
      status,
      durationMs: Date.now() - t0,
      message: `Accuracy ${score}/100 — ${reason}`,
      details: { score, words: answer.split(/\s+/).filter(Boolean).length },
    };
  } catch (err: any) {
    return {
      name: c.name,
      category: "Accuracy",
      status: "fail",
      durationMs: Date.now() - t0,
      message: err?.name === "AbortError" ? "Timed out / aborted" : err?.message || String(err),
      details: { score: 0 },
    };
  }
}

export async function* runAccuracyTest(
  originBase: string,
  signal?: AbortSignal,
): AsyncGenerator<SelfTestEvent> {
  const results: TestResult[] = [];
  const startedAt = Date.now();

  const noGrader = !process.env.ANTHROPIC_API_KEY;
  if (noGrader) {
    yield { type: "log", data: { message: "ANTHROPIC_API_KEY not set — accuracy grading unavailable, skipping cases." } };
  }

  for (const c of CASES) {
    if (signal?.aborted) {
      yield { type: "log", data: { message: `Aborted before "${c.name}". Stopping.` } };
      break;
    }
    yield { type: "start", data: { name: c.name, category: "Accuracy" } };
    let result: TestResult;
    if (noGrader) {
      result = {
        name: c.name,
        category: "Accuracy",
        status: "skip",
        durationMs: 0,
        message: "Skipped — Claude grader unavailable (ANTHROPIC_API_KEY not set).",
      };
    } else {
      result = await runCase(c, originBase, signal);
    }
    results.push(result);
    yield { type: "result", data: result };
  }

  const graded = results.filter((r) => r.status !== "skip");
  const scored = graded.map((r) => r.details?.score ?? 0);
  const avg = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : undefined;

  yield {
    type: "summary",
    data: {
      totalTests: results.length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
      skipped: results.filter((r) => r.status === "skip").length,
      averageScore: avg,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || "development",
      results,
    },
  };
}
