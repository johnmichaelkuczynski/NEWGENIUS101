import { TestResult, SelfTestEvent } from "./selfTest";

// A "synthetic user" diagnostic: it drives every user-facing feature through the
// real HTTP API exactly the way the browser does, accumulates the actual generated
// output, and fails the feature if no real content comes back.

interface DriveResult {
  text: string;
  events: number;
  done: boolean;
  errorEvent?: string;
}

const CONTENT_KEYS = ["content", "token", "delta", "text", "chunk"];

function extractJsonText(json: any): string {
  if (!json) return "";
  if (Array.isArray(json.quotes)) {
    return json.quotes
      .map((q: any) => (typeof q === "string" ? q : q?.text || q?.quote || ""))
      .join(" ");
  }
  if (typeof json.text === "string") return json.text;
  if (typeof json.content === "string") return json.content;
  if (typeof json.result === "string") return json.result;
  return "";
}

async function drive(
  originBase: string,
  path: string,
  body: any,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<DriveResult> {
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

    // Non-streaming JSON response (e.g. quotes generator, or an error body).
    if (!contentType.includes("event-stream")) {
      const json: any = await r.json().catch(() => null);
      if (!r.ok) {
        const msg = json?.error || `HTTP ${r.status}`;
        return { text: "", events: 0, done: true, errorEvent: msg };
      }
      if (json?.error) return { text: "", events: 0, done: true, errorEvent: json.error };
      return { text: extractJsonText(json).trim(), events: 1, done: true };
    }

    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let text = "";
    let events = 0;
    let done = false;
    let errorEvent: string | undefined;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const { value, done: rdone } = await reader.read();
      if (rdone) {
        done = true;
        break;
      }
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop() || "";
      for (const block of blocks) {
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          done = true;
          break;
        }
        try {
          const ev = JSON.parse(payload);
          if (typeof ev.error === "string") errorEvent = ev.error;
          for (const k of CONTENT_KEYS) {
            if (typeof ev[k] === "string") {
              text += ev[k];
              events++;
            }
          }
        } catch {
          /* ignore non-JSON keepalive lines */
        }
      }
      if (done) break;
    }
    try {
      await reader.cancel();
    } catch {}
    return { text: text.trim(), events, done, errorEvent };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

const MIN_CHARS = 40;

interface Flow {
  name: string;
  path: string;
  body: any;
  timeoutMs: number;
}

const FLOWS: Flow[] = [
  {
    name: "Q&A Chat",
    path: "/api/figures/freud/chat",
    body: {
      message: "In one sentence, what does the term 'the id' refer to?",
      settings: { dialogueMode: true, enhancedMode: false },
    },
    timeoutMs: 240000,
  },
  {
    name: "Paper Writer",
    path: "/api/figures/freud/write-paper",
    body: { topic: "the unconscious mind", wordLength: 150, numberOfQuotes: 0 },
    timeoutMs: 90000,
  },
  {
    name: "Long-form Essay",
    path: "/api/figures/aristotle/long-form",
    body: { topic: "the nature of virtue", mode: "essay", wordLength: 300 },
    timeoutMs: 90000,
  },
  {
    name: "Model Builder",
    path: "/api/model-builder",
    body: {
      originalText:
        "All men are mortal. Socrates is a man. Therefore Socrates is mortal.",
      mode: "informal",
      formalMode: false,
      entireTextMode: true,
    },
    timeoutMs: 90000,
  },
  {
    name: "Quote Generator",
    path: "/api/quotes/generate",
    body: { query: "freedom and the will", author: "Nietzsche", numQuotes: 3 },
    timeoutMs: 60000,
  },
  {
    name: "Dialogue Creator",
    path: "/api/dialogue-creator",
    body: {
      text: "the meaning of justice",
      authorId1: "plato",
      authorId2: "aristotle",
      wordLength: 150,
    },
    timeoutMs: 90000,
  },
  {
    name: "Interview Creator",
    path: "/api/interview-creator",
    body: {
      thinkerId: "kant",
      mode: "casual",
      interviewerTone: "curious",
      wordLength: 150,
      topic: "the categorical imperative",
    },
    timeoutMs: 90000,
  },
  {
    name: "Debate Creator",
    path: "/api/debate/generate",
    body: { thinker1Id: "hume", thinker2Id: "kant", mode: "auto", wordLength: 250 },
    timeoutMs: 100000,
  },
];

async function runFlow(flow: Flow, originBase: string, signal?: AbortSignal): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const r = await drive(originBase, flow.path, flow.body, flow.timeoutMs, signal);
    const words = r.text ? r.text.split(/\s+/).filter(Boolean).length : 0;
    if (r.errorEvent && !r.text) {
      return {
        name: flow.name,
        category: "User Flows",
        status: "fail",
        durationMs: Date.now() - t0,
        message: `Endpoint returned an error: ${r.errorEvent}`,
      };
    }
    if (r.text.length < MIN_CHARS) {
      return {
        name: flow.name,
        category: "User Flows",
        status: "fail",
        durationMs: Date.now() - t0,
        message: `Returned almost no content (${r.text.length} chars). Feature is not producing output.`,
        details: { chars: r.text.length, events: r.events },
      };
    }
    return {
      name: flow.name,
      category: "User Flows",
      status: "pass",
      durationMs: Date.now() - t0,
      message: `Generated ${words} words. Sample: "${r.text.slice(0, 80).replace(/\s+/g, " ")}…"`,
      details: { words, chars: r.text.length, events: r.events },
    };
  } catch (err: any) {
    return {
      name: flow.name,
      category: "User Flows",
      status: "fail",
      durationMs: Date.now() - t0,
      message: err?.name === "AbortError" ? "Timed out / aborted" : err?.message || String(err),
    };
  }
}

export async function* runSyntheticUserTest(
  originBase: string,
  signal?: AbortSignal,
): AsyncGenerator<SelfTestEvent> {
  const results: TestResult[] = [];
  const startedAt = Date.now();

  for (const flow of FLOWS) {
    if (signal?.aborted) {
      yield { type: "log", data: { message: `Aborted before "${flow.name}". Stopping.` } };
      break;
    }
    yield { type: "start", data: { name: flow.name, category: "User Flows" } };
    const result = await runFlow(flow, originBase, signal);
    results.push(result);
    yield { type: "result", data: result };
  }

  yield {
    type: "summary",
    data: {
      totalTests: results.length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
      skipped: results.filter((r) => r.status === "skip").length,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || "development",
      results,
    },
  };
}
