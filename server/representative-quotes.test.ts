import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRepresentativeQuotes, isCompleteRepresentativeQuote, selectRepresentativeQuotes } from "./representative-quotes";

test("rejects the reported mid-sentence opening and truncated ending", () => {
  assert.equal(isCompleteRepresentativeQuote("especially when he is credited with it by people whom he thinks good judges."), false);
  assert.equal(isCompleteRepresentativeQuote("Especially when he is credited with it by people whom he thinks good judges."), false);
  assert.equal(isCompleteRepresentativeQuote("Further, everything that changes must be divisible. For since every change is from something to something, and when it is at the goal of its change it is no longer changing"), false);
});

test("rejects cross-references and publishing boilerplate rather than ranking them as wisdom", () => {
  for (const text of [
    "You will find further references to this in Chapter 12.",
    "The nature of knowledge is discussed in section IV.",
    "See also the discussion above.",
    "As noted above, the nature of knowledge requires further consideration.",
    "Project Gutenberg provides this book for the use of anyone anywhere.",
  ]) assert.equal(isCompleteRepresentativeQuote(text), false, text);
});

test("preserves complete multi-sentence passages and short maxims verbatim", () => {
  const passage = "Further, everything that changes must be divisible. For since every change is from something to something, it must be changing.";
  assert.equal(isCompleteRepresentativeQuote(passage), true);
  assert.equal(isCompleteRepresentativeQuote("Misfortune tests the sincerity of friends."), true);
  assert.equal(isCompleteRepresentativeQuote("“Knowledge is power.”"), true);
  const [selected] = selectRepresentativeQuotes([{ quote: passage, source: "Physics" }], 10);
  assert.equal(selected.quote, passage);
  assert.equal(selected.source, "Physics");
});

test("prefers substantive statements, deduplicates, and never pads with fragments", () => {
  const significant = "Knowledge is not simply a collection of observations, because reasoning is required to establish their relations.";
  const rows = [
    { quote: "The door was open." }, { quote: significant }, { quote: significant },
    { quote: "especially when the mind is credited with knowledge." },
  ];
  assert.equal(selectRepresentativeQuotes(rows, 10)[0].quote, significant);
  assert.equal(selectRepresentativeQuotes(rows, 10).length, 2);
  assert.deepEqual(selectRepresentativeQuotes(rows, 10, "knowledge").map(row => row.quote), [significant]);
  assert.deepEqual(selectRepresentativeQuotes(rows, 10, "unmatched topic"), []);
});

test("document extraction retains original punctuation and excludes clipped boundaries", () => {
  const sentence = "Knowledge is not simply a collection of observations, because reasoning is required to establish their relations.";
  const document = `especially when he is credited with it by people whom he thinks good judges.\n\n${sentence}\n\nYou will find further references to this in Chapter 12.\n\nThe purpose of the state is not mere life, but a good life`;
  const result = extractRepresentativeQuotes(document, 10);
  assert.deepEqual(result.map(row => row.quote), [sentence]);
  assert.ok(document.includes(result[0].quote));
});

test("prefers editorially reviewed source quotations to incidental excerpts", () => {
  const reviewed = { quote: "Music has a power of forming the character, and should therefore be introduced into the education of the young.", reviewed: true };
  const incidental = { quote: "The nature of knowledge and thought is considered in relation to mind, reason, experience, truth, and science." };
  assert.deepEqual(selectRepresentativeQuotes([incidental, reviewed], 1), [reviewed]);
  assert.equal(isCompleteRepresentativeQuote("The nature of knowledge is important (<< back)."), false);
});
