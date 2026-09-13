import assert from "node:assert/strict";
import test from "node:test";

process.env.EXTERNAL_DATABASE_URL ||= "postgresql://test:test@localhost/test";
process.env.OPENAI_API_KEY ||= "test";

const { ensureMinimumQuotes, normalized } = await import("./extract-grounded-material.ts");

const passages = [
  "The first principle is sufficiently substantial to qualify as diagnostic evidence.",
  "The second principle explains why careful reasoning must remain grounded in evidence.",
  "The third principle distinguishes a valid conclusion from an attractive invention.",
  "The fourth principle requires every quotation to preserve the author's exact language.",
  "The fifth principle makes sparse diagnostic evidence an explicit processing failure.",
  "The sixth principle is an invented candidate that does not occur anywhere in the source.",
];
const source = passages.slice(0, 5).join("\n\n");

test("quote-only recovery fills a sparse mixed extraction with exact, unique source passages", async () => {
  const quotes = [{ text: passages[0], topic: "existing" }];
  const existingQuotes = new Set([
    normalized(passages[0]),
    normalized(passages[1]),
  ]);
  let recoveryCalls = 0;
  let rejected = 0;

  await ensureMinimumQuotes({
    title: "Fixture",
    source,
    windows: [source],
    existingSourceQuoteCount: 1,
    quotes,
    existingQuotes,
    extract: async () => {
      recoveryCalls++;
      return [
        { text: passages[0], topic: "exact duplicate" },
        { text: passages[1].replaceAll(" ", "  "), topic: "normalized duplicate" },
        { text: passages[2], topic: "third" },
        { text: passages[3], topic: "fourth" },
        { text: passages[4], topic: "fifth" },
        { text: passages[5], topic: "fabricated" },
      ];
    },
    onRejected: () => rejected++,
  });

  assert.equal(recoveryCalls, 1);
  assert.equal(rejected, 1);
  assert.equal(1 + quotes.length, 5);
  assert.deepEqual(quotes.map((quote) => quote.text), [
    passages[0],
    passages[2],
    passages[3],
    passages[4],
  ]);
  for (const quote of quotes) assert.ok(source.includes(quote.text));
});

test("quote-only recovery is skipped when the source already has five quotations", async () => {
  let recoveryCalls = 0;
  await ensureMinimumQuotes({
    title: "Complete fixture",
    source,
    windows: [source],
    existingSourceQuoteCount: 5,
    quotes: [],
    existingQuotes: new Set(),
    extract: async () => {
      recoveryCalls++;
      return [];
    },
  });
  assert.equal(recoveryCalls, 0);
});

test("processing fails explicitly when recovery cannot reach five valid quotations", async () => {
  await assert.rejects(
    ensureMinimumQuotes({
      title: "Sparse fixture",
      source,
      windows: [source],
      existingSourceQuoteCount: 0,
      quotes: [],
      existingQuotes: new Set(),
      extract: async () => [
        { text: passages[0], topic: "only valid quote" },
        { text: passages[5], topic: "fabricated" },
      ],
    }),
    /has only 1 valid quotations after quote-only recovery; 5 are required/,
  );
});