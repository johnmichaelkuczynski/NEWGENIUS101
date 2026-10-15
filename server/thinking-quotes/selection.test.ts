import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  corpusThinkerId, normalizeWithOffsets, prepareQuotationText,
  quotationScore, selectQuotations, sourceCandidates, isStandaloneQuotation,
} from "./selection";

test("author aliases are exact and never conflate William James and James Allen", () => {
  assert.equal(corpusThinkerId("allen"), "jamesallen");
  assert.equal(corpusThinkerId("james"), "james");
  assert.equal(corpusThinkerId("le_bon"), "lebon");
  assert.equal(corpusThinkerId("la_rochefoucauld"), "larouchefoucauld");
});

test("PDF whitespace normalization maps back to exact original character spans", () => {
  const raw = " \r\nKnowledge \r\n is \n\n not\t\tobservation. \nNext.";
  const normalized = normalizeWithOffsets(raw);
  const expected = "Knowledge is not observation.";
  const start = normalized.text.indexOf(expected);
  assert.equal(prepareQuotationText(raw.slice(
    normalized.rawOffset(start), normalized.rawOffset(start + expected.length),
  )), expected);
});

test("complete source sentences retain punctuation and original offsets", () => {
  const quotation = "Knowledge is not simply a collection of observations, because reasoning is required to establish the relations between them.";
  const raw = quotation.split(" ").join(" \r\n") + " \r\nAnother sentence.";
  const candidates = sourceCandidates({ id: "a", title: "A source", file: null, kind: "database-text", content: raw }, new Set());
  const match = candidates.find(item => item.text === quotation);
  assert.ok(match);
  assert.equal(prepareQuotationText(raw.slice(match.startOffset, match.endOffset)), quotation);
});

test("editorial screening rejects headings, snippets, and generated thinking filler", () => {
  for (const text of [
    "Consider the implications of this position...",
    "Let us reason through this systematically...",
    "Project Gutenberg provides this book for educational use and the knowledge of all people.",
    "This requires careful conceptual analysis...",
    "These ideas are discussed in the preceding section on knowledge and understanding.",
    "a fragment of knowledge and a further discussion of the reason for its importance",
  ]) assert.equal(quotationScore(text), null);
});

test("standalone screening rejects deictic examples without excluding short real maxims", () => {
  assert.equal(isStandaloneQuotation("But he can compatibilize the thought of his being a lawyer with the rest of his mind."), false);
  assert.equal(isStandaloneQuotation('If you say “Larry is a bad man,” your statement concerns Larry’s character.'), false);
  assert.equal(isStandaloneQuotation("Also, it seems to apply to the term intelligent."), false);
  assert.equal(isStandaloneQuotation("Misfortune tests the sincerity of friends."), true);
  assert.equal(isStandaloneQuotation("Self-help is the best help."), true);
});

test("selection removes duplicates, preserves source evidence, and never pads a quota", () => {
  const item = {
    text: "A source quotation.", sourceId: "a", sourceTitle: "Source", sourceFile: null,
    sourceKind: "database-text" as const, startOffset: 0, endOffset: 19, score: 10,
  };
  const selected = selectQuotations([item, { ...item, sourceId: "b" }], 100);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sourceId, "a");
  assert.ok(!("score" in selected[0]));
});
