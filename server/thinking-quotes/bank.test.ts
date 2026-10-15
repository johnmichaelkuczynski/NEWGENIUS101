import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { getThinkingQuoteBank } from "./bank";
import { isStandaloneQuotation } from "./selection";

test("each preassembled bank has only complete, distinct, source-located excerpts", async () => {
  const files = await readdir("server/data/thinking-quotes");
  assert.ok(files.length > 0);
  for (const file of files.filter(name => name.endsWith(".json"))) {
    const id = file.replace(/\.json$/, "");
    const bank = await getThinkingQuoteBank(id);
    assert.equal(bank.thinkerId, id);
    assert.ok(bank.items.length > 0 && bank.items.length <= 100);
    assert.equal(new Set(bank.items.map(item => item.text)).size, bank.items.length);
    for (const item of bank.items) {
      assert.ok(item.text && item.sourceId && item.sourceTitle);
      assert.ok(item.startOffset >= 0 && item.endOffset > item.startOffset);
      assert.ok(isStandaloneQuotation(item.text), `${id}: context-dependent example`);
      assert.ok(!/Consider the implications of this position|Let us reason through this systematically|The argument proceeds as follows/.test(item.text));
    }
  }
});

test("unknown authors and path traversal fail instead of borrowing another author's quotes", async () => {
  await assert.rejects(getThinkingQuoteBank("../kuczynski"));
  await assert.rejects(getThinkingQuoteBank("not_an_author"));
});

test("repeated access reuses the preassembled bank", async () => {
  assert.equal(await getThinkingQuoteBank("kuczynski"), await getThinkingQuoteBank("kuczynski"));
});
