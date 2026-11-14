import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  getPreparedRepresentativeBank, pickPreparedQuotations, validatePreparedBank,
} from "./prepared-representative-quotes";

test("every site thinker has exactly 100 complete, distinct, source-located prepared quotations", async () => {
  const thinkers = (await readdir("server/data/thinking-quotes")).filter(name => name.endsWith(".json")).sort();
  const prepared = (await readdir("server/data/representative-quotes")).filter(name => name.endsWith(".json")).sort();
  assert.deepEqual(prepared, thinkers);
  for (const filename of thinkers) {
    const thinkerId = filename.replace(/\.json$/, "");
    const bank = await getPreparedRepresentativeBank(thinkerId);
    assert.equal(bank.items.length, 100);
    assert.equal(validatePreparedBank(bank, thinkerId), bank);
    const picks = pickPreparedQuotations(bank, 100);
    assert.equal(picks.length, 100);
    assert.equal(new Set(picks.map(item => item.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim())).size, 100);
    assert.ok(picks.every(item => bank.items.includes(item)));
  }
});

test("serves the requested number without modifying the cache or crossing authors", async () => {
  const bank = await getPreparedRepresentativeBank("aristotle");
  const original = JSON.stringify(bank);
  assert.equal(pickPreparedQuotations(bank, 7).length, 7);
  assert.equal(pickPreparedQuotations(bank, 200).length, 100);
  assert.equal(JSON.stringify(bank), original);
  assert.equal(await getPreparedRepresentativeBank("aristotle"), bank);
  await assert.rejects(getPreparedRepresentativeBank("../aristotle"));
  await assert.rejects(getPreparedRepresentativeBank("not_a_thinker"));
  assert.throws(() => validatePreparedBank({ thinkerId: "aristotle", items: bank.items.slice(0, 99) }, "aristotle"));
  assert.throws(() => validatePreparedBank(bank, "kant"));
});
