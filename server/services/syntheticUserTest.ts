import { TestResult, SelfTestEvent } from "./selfTest";

// Drives the same HTTP routes as the browser. This is deliberately an
// application-level test: provider probes alone cannot prove that a feature works.

type ExpectedResponse = "stream-or-json" | "json" | "binary";

interface DriveResult {
  text: string;
  json?: any;
  bytes: number;
  events: number;
  httpStatus: number;
  contentType: string;
  completionMarker: boolean;
  streamEnded: boolean;
  errorEvent?: string;
}

interface Flow {
  name: string;
  category: "Session & Data" | "Chats" | "Generators" | "Voice";
  method?: "GET" | "POST";
  path: string;
  body?: any;
  timeoutMs: number;
  expected?: ExpectedResponse;
  minChars?: number;
  minBytes?: number;
  validate?: (result: DriveResult) => string | void;
}

class CookieJar {
  private cookies = new Map<string, string>();

  get header(): string {
    return Array.from(this.cookies.entries()).map(([key, value]) => `${key}=${value}`).join("; ");
  }

  absorb(response: Response): void {
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) return;
    // The app currently sets one session cookie. This parser intentionally keeps
    // only cookie name/value pairs and never exposes them in diagnostic output.
    for (const cookie of setCookie.split(/,(?=[^;,]+=)/)) {
      const pair = cookie.split(";", 1)[0]?.trim();
      const separator = pair?.indexOf("=") ?? -1;
      if (separator > 0) {
        this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
  }
}

const CONTENT_KEYS = ["content", "token", "delta", "text", "chunk", "answer"];
const MIN_CHARS = 40;
const OUTPUT_PREVIEW_CHARS = 2000;

function normalizePreview(value: string, max = OUTPUT_PREVIEW_CHARS): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function extractJsonText(json: any): string {
  if (json === null || json === undefined) return "";
  if (typeof json === "string") return json;
  if (Array.isArray(json)) {
    const extracted = json
      .map((item) => {
        if (typeof item === "string") return item;
        return item?.text || item?.quote || item?.content || item?.position || item?.argument || item?.name || item?.id || "";
      })
      .filter(Boolean)
      .join("\n");
    return extracted || JSON.stringify(json);
  }

  for (const listKey of ["quotes", "positions", "arguments", "messages", "conversations", "figures"]) {
    if (Array.isArray(json[listKey])) {
      const extracted = extractJsonText(json[listKey]);
      return extracted || JSON.stringify(json[listKey]);
    }
  }

  for (const key of ["text", "content", "answer", "output"]) {
    if (typeof json[key] === "string") return json[key];
  }
  for (const key of ["result", "data", "conversation", "settings"]) {
    if (json[key] !== undefined) {
      const extracted = extractJsonText(json[key]);
      if (extracted) return extracted;
      return JSON.stringify(json[key]);
    }
  }
  return JSON.stringify(json);
}

function extractEventContent(event: any): string {
  const sources = [event, event?.data].filter((value) => value && typeof value === "object");
  for (const source of sources) {
    for (const key of CONTENT_KEYS) {
      if (typeof source[key] === "string") return source[key];
      if (key === "delta" && typeof source[key]?.text === "string") return source[key].text;
    }
  }
  return "";
}

function eventIsComplete(event: any): boolean {
  return Boolean(
    event?.done === true ||
    event?.complete === true ||
    event?.type === "done" ||
    event?.type === "complete" ||
    event?.type === "finished",
  );
}

async function drive(
  originBase: string,
  flow: Flow,
  jar: CookieJar,
  externalSignal?: AbortSignal,
): Promise<DriveResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), flow.timeoutMs);
  const onAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const headers: Record<string, string> = {};
    if (flow.body !== undefined) headers["Content-Type"] = "application/json";
    if (jar.header) headers.Cookie = jar.header;

    const response = await fetch(`${originBase}${flow.path}`, {
      method: flow.method || (flow.body === undefined ? "GET" : "POST"),
      headers,
      body: flow.body === undefined ? undefined : JSON.stringify(flow.body),
      signal: ctrl.signal,
      redirect: "manual",
    });
    jar.absorb(response);

    const contentType = response.headers.get("content-type") || "unknown";
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      let error = raw;
      try {
        const parsed = JSON.parse(raw);
        error = parsed?.error || parsed?.message || raw;
      } catch {}
      throw new Error(`HTTP ${response.status}${error ? `: ${normalizePreview(error, 500)}` : ""}`);
    }

    if (flow.expected === "binary" || contentType.startsWith("audio/")) {
      const bytes = (await response.arrayBuffer()).byteLength;
      return {
        text: "",
        bytes,
        events: 1,
        httpStatus: response.status,
        contentType,
        completionMarker: true,
        streamEnded: true,
      };
    }

    if (!contentType.includes("event-stream")) {
      const raw = await response.text();
      let json: any;
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
      const errorEvent = json?.error || (json?.success === false ? json?.message || "Request reported failure" : undefined);
      return {
        text: (json === undefined ? raw : extractJsonText(json)).trim(),
        json,
        bytes: Buffer.byteLength(raw),
        events: 1,
        httpStatus: response.status,
        contentType,
        completionMarker: true,
        streamEnded: true,
        errorEvent,
      };
    }

    if (!response.body) throw new Error("HTTP response had no stream body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let events = 0;
    let completionMarker = false;
    let streamEnded = false;
    let errorEvent: string | undefined;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        streamEnded = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        const dataLines = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") {
          completionMarker = true;
          continue;
        }
        try {
          const event = JSON.parse(payload);
          events++;
          if (typeof event?.error === "string") errorEvent = event.error;
          if (event?.type === "error" && typeof event?.message === "string") errorEvent = event.message;
          const content = extractEventContent(event);
          if (content) text += content;
          if (eventIsComplete(event)) completionMarker = true;
        } catch {
          // Keepalive and non-JSON status events are not generated content.
        }
      }
    }

    return {
      text: text.trim(),
      bytes: Buffer.byteLength(text),
      events,
      httpStatus: response.status,
      contentType,
      completionMarker,
      streamEnded,
      errorEvent,
    };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

function requireJsonObject(result: DriveResult): string | void {
  if (!result.json || typeof result.json !== "object") return "Expected a JSON object";
}

function requireArray(result: DriveResult, key?: string, allowEmpty = true): string | void {
  const value = key ? result.json?.[key] : result.json;
  if (!Array.isArray(value)) return `Expected ${key ? `"${key}"` : "response"} to be an array`;
  if (!allowEmpty && value.length === 0) return `Expected ${key || "response"} to contain at least one item`;
}

const FLOWS: Flow[] = [
  {
    name: "Figures catalog",
    category: "Session & Data",
    path: "/api/figures",
    timeoutMs: 20000,
    expected: "json",
    minChars: 1,
    validate: (result) => requireArray(result, undefined, false),
  },
  {
    name: "Start fresh",
    category: "Session & Data",
    method: "POST",
    path: "/api/chat/new",
    body: {},
    timeoutMs: 20000,
    expected: "json",
    minChars: 1,
    validate: (result) => {
      if (!result.json?.conversation?.id) return "No new conversation id was returned";
    },
  },
  {
    name: "Persona settings",
    category: "Session & Data",
    path: "/api/persona-settings",
    timeoutMs: 20000,
    expected: "json",
    minChars: 1,
    validate: requireJsonObject,
  },
  {
    name: "Kuczynski main chat",
    category: "Chats",
    method: "POST",
    path: "/api/chat/stream",
    body: { message: "In one concise paragraph, explain the difference between freedom and autonomy." },
    timeoutMs: 300000,
  },
  {
    name: "Main chat persistence",
    category: "Session & Data",
    path: "/api/messages",
    timeoutMs: 20000,
    expected: "json",
    minChars: 1,
    validate: (result) => requireArray(result, undefined, false),
  },
  {
    name: "Chat history API",
    category: "Session & Data",
    path: "/api/chat-history",
    timeoutMs: 20000,
    expected: "json",
    minChars: 1,
    validate: (result) => requireArray(result, "conversations", true),
  },
  {
    name: "Thinker chat",
    category: "Chats",
    method: "POST",
    path: "/api/figures/freud/chat",
    body: {
      message: "In one concise paragraph, what does the term 'the id' refer to?",
      settings: {
        responseLength: 150,
        quoteFrequency: 0,
        selectedModel: "zhi5",
        enhancedMode: false,
        intensityLevel: 30,
        dialogueMode: true,
      },
    },
    timeoutMs: 300000,
  },
  {
    name: "Paper Writer (1,000 words, 20 quotes)",
    category: "Generators",
    method: "POST",
    path: "/api/figures/confucius/write-paper",
    body: {
      topic: "How is the Confucian conception of justice different from Western thought?",
      wordLength: 1000,
      numberOfQuotes: 20,
    },
    timeoutMs: 300000,
    minChars: 1000,
    validate: (result) => {
      const [body, appendix = ""] = result.text.split(/\n#{1,3}\s+Direct Quotations(?: Used)?\b/i);
      const bodyWords = body.split(/\s+/).filter(Boolean).length;
      if (bodyWords !== 1000) {
        return `Paper returned ${bodyWords} body words instead of exactly 1,000`;
      }
      if (!/[.!?]['”)\]]*$/.test(body.trim())) {
        return "Paper body ends mid-sentence";
      }
      const listedQuotes = Array.from(
        appendix.matchAll(/^\d+\.\s+“(.+)”\s*$/gm),
        (match) => match[1],
      );
      if (listedQuotes.length !== 20) {
        return `Paper returned ${listedQuotes.length} listed quotations instead of exactly 20`;
      }
      const unusedQuotes = listedQuotes.filter((quote) => {
        return body.split(`“${quote}”`).length - 1 !== 1;
      });
      if (unusedQuotes.length > 0) {
        return `${unusedQuotes.length} listed quotations were not used exactly once in the paper body`;
      }
      const malformedQuotes = listedQuotes.filter(
        (quote) =>
          !/^[A-Z0-9“‘'[(]/.test(quote)
          || !/[.!?][”’'")\]]*$/.test(quote)
          || /(?:\.{3}|…|\d[A-Za-z]|[a-z][A-Z]|thedistinction|theproperty)/.test(quote),
      );
      if (malformedQuotes.length > 0) {
        return `${malformedQuotes.length} quotations were incomplete or contained source-text corruption`;
      }
      const mechanicalLanguage =
        /\b(?:I use|this passage|this quotation|this quote|the quotation|the quote|direct evidence|paper's central claim|philosophical distinction at issue)\b/i;
      if (mechanicalLanguage.test(body)) {
        return "Paper contains mechanical quotation meta-commentary";
      }
      const narratorBody = listedQuotes.reduce(
        (content, quote) => content.replace(`“${quote}”`, ""),
        body,
      );
      if (/\bConfucius(?:['’]s)?\b/.test(narratorBody)) {
        return "Paper breaks first-person thinker voice";
      }
      const incompleteIntegrations = listedQuotes.filter((quote) => {
        const quoted = `“${quote}”`;
        const quoteIndex = body.indexOf(quoted);
        if (quoteIndex < 0) return true;
        const before = body.slice(0, quoteIndex).trimEnd();
        const after = body.slice(quoteIndex + quoted.length).trimStart();
        return (
          (before.length > 0 && !/[:.!?]$/.test(before))
          || (after.length > 0 && !/^[A-Z0-9“‘'"[(]/.test(after))
        );
      });
      if (incompleteIntegrations.length > 0) {
        return `${incompleteIntegrations.length} complete-sentence quotations were embedded as clause fragments`;
      }
      const quoteTokens = (quote: string) => new Set(
        quote
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .split(/\s+/)
          .filter((word) => word.length >= 4),
      );
      for (let leftIndex = 0; leftIndex < listedQuotes.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < listedQuotes.length; rightIndex++) {
          const leftTokens = quoteTokens(listedQuotes[leftIndex]);
          const rightTokens = quoteTokens(listedQuotes[rightIndex]);
          if (leftTokens.size === 0 || rightTokens.size === 0) continue;
          const overlap = Array.from(leftTokens).filter((token) =>
            rightTokens.has(token),
          ).length;
          if (overlap / Math.min(leftTokens.size, rightTokens.size) >= 0.72) {
            return "Paper contains near-duplicate quotations";
          }
        }
      }
      const speakerLines = body.match(/^\s*(?:Speaker\s+\d+|[A-Z][A-Z .'-]{2,30}):/gim) || [];
      if (speakerLines.length >= 3) return "Paper output is dialogue/speaker formatted instead of normal prose";
    },
  },
  {
    name: "Long-form Essay",
    category: "Generators",
    method: "POST",
    path: "/api/figures/aristotle/long-form",
    body: { topic: "the nature of virtue", mode: "essay", wordLength: 300 },
    timeoutMs: 300000,
    minChars: 200,
  },
  {
    name: "Model Builder",
    category: "Generators",
    method: "POST",
    path: "/api/model-builder",
    body: {
      originalText: "All men are mortal. Socrates is a man. Therefore Socrates is mortal.",
      formalMode: false,
      entireTextMode: true,
    },
    timeoutMs: 180000,
  },
  {
    name: "Quote Generator",
    category: "Generators",
    method: "POST",
    path: "/api/quotes/generate",
    body: { query: "freedom and the will", author: "Nietzsche", numQuotes: 3 },
    timeoutMs: 120000,
  },
  {
    name: "Position Generator",
    category: "Generators",
    method: "POST",
    path: "/api/positions/generate",
    body: { thinker: "Friedrich Nietzsche", topic: "freedom", numPositions: 5 },
    timeoutMs: 180000,
  },
  {
    name: "Argument Generator",
    category: "Generators",
    method: "POST",
    path: "/api/arguments/generate",
    body: { thinker: "Immanuel Kant", keywords: "freedom", numArguments: 3 },
    timeoutMs: 180000,
  },
  {
    name: "Dialogue Creator",
    category: "Generators",
    method: "POST",
    path: "/api/dialogue-creator",
    body: {
      text: "the meaning of justice",
      authorId1: "plato",
      authorId2: "aristotle",
      wordLength: 150,
      quoteCount: 0,
    },
    timeoutMs: 240000,
  },
  {
    name: "Interview Creator",
    category: "Generators",
    method: "POST",
    path: "/api/interview-creator",
    body: {
      thinkerId: "kant",
      mode: "casual",
      interviewerTone: "curious",
      wordLength: 150,
      topic: "the categorical imperative",
    },
    timeoutMs: 240000,
  },
  {
    name: "Debate Creator",
    category: "Generators",
    method: "POST",
    path: "/api/debate/generate",
    body: { thinker1Id: "hume", thinker2Id: "kant", mode: "auto", wordLength: 250 },
    timeoutMs: 300000,
  },
  {
    name: "ElevenLabs MP3",
    category: "Voice",
    method: "POST",
    path: "/api/tts/convert",
    body: {
      text: "Speaker 1: Freedom requires responsibility.\nSpeaker 2: Responsibility also requires choice.",
      format: "mp3",
    },
    timeoutMs: 120000,
    expected: "binary",
    minBytes: 1000,
  },
];

async function runFlow(
  flow: Flow,
  originBase: string,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<TestResult> {
  const startedAt = Date.now();
  const method = flow.method || (flow.body === undefined ? "GET" : "POST");

  try {
    const result = await drive(originBase, flow, jar, signal);
    const words = result.text ? result.text.split(/\s+/).filter(Boolean).length : 0;
    const details = {
      method,
      endpoint: flow.path,
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      completionMarker: result.completionMarker,
      streamEnded: result.streamEnded,
      events: result.events,
      words,
      chars: result.text.length,
      bytes: result.bytes,
      outputPreview: normalizePreview(result.text),
      error: result.errorEvent,
    };

    if (result.errorEvent) {
      return {
        name: flow.name,
        category: flow.category,
        status: "fail",
        durationMs: Date.now() - startedAt,
        message: `Endpoint reported an error: ${result.errorEvent}`,
        details,
      };
    }

    if (!result.streamEnded) {
      return {
        name: flow.name,
        category: flow.category,
        status: "fail",
        durationMs: Date.now() - startedAt,
        message: "Response did not finish cleanly",
        details,
      };
    }

    if (flow.expected === "binary") {
      if (result.bytes < (flow.minBytes || 1)) {
        return {
          name: flow.name,
          category: flow.category,
          status: "fail",
          durationMs: Date.now() - startedAt,
          message: `Audio response was too small (${result.bytes} bytes)`,
          details,
        };
      }
    } else if (result.text.length < (flow.minChars ?? MIN_CHARS)) {
      return {
        name: flow.name,
        category: flow.category,
        status: "fail",
        durationMs: Date.now() - startedAt,
        message: `Returned almost no content (${result.text.length} chars)`,
        details,
      };
    }

    const validationError = flow.validate?.(result);
    if (validationError) {
      return {
        name: flow.name,
        category: flow.category,
        status: "fail",
        durationMs: Date.now() - startedAt,
        message: validationError,
        details,
      };
    }

    return {
      name: flow.name,
      category: flow.category,
      status: "pass",
      durationMs: Date.now() - startedAt,
      message:
        flow.expected === "binary"
          ? `Generated ${result.bytes.toLocaleString()} bytes of ${result.contentType} audio`
          : `HTTP ${result.httpStatus}; completed with ${words} words and ${result.text.length} characters`,
      details,
    };
  } catch (error: any) {
    return {
      name: flow.name,
      category: flow.category,
      status: "fail",
      durationMs: Date.now() - startedAt,
      message: error?.name === "AbortError" ? `Timed out after ${flow.timeoutMs}ms` : error?.message || String(error),
      details: { method, endpoint: flow.path },
    };
  }
}

export async function runSyntheticUserFlowByName(
  flowName: string,
  originBase: string,
  signal?: AbortSignal,
) {
  const flow = FLOWS.find((candidate) => candidate.name === flowName);
  if (!flow) {
    throw new Error(`Unknown synthetic-user flow: ${flowName}`);
  }
  return runFlow(flow, originBase, new CookieJar(), signal);
}

export async function* runSyntheticUserTest(
  originBase: string,
  signal?: AbortSignal,
): AsyncGenerator<SelfTestEvent> {
  const results: TestResult[] = [];
  const startedAt = Date.now();
  const jar = new CookieJar();
  const sequentialFlows = FLOWS.slice(0, 6);

  // These establish and then verify one browser-like session. Keep them ordered.
  for (const flow of sequentialFlows) {
    if (signal?.aborted) {
      yield { type: "log", data: { message: `Aborted before "${flow.name}". Stopping.` } };
      break;
    }
    yield {
      type: "log",
      data: { message: `${flow.method || (flow.body === undefined ? "GET" : "POST")} ${flow.path}` },
    };
    yield { type: "start", data: { name: flow.name, category: flow.category } };
    const result = await runFlow(flow, originBase, jar, signal);
    results.push(result);
    yield { type: "result", data: result };
  }

  // The remaining generators do not depend on one another. Running four at a
  // time keeps the diagnostic representative without serializing an hour of AI work.
  const concurrentFlows = signal?.aborted ? [] : FLOWS.slice(sequentialFlows.length);
  const pending = new Map<number, Promise<{ index: number; result: TestResult }>>();
  let nextIndex = 0;

  while ((nextIndex < concurrentFlows.length || pending.size > 0) && !signal?.aborted) {
    while (nextIndex < concurrentFlows.length && pending.size < 4) {
      const index = nextIndex++;
      const flow = concurrentFlows[index];
      yield {
        type: "log",
        data: { message: `${flow.method || (flow.body === undefined ? "GET" : "POST")} ${flow.path}` },
      };
      yield { type: "start", data: { name: flow.name, category: flow.category } };
      pending.set(
        index,
        runFlow(flow, originBase, jar, signal).then((result) => ({ index, result })),
      );
    }

    if (pending.size === 0) break;
    const completed = await Promise.race(pending.values());
    pending.delete(completed.index);
    results.push(completed.result);
    yield { type: "result", data: completed.result };
  }

  if (signal?.aborted && pending.size > 0) {
    await Promise.allSettled(pending.values());
  }

  yield {
    type: "summary",
    data: {
      totalTests: results.length,
      passed: results.filter((result) => result.status === "pass").length,
      failed: results.filter((result) => result.status === "fail").length,
      skipped: results.filter((result) => result.status === "skip").length,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || "development",
      results,
    },
  };
}