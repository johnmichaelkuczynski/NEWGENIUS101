import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanGutenberg, contentIdentity, importChunks } from "./author-import-utils";

test("removes Gutenberg wrapper without removing the author's preface or notes", () => {
  const body = "AUTHOR'S PREFACE\n\n" + "The author explains the nature of knowledge. ".repeat(15) + "\n\nAUTHOR'S NOTES\nAn important clarification.";
  const raw = "\uFEFFLicense notice\r\n*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\r\n" + body + "\r\n*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\r\nLegal terms";
  assert.equal(cleanGutenberg(raw), body);
});

test("handles partial wrappers and preserves originals", () => {
  const raw = "The Project Gutenb\n\nA philosophical work. ".repeat(1);
  assert.equal(cleanGutenberg(raw), "A philosophical work.");
  assert.ok(raw.startsWith("The Project Gutenb"));
  assert.equal(cleanGutenberg("A real work.\n\n*** END OF THE PROJECT GUTENBERG EBOOK TEST ***"), "A real work.");
});

test("chunking terminates at EOF, preserves the last passage, and is stable on retries", () => {
  const text = "Knowledge requires reasoning and experience. ".repeat(100) + "A final substantive passage about the nature of knowledge. ".repeat(5);
  const chunks = importChunks(text);
  assert.ok(chunks.length > 1 && chunks.length < 10);
  assert.ok(chunks.at(-1)!.endsWith("A final substantive passage about the nature of knowledge."));
  assert.deepEqual(importChunks(text), chunks);
  assert.deepEqual(importChunks(""), []);
});

test("same-content detection ignores typography and whitespace, not different words", () => {
  assert.equal(contentIdentity("Whewell’s ideas.\r\nKnowledge."), contentIdentity("Whewell's ideas. Knowledge."));
  assert.notEqual(contentIdentity("Knowledge requires experience."), contentIdentity("Knowledge excludes experience."));
});
