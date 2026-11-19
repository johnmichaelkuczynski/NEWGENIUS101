import assert from "node:assert/strict";
import { test } from "node:test";
import { DialogueAccessError, readDialogueResponse, readDialogueStream } from "./dialogue-stream";
import type { PaperStreamEvent } from "./paper-sse";

function body(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(chunk));
      controller.close();
    },
  });
}
const encode = (text: string) => new TextEncoder().encode(text);

test("dialogue tokens survive every byte boundary, Unicode, heartbeats, and split completion", async () => {
  const bytes = encode(': keep-alive\n\ndata: {"status":"Retrieving sources"}\r\n\r\ndata: {"content":"LEIBNIZ: café — "}\n\ndata: {"content":"an argument."}\n\ndata: {"done":true,"wordCount":4}\n\ndata: [DONE]');
  const events: PaperStreamEvent[] = [];
  await readDialogueStream(body(Array.from(bytes, byte => new Uint8Array([byte]))), e => events.push(e));
  assert.equal(events.filter(e => e.type === "content").map(e => e.content).join(""), "LEIBNIZ: café — an argument.");
  assert.ok(events.some(e => e.type === "metadata" && e.data.done === true));
  assert.equal(events.at(-1)?.type, "done");
});

test("provider errors are surfaced instead of silently swallowed, with prior text intact", async () => {
  let partial = "";
  await assert.rejects(readDialogueStream(body([
    encode('data: {"content":"RUSSELL: The first premise."}\n\n'),
    encode('data: {"error":"Provider unavailable"}\n\n'),
  ]), e => { if (e.type === "content") partial += e.content; }), /Provider unavailable/);
  assert.equal(partial, "RUSSELL: The first premise.");
});

test("a disconnected stream does not invent completion or drop a final complete event", async () => {
  const events: PaperStreamEvent[] = [];
  await readDialogueStream(body([encode('data: {"content":"POINCARÉ: A partial answer."}')]), e => events.push(e));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "content");
  assert.ok(!events.some(e => e.type === "done"));
});

test("an explicit failure before any words remains a failure", async () => {
  await assert.rejects(readDialogueStream(body([encode('data: {"error":"Generation failed"}\n\n')]), () => {}), /Generation failed/);
});

for (const accessRequired of ["google_login", "payment"] as const) {
  for (const status of [200, accessRequired === "google_login" ? 401 : 402]) {
    test(`${accessRequired} JSON with HTTP ${status} is an access requirement, not an empty stream`, async () => {
      const events: PaperStreamEvent[] = [];
      await assert.rejects(
        readDialogueResponse(Response.json({
          accessRequired,
          message: "Your preview is complete.",
        }, { status }), e => events.push(e)),
        error => error instanceof DialogueAccessError
          && error.accessRequired === accessRequired
          && error.message === "Your preview is complete.",
      );
      assert.deepEqual(events, []);
    });
  }
}

test("JSON and HTTP errors retain meaningful error messages", async () => {
  await assert.rejects(
    readDialogueResponse(Response.json({ error: "Source extraction failed" }, { status: 400 }), () => {}),
    /Source extraction failed/,
  );
  await assert.rejects(
    readDialogueResponse(new Response("upstream unavailable", { status: 503 }), () => {}),
    /HTTP 503/,
  );
  await assert.rejects(
    readDialogueResponse(Response.json({ message: "Provider unavailable" }), () => {}),
    /Provider unavailable/,
  );
});

test("HTML, invalid JSON, and unexpected content types cannot silently become zero-word dialogues", async () => {
  await assert.rejects(
    readDialogueResponse(new Response("<html>not the API</html>", { headers: { "content-type": "text/html" } }), () => {}),
    /webpage instead of a dialogue stream/,
  );
  await assert.rejects(
    readDialogueResponse(new Response("{", { headers: { "content-type": "application/json" } }), () => {}),
    /unreadable dialogue response/,
  );
  await assert.rejects(readDialogueResponse(new Response("ok"), () => {}), /unexpected response/);
});

test("successful HTTP dialogue responses retain streamed tokens and completion", async () => {
  const events: PaperStreamEvent[] = [];
  await readDialogueResponse(new Response(body([
    encode('data: {"content":"FREUD: A complete sentence."}\n\n'),
    encode("data: [DONE]\n\n"),
  ]), { headers: { "content-type": "text/event-stream; charset=utf-8" } }), e => events.push(e));
  assert.equal(events[0].type, "content");
  assert.equal(events.at(-1)?.type, "done");
});

test("a status-only stream reports where generation stopped rather than pretending completion", async () => {
  await assert.rejects(
    readDialogueResponse(new Response(body([
      encode('data: {"status":"Retrieving sources for Freud…"}\n\n'),
      encode('data: [DONE]\n\n'),
    ]), { headers: { "content-type": "text/event-stream" } }), () => {}),
    /ended before any text arrived.*Retrieving sources for Freud/,
  );
});
