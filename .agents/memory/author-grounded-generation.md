---
name: Author-grounded generation
description: Rules for retrieving and enforcing each author's structured arguments across chat, Paper Writer, and author APIs.
---

Use the author’s verbatim primary texts first when they genuinely bear on the question. Structured premises and conclusions are retrieval and reasoning aids derived from those texts; they may not replace or misrepresent the source. Position summaries are weaker still.

Chat must always give the best available answer. Search the author’s writings first, then use broad expert knowledge and live research when needed. Staying within the author’s ambit is secondary to correctness and completeness. Never show a corpus disclaimer, refusal, apology, or internal error message. Do not fabricate quotations or falsely attribute outside knowledge to a named work.

**Why:** Retrieval can miss material the speaker actually knows, and source coverage must never become a boundary on what the app can answer.

**How to apply:** Treat source retrieval as the first research stage, not the final scope. If it is incomplete, continue with the strongest available outside knowledge and research; answer directly without discussing the search process.

When direct retrieval fails, exclude adjacent author passages from the fallback prompt rather than using them to decorate an unrelated answer. The fallback must be an objective expert answer, not a forced imitation of the author built from irrelevant quotations. End with the answer itself; never append word-count advice or other meta-commentary.

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

The thinking sidebar is an author-quotation display, not simulated inner monologue. Dr. Kuczynski requires real quotations from the selected thinker, continuously moving through the top of the panel. Preassembled banks are acceptable; generated filler, derived positions, and borrowing another author's quotations are not. Quality takes precedence over filling a bank to 100.

**Why:** The displayed “quotes” were generic phrases such as “Consider the implications of this position...” rather than the selected author’s words. The user explicitly requested genuine quotations for every thinker without changing the otherwise working app.

**How to apply:** Keep this fix scoped to quotation sourcing and movement. Use exact source excerpts, retain their provenance, select authors by exact canonical identity, and display an explicit unavailable state rather than inventing replacements.

The user confirmed the genuine-author-quotation sidebar as “MUCH BETTER,” showing Kuczynski excerpts extending through the top of the panel.

**Why:** This confirms the requested direction; retain authentic source excerpts and continuous upward movement rather than simulated thinking phrases.

**How to apply:** Preserve this behavior during subsequent scoped fixes; do not redesign the sidebar without a new request.

Verbatim containment in a thinker's corpus is necessary but not sufficient for quotation attribution. Collected editions can include translator prefaces, biographies, editorial essays, publisher advertising, and other authors' works.

**Why:** An initial exact-source selection admitted Townsend's preface as Aesop and promotional prose about another book from an Aristotle volume. These were literal source matches but not quotations by the named author.

**How to apply:** Limit extraction to the authored work, especially the fable body rather than Aesop's prefatory/biographical material. Apply a separate editorial/authorship review after source matching. Short, complete fable morals are valid; do not exclude them merely to satisfy a generic minimum sentence length.

In Compare Two Thinkers, each answer must express that author's source-supported position, not a generic expert answer silently substituted when an automated relevance judge fails. This rule is scoped to comparisons; preserve other answer modes unless separately requested.

**Why:** Dr. Kuczynski reported Freud and Dworkin both giving interchangeable denials of gender differences. Their relevant primary texts were present, but the comparison fallback explicitly discarded author perspective. Author display names can also differ from corpus identity, and a provider-dependent failed judgment is not evidence of absent sources.

**How to apply:** Retrieve each author's primary writings independently with exact canonical identity, retain neighboring argumentative context, derive a source-supported thesis before generating, and check the final answer against that thesis and its evidence. Preserve streaming and existing controls. Distinguish psychosexual-development claims from social-construction claims; do not force either author toward a predetermined yes/no answer.

Reject evasive answers that insert a stronger quantifier or qualifier into the user's question and deny that instead. Start with the author's substantive claim; give genuine qualifications afterward.

**Why:** Even explicit prompt instructions and an LLM fidelity judge accepted an opening denying “entirely different” moral codes, despite the question not saying “entirely” and the selected source asserting differences. The same sources yielded an accurate explanation once the strengthened denial was caught deterministically.

**How to apply:** Check both the source-derived synopsis and the final opening for invented stronger propositions. Do not rely solely on another LLM to notice this failure, and retain real source distinctions rather than removing all qualifications.