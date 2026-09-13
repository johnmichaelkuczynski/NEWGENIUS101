import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "./ingest-drop-folder.ts";

interface TextRow {
  id: string;
  sourceFile: string;
  content: string;
}

function normalized(content: string) {
  return content.replace(/^\uFEFF/, "").replace(/\s+/g, "");
}

function createFakeDatabase() {
  const texts: TextRow[] = [];
  const chunks: Array<{ textId: string; index: number }> = [];

  const sqlClient = async (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?");
    if (query.includes("SELECT id") && query.includes("FROM texts")) {
      const [sourceFile, content] = values;
      return texts
        .filter((row) => row.sourceFile === sourceFile || normalized(row.content) === content)
        .slice(0, 1)
        .map(({ id }) => ({ id }));
    }
    if (query.includes("INSERT INTO texts")) {
      const [thinker, title, sourceFile, content] = values;
      assert.ok(thinker);
      assert.ok(title);
      const id = `text-${texts.length + 1}`;
      texts.push({ id, sourceFile, content });
      return [{ id }];
    }
    if (query.includes("INSERT INTO chunks")) {
      const [, textId, index] = values;
      chunks.push({ textId, index });
      return [];
    }
    if (query.includes("DELETE FROM texts")) {
      const index = texts.findIndex((row) => row.id === values[0]);
      if (index >= 0) texts.splice(index, 1);
      return [];
    }
    throw new Error(`Unexpected test query: ${query}`);
  };

  return { sqlClient, texts, chunks };
}

async function captureLogs(run: () => Promise<void>) {
  const messages: string[] = [];
  const original = console.log;
  console.log = (...args: any[]) => messages.push(args.join(" "));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return messages.join("\n");
}

test("author work remains visible and duplicate content never creates extra text or chunks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "author-ingest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const dropDir = path.join(root, "drop");
  const allAuthorWorksDir = path.join(root, "ALL_AUTHOR_WORKS");
  const authorDir = path.join(allAuthorWorksDir, "test-author");
  fs.mkdirSync(authorDir, { recursive: true });

  const fixturePath = path.join(authorDir, "Collected Works.txt");
  const content = `${"A complete philosophical argument. ".repeat(70)}\nConclusion follows from the evidence.`;
  fs.writeFileSync(fixturePath, content);

  const database = createFakeDatabase();
  const options = {
    ...database,
    dropDir,
    allAuthorWorksDir,
    embedText: async () => [0.1, 0.2, 0.3],
  };

  await main(options);
  assert.equal(fs.readFileSync(fixturePath, "utf8"), content, "the author-folder fixture must remain in place");
  assert.equal(database.texts.length, 1, "the first run creates one source text");
  assert.ok(database.chunks.length > 0, "the first run creates chunks");
  const firstChunkCount = database.chunks.length;

  const secondRunOutput = await captureLogs(() => main(options));
  assert.match(secondRunOutput, /skipped duplicate/);
  assert.equal(database.texts.length, 1, "a second run creates no additional text");
  assert.equal(database.chunks.length, firstChunkCount, "a second run creates no additional chunks");

  const whitespaceVariant = path.join(authorDir, "Whitespace Variant.txt");
  fs.writeFileSync(whitespaceVariant, `\uFEFF  ${content.replaceAll(" ", " \n\t")}`);
  const whitespaceOutput = await captureLogs(() => main({ ...options, onlyFile: "Whitespace Variant.txt" }));
  assert.match(whitespaceOutput, /skipped duplicate/);
  assert.equal(database.texts.length, 1, "normalized exact-content duplicate creates no text");
  assert.equal(database.chunks.length, firstChunkCount, "normalized exact-content duplicate creates no chunks");
  assert.ok(fs.existsSync(whitespaceVariant), "the duplicate author file must remain visible");
});
