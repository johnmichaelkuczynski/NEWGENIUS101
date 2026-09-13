import assert from "node:assert/strict";
import test from "node:test";
import { createPaperSseParser, type PaperStreamEvent } from "./paper-sse";

function parseLikePaperWriterSection(chunks: string[]): PaperStreamEvent[] {
  const parser = createPaperSseParser();
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.finish()];
}

function parseLikeEmbeddedPaperWriter(chunks: string[]): PaperStreamEvent[] {
  const parser = createPaperSseParser();
  const events: PaperStreamEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.finish());
  return events;
}

const splitStream = [
  'data: {"status":"Generating"}\n\ndata: {"cont',
  'ent":"Draft words"}\n\ndata: {"reset_content":tr',
  'ue}\n\ndata: {"content":"Validated words"}\n\ndata: [DO',
  "NE]\n\n",
];

const expected: PaperStreamEvent[] = [
  { type: "metadata", data: { status: "Generating" } },
  { type: "content", content: "Draft words" },
  { type: "reset" },
  { type: "content", content: "Validated words" },
  { type: "done" },
];

test("PaperWriterSection parser preserves the draft-reset-final-DONE contract across chunks", () => {
  assert.deepEqual(parseLikePaperWriterSection(splitStream), expected);
});

test("embedded PaperWriter parser preserves the draft-reset-final-DONE contract across chunks", () => {
  assert.deepEqual(parseLikeEmbeddedPaperWriter(splitStream), expected);
});

test("parses a final event even when the stream ends without a trailing newline", () => {
  const parser = createPaperSseParser();
  assert.deepEqual(parser.push('data: {"content":"complete line"}'), []);
  assert.deepEqual(parser.finish(), [{ type: "content", content: "complete line" }]);
});