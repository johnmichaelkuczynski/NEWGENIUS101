import test from "node:test";
import assert from "node:assert/strict";
import {
  comparisonAuthorNames, comparisonTerms, validateComparisonBinding,
  comparisonAnswerRules, checkComparisonFidelity, hasStrengthenedDenial, selectUnindexedPassages, type ComparisonGrounding, type ComparisonSource,
} from "./comparison-grounding";

const source: ComparisonSource = {
  id: "primary-1", thinker: "freud", sourceId: "work-1", title: "Primary work", index: 8,
  text: "The alleged inference is not my conclusion. My argument distinguishes observed differences from the proposed cause.",
};
const grounding = {
  binding: "The author distinguishes observed differences from their proposed cause.",
  context: source.text, sources: [source],
  audit: { authorName: "Freud" },
} as ComparisonGrounding;

test("Dworkin's display name cannot exclude her actual database identity; author identities are exact", () => {
  assert.ok(comparisonAuthorNames("dworkin", "Andrea Dworkin").includes("dworkin"));
  assert.ok(comparisonAuthorNames("dworkin", "Andrea Dworkin").includes("andrea dworkin"));
  assert.ok(!comparisonAuthorNames("dworkin", "Andrea Dworkin").includes("ronald dworkin"));
  assert.ok(!comparisonAuthorNames("freud", "Freud").includes("jung"));
});
test("original subject terms survive author-vocabulary expansion", () => {
  const terms = comparisonTerms("DO WOMEN INHERENTLY HAVE DIFFERENT MORAL CODES FROM MEN?", "superego feminine conscience");
  for (const term of ["women", "moral", "codes", "men", "superego", "conscience"]) assert.ok(terms.includes(term));
  assert.ok(comparisonTerms("What is mathematical knowledge?", "a priori proof").includes("mathematical"));
});
test("saved works without chunk records yield exact, ranked passages with stable provenance", () => {
  const content = "Table of contents. ".repeat(400)
    + "The universal postulate is the ultimate test of a belief. ".repeat(160);
  const passages = selectUnindexedPassages([{ id: "spencer-work", thinker: "spencer", title: "Psychology", content }],
    ["universal", "postulate", "belief"]);
  assert.ok(passages.length > 0);
  assert.ok(passages[0].chunk_text.includes("universal postulate"));
  for (const passage of passages) {
    assert.equal(passage.thinker, "spencer");
    assert.equal(passage.source_text_id, "spencer-work");
    assert.equal(passage.chunk_text, content.slice(passage.chunk_index * 5000, passage.chunk_index * 5000 + 6500));
    assert.ok(passage.id.startsWith("text:spencer-work:"));
  }
  assert.equal(selectUnindexedPassages([{ id: "w", thinker: "a", title: "W", content: "Unrelated." }], ["postulate"]).length, 0);
});
test("a generic answer that omits the primary argument is a fidelity failure, even if its polarity agrees", async () => {
  const verdict = await checkComparisonFidelity("Kuczynski", "Are all contexts extensional?",
    "Yes, by ordinary logical convention.", grounding, async (system) => {
      assert.match(system, /omits the source's substantive argument/);
      assert.match(system, /verbatim passages outrank the synopsis/);
      return '{"faithful":false,"correction":"Explain the source distinction instead of replacing it with convention."}';
    });
  assert.equal(verdict.faithful, false);
});
test("source binding requires a real passage and exact substantive quotation", () => {
  const result = validateComparisonBinding({
    answer: grounding.binding,
    quotes: [{ passageId: source.id, text: "My argument distinguishes observed differences from the proposed cause." }],
  }, [source]);
  assert.equal(result.sources[0].id, source.id);
  assert.equal(result.quotes.length, 1);
  assert.throws(() => validateComparisonBinding({ answer: "A modern consensus.", quotes: [] }, [source]), /No verified/);
  assert.throws(() => validateComparisonBinding({
    answer: "Invented thesis.", quotes: [{ passageId: source.id, text: "There are absolutely no differences between women and men." }],
  }, [source]), /No verified/);
  assert.throws(() => validateComparisonBinding({
    answer: "Wrong identity.", quotes: [{ passageId: "other-author", text: source.text }],
  }, [source]), /No verified/);
});
test("each author's generation system gets its own binding thesis, not a generic fallback", () => {
  const prompt = comparisonAnswerRules("Freud", grounding);
  assert.ok(prompt.includes(grounding.binding));
  assert.ok(prompt.includes(source.text));
  assert.match(prompt, /NOT as a generic/);
  assert.match(prompt, /equality into sameness/);
  const other = comparisonAnswerRules("Dworkin", { ...grounding, binding: "Different source-derived argument.", context: "Other primary material." });
  assert.ok(!other.includes(grounding.binding));
});
test("post-stream fidelity check receives source evidence and rejects a reversed author thesis", async () => {
  const verdict = await checkComparisonFidelity("Freud", "Are there differences?", "There are no differences.", grounding,
    async (system, user) => {
      assert.match(system, /reversed theses/);
      assert.ok(user.includes(grounding.binding));
      assert.ok(user.includes(source.text));
      assert.ok(user.includes("There are no differences."));
      return '{"faithful":false,"correction":"Do not replace a distinction about causes with denial of differences."}';
    });
  assert.equal(verdict.faithful, false);
});
test("malformed fidelity checks cannot silently approve an answer", async () => {
  await assert.rejects(checkComparisonFidelity("Freud", "Question", "Answer", grounding,
    async () => '{"looksFine":true}'), /could not be completed/);
});
test("an invented stronger question cannot conceal the author's actual thesis", async () => {
  assert.equal(hasStrengthenedDenial("Are there differences?", "No. I do not posit entirely different moral codes."), true);
  assert.equal(hasStrengthenedDenial("Are there entirely different codes?", "No. They are not entirely different."), false);
  assert.equal(hasStrengthenedDenial("Are there differences?", "I posit differences in the formation of conscience."), false);
  const verdict = await checkComparisonFidelity("Freud", "Are there differences?",
    "No. I do not posit entirely different moral codes.", grounding,
    async () => { throw new Error("The deterministic guard must not call a model"); });
  assert.equal(verdict.faithful, false);
});
