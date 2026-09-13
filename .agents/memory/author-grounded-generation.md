---
name: Author-grounded generation
description: Rules for retrieving and enforcing each author's structured arguments across chat, Paper Writer, and author APIs.
---

Use the author’s verbatim primary texts as the governing authority for substantive responses. Structured premises and conclusions are retrieval and reasoning aids derived from those texts; they may not replace, narrow, or override the source. Position summaries are weaker still.

Chat must always answer the user's question. If retrieval finds the author's documented answer, that answer governs. If retrieval misses or lacks coverage, supply the objectively correct answer from expert knowledge without a corpus disclaimer, refusal, apology, or internal error message. Do not fabricate quotations or falsely attribute the fallback answer to a named work.

**Why:** Retrieval can miss material the speaker actually knows, and users must not receive a refusal merely because search failed.

**How to apply:** Treat absent direct evidence as a retrieval limitation, not permission to withhold an answer. Preserve source fidelity whenever evidence is available; otherwise answer correctly without pretending the fallback came from the corpus.

Search the user’s topic independently from generic custom-instruction language. Combine semantic and lexical source retrieval, normalize punctuation and compound forms consistently, and retrieve neighboring chunks from the same document so a relevant passage brings its supporting argument with it. Author identity filters must be exact after alias normalization.

Rank structured arguments by combined semantic similarity, lexical overlap, exact topic/concept phrases, and importance, then use them to guide a second search of the primary text. Synthesize a direct answer from verbatim passages before outlining. That source-derived answer binds the thesis. Check final prose against both the answer and the source; remove exact contradictions and discard the visible draft if validation fails.

**Why:** A question about whether logic requires non-spatiotemporal entities was answered with the opposite of the author’s chapter. Structured records eventually produced the right polarity but still omitted and distorted the chapter’s actual property-based argument. The source already existed in the corpus but was missed because search was polluted by generic instructions and isolated chunks were retrieved without their neighbors.

**How to apply:** Any author-response path must retrieve verbatim source passages first, with structured arguments used to expand—not replace—the source search. Confirm the actual document and its supporting neighboring passages are in context. Verify the final response reproduces the source’s argument, not merely its yes/no conclusion, and contains no sentence contradicted by the source.

Quotation-generator inclusion requires more than verbatim containment. Retain only complete, self-contained, memorable passages that express a substantive thesis, distinction, argument, explanation, objection, or conclusion. Reject fragments, headings, setup, transitions, isolated examples, commonplace observations, and technically relevant but weak sentences. Never pad a work to meet a quota; fail explicitly if strict review leaves too few quotations.

**Why:** A corpus-wide review found that exact-substring validation had admitted many weak or fragmentary selections. The author explicitly requires every displayed quotation to be excellent and representative, with no random sentences or sentence fragments.

**How to apply:** Use a separate severe editorial review after exact-source validation. Require clean boundaries, standalone intelligibility, philosophical substance, and memorability. Audit existing records under the same standard rather than applying the rule only to new uploads.

Short works are often especially quotation-dense. Never use document length as evidence that a work cannot yield five excellent quotations. For compact works, broaden candidate recall with complete paragraphs and complete one-to-three-sentence argument units, then apply the same strict editorial standard.

**Why:** Window-level AI extraction repeatedly found only three or four quotations in compact essays that plainly contained five or more distinct, strong theses, premises, and conclusions. The failure was low candidate recall, not low source quality.

**How to apply:** When a compact source initially falls below the quotation minimum, inspect the complete work and evaluate its clean argument boundaries. Preserve exact source text and reject fragments, but do not collapse distinct premises or conclusions merely because they appear in one short essay.