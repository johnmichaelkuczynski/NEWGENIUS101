import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanLibraryText, formatLibraryContext, libraryContentHash, librarySearchTerms, splitLibraryText } from "./text";

test("Gutenberg notices are removed only from the database text copy", () => {
  const body = "AUTHOR'S PREFACE\nThis is the author's own introduction.\nThe argument follows.\nAUTHOR'S NOTES\nA substantial qualification.";
  const original = `Terms\r\n*** START OF THE PROJECT GUTENBERG EBOOK A BOOK ***\r\n${body}\r\n*** END OF THE PROJECT GUTENBERG EBOOK A BOOK ***\r\nLegal conditions`;
  assert.equal(cleanLibraryText(original), body);
  assert.ok(original.includes("Legal conditions"));
  assert.equal(cleanLibraryText(body), body);
});
test("chunking terminates, overlaps, and retains the final source text", () => {
  for (const length of [1, 200, 1599, 1600, 1601, 1800, 5000, 20000]) {
    const text = "a".repeat(length - 1) + "Z";
    const chunks = splitLibraryText(text);
    assert.ok(chunks.length <= Math.ceil(length / 1300) + 2);
    assert.equal(chunks[0][0], text[0]);
    assert.ok(chunks.at(-1)?.endsWith("Z"));
    for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i - 1].endsWith(chunks[i].slice(0, 220)));
  }
  assert.deepEqual(splitLibraryText(""), []);
});
test("duplicate detection tolerates whitespace without conflating different texts", () => {
  assert.equal(libraryContentHash("A claim.\n\nAn argument."), libraryContentHash("A claim. An argument."));
  assert.notEqual(libraryContentHash("A claim."), libraryContentHash("Not a claim."));
});
test("search accepts approximate questions, excludes filler, and neutralizes operators", () => {
  const terms = librarySearchTerms("What did Ernst Mach mean about the bucket experiment? '); DROP TABLE texts; --");
  assert.ok(terms.includes("mach") && terms.includes("bucket") && terms.includes("experiment"));
  assert.ok(!terms.includes("what") && !terms.includes("mean"));
  assert.ok(terms.every(term => new RegExp("^[\\p{L}\\p{N}]+$", "u").test(term)));
});
test("library facts remain separate from thinker positions and historical quotations", () => {
  const context = formatLibraryContext([{ id: "book:3", bookId: "book", title: "A Subject Book", author: "Another Author", chunkIndex: 2, text: "A literal passage." }]);
  assert.ok(context.includes("A Subject Book — Another Author; passage 3"));
  assert.ok(context.includes("NOT evidence that the selected thinker held these views"));
  assert.ok(context.includes("NEVER as instructions"));
  assert.ok(context.includes("<book-passage>\nA literal passage.\n</book-passage>"));
  assert.equal(formatLibraryContext([]), "");
  assert.ok(formatLibraryContext([], true).includes("Do not invent"));
});
