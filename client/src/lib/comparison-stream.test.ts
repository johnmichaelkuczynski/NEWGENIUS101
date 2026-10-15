import assert from "node:assert/strict";
import test from "node:test";
import { readComparisonStream } from "./comparison-stream";

const encode = (text: string) => new TextEncoder().encode(text);
const content = (text: string) => `data: ${JSON.stringify({ content: text })}\n\n`;

function controlled() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(stream) { controller = stream; },
  }));
  return { response, send: (text: string) => controller.enqueue(encode(text)), close: () => controller.close() };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("both thinkers update independently before either completes; finishing one does not stop the other", async () => {
  const left = controlled();
  const right = controlled();
  const updates1: string[] = [];
  const updates2: string[] = [];
  const result1 = readComparisonStream(left.response, (text) => updates1.push(text));
  const result2 = readComparisonStream(right.response, (text) => updates2.push(text));
  left.send(content("Kuczynski: "));
  right.send(content("Leibniz: "));
  await tick();
  assert.deepEqual(updates1, ["Kuczynski: "]);
  assert.deepEqual(updates2, ["Leibniz: "]);
  left.send(content("first answer.") + "data: [DONE]\n\n");
  assert.equal(await result1, "Kuczynski: first answer.");
  right.send(content("still streaming."));
  await tick();
  assert.equal(updates2.at(-1), "Leibniz: still streaming.");
  right.send("data: [DONE]\n\n");
  assert.equal(await result2, "Leibniz: still streaming.");
});

test("arbitrary byte and line boundaries preserve UTF-8, metadata is ignored, final unterminated line is processed", async () => {
  const bytes = encode('data: {"auditEvent":{"type":"status"}}\r\n\r\n' + content("Leibniz’s pensée.") + "data:[DONE]");
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  }));
  assert.equal(await readComparisonStream(response, () => {}), "Leibniz’s pensée.");
});

test("a server error is not swallowed, partial text remains available, and the other thinker completes", async () => {
  const partial: string[] = [];
  const failed = new Response(content("Retained text.") + 'data: {"error":"Provider unavailable"}\n\n');
  const good = new Response(content("Other thinker completed.") + "data: [DONE]\n\n");
  const [one, two] = await Promise.allSettled([
    readComparisonStream(failed, (text) => partial.push(text)),
    readComparisonStream(good, () => {}),
  ]);
  assert.equal(one.status, "rejected");
  if (one.status === "rejected") assert.match(one.reason.message, /Provider unavailable/);
  assert.deepEqual(partial, ["Retained text."]);
  assert.deepEqual(two, { status: "fulfilled", value: "Other thinker completed." });
});

test("an unexpected disconnect cannot be called a successful answer", async () => {
  const updates: string[] = [];
  await assert.rejects(readComparisonStream(new Response(content("Partial.")), (text) => updates.push(text)), /interrupted/);
  assert.deepEqual(updates, ["Partial."]);
});

test("legacy coherence completion is visible and blank completion fails explicitly", async () => {
  const response = new Response('data: {"coherenceEvent":{"type":"complete","data":{"output":"Legacy answer."}}}\n\ndata: [DONE]\n\n');
  assert.equal(await readComparisonStream(response, () => {}), "Legacy answer.");
  await assert.rejects(readComparisonStream(new Response("data: [DONE]\n\n"), () => {}), /no answer/);
});
