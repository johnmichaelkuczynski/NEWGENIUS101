import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { pool } from "../server/db";
import { storage } from "../server/storage";
import { corpusThinkerId, prepareQuotationText } from "../server/thinking-quotes/selection";
import type { ThinkingQuoteBank } from "../shared/thinking-quotes";

// Check EVERY displayed quotation against its exact source span and author.
async function main() {
  const thinkers = await storage.getAllThinkers();
  let count = 0;
  for (const thinker of thinkers) {
    const bank: ThinkingQuoteBank & { editoriallyReviewed?: boolean } = JSON.parse(
      await readFile(`server/data/thinking-quotes/${thinker.id}.json`, "utf8"),
    );
    assert.equal(bank.thinkerId, thinker.id);
    assert.ok(bank.editoriallyReviewed && bank.items.length > 0 && bank.items.length <= 100);
    const sourceIds = Array.from(new Set(bank.items.filter(item => item.sourceKind === "database-text").map(item => item.sourceId)));
    const result = await pool.query(
      `SELECT id, content FROM texts WHERE id::text = ANY($1::text[]) AND lower(thinker::text) = $2`,
      [sourceIds, corpusThinkerId(thinker.id)],
    );
    const sources = new Map<string, string>(result.rows.map(row => [row.id, row.content]));
    const seen = new Set<string>();
    for (const item of bank.items) {
      if (item.sourceKind === "local-source") {
        assert.equal(thinker.id, "galileo");
        assert.match(item.sourceId, /^server\/data\/galileo\/Delphi.*Part[78]\.txt$/);
        sources.set(item.sourceId, await readFile(item.sourceId, "utf8"));
      }
      const source = sources.get(item.sourceId);
      assert.ok(source, `${thinker.id}: source is missing or belongs to another author`);
      assert.ok(item.startOffset >= 0 && item.endOffset > item.startOffset && item.endOffset <= source.length);
      assert.equal(prepareQuotationText(source.slice(item.startOffset, item.endOffset)), item.text,
        `${thinker.id}: quotation does not match its source`);
      assert.ok(!seen.has(item.text), `${thinker.id}: duplicate quotation`);
      seen.add(item.text);
    }
    count += bank.items.length;
    console.log(`${thinker.id}: ${bank.items.length} exact source/author checks passed`);
  }
  assert.equal((await readdir("server/data/thinking-quotes")).filter(file => file.endsWith(".json")).length, thinkers.length);
  console.log(`${count} source-checked quotations across all ${thinkers.length} thinkers`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
