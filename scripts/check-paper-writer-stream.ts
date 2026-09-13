import assert from "node:assert/strict";
import { createPaperSseParser } from "../client/src/lib/paper-sse";

const figureId = process.env.PAPER_STREAM_FIGURE_ID || "hume";
const firstContentLimitMs = Number(process.env.PAPER_FIRST_CONTENT_LIMIT_MS || 90_000);
const requestLimitMs = Number(process.env.PAPER_STREAM_REQUEST_LIMIT_MS || 12 * 60_000);
const devDomain = process.env.REPLIT_DEV_DOMAIN;

if (!devDomain) {
  throw new Error("REPLIT_DEV_DOMAIN is required; this check must use Replit's proxied development URL");
}
if (!Number.isFinite(firstContentLimitMs) || firstContentLimitMs <= 0) {
  throw new Error("PAPER_FIRST_CONTENT_LIMIT_MS must be a positive number");
}

const url = `https://${devDomain}/api/figures/${encodeURIComponent(figureId)}/write-paper`;
const startedAt = performance.now();
const controller = new AbortController();
const requestTimer = setTimeout(() => controller.abort(), requestLimitMs);

let firstContentAt: number | undefined;
let draftContent = "";
let finalContent = "";
let sawReset = false;
let sawDone = false;

try {
  console.log(`Checking Paper Writer SSE through ${new URL(url).origin}`);
  console.log(`First content must arrive within ${firstContentLimitMs}ms`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      topic: "Explain how causal reasoning depends on experience.",
      wordLength: 500,
      numberOfQuotes: 0,
    }),
    signal: controller.signal,
  });

  assert.equal(response.ok, true, `Request failed with HTTP ${response.status}`);
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream\b/);
  assert.ok(response.body, "Response did not include a readable stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createPaperSseParser();

  const consume = (text: string, finished = false) => {
    const events = finished ? parser.finish() : parser.push(text);
    for (const event of events) {
      if (event.type === "error") throw new Error(`Paper Writer returned an error: ${event.message}`);
      if (event.type === "reset") {
        assert.ok(draftContent.trim(), "reset_content arrived before any draft content");
        assert.equal(sawReset, false, "reset_content arrived more than once");
        sawReset = true;
      } else if (event.type === "content") {
        if (firstContentAt === undefined) {
          firstContentAt = performance.now();
          const elapsed = firstContentAt - startedAt;
          assert.ok(
            elapsed <= firstContentLimitMs,
            `First content arrived after ${Math.round(elapsed)}ms (limit ${firstContentLimitMs}ms)`,
          );
          console.log(`First content arrived after ${Math.round(elapsed)}ms`);
        }
        if (sawReset) finalContent += event.content;
        else draftContent += event.content;
      } else if (event.type === "done") {
        sawDone = true;
      }
    }
  };

  while (!sawDone) {
    const { done, value } = await reader.read();
    if (done) break;
    consume(decoder.decode(value, { stream: true }));
  }
  consume(decoder.decode(), true);

  assert.ok(firstContentAt !== undefined, "Stream ended without a content event");
  assert.ok(draftContent.trim(), "No draft content arrived before reset_content");
  assert.equal(sawReset, true, "Stream ended without reset_content");
  assert.ok(finalContent.trim(), "No validated final content arrived after reset_content");
  assert.equal(sawDone, true, "Stream ended without data: [DONE]");

  console.log(
    `PASS: draft (${draftContent.length} chars), reset_content, validated final (${finalContent.length} chars), [DONE]`,
  );
} finally {
  clearTimeout(requestTimer);
}