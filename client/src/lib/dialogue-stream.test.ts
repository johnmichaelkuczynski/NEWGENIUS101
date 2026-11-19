import assert from "node:assert/strict";
import { test } from "node:test";
import { readDialogueStream } from "./dialogue-stream";
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
