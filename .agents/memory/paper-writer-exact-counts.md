---
name: Paper Writer exact counts
description: Durable rules for exact-length papers with verified quotations and optional reference lists.
---

Treat the requested word count as the essay body count. A repeated “Direct Quotations Used” reference list may follow, but it must not pad or reduce that count.

Never enforce exact length by slicing raw streamed text at the requested word. Required quotations must already be integrated and interpreted in complete argumentative paragraphs, and finalization must preserve those paragraphs while ending the body on complete sentence punctuation.

Stream draft prose to the UI while each paper segment is generated. When exact-length and quotation validation finishes, send an explicit content-reset event before streaming the validated final paper; never suppress all prose until validation completes.

Do not rely on prompt instructions alone for quote placement or formatting. Models may put markers late, omit analysis, repeat markers, or split a source excerpt across sentence boundaries. Validate and deterministically recover those cases before returning output; fail rather than emit a detached, unused, or truncated quotation.

Treat every selected source sentence as immutable after whitespace cleanup. Preserve its internal straight and curly quotation marks; outer presentation delimiters must never rewrite source punctuation.

Every source marker represents a complete sentence. Introduce it after a colon or sentence boundary, and require following analysis to begin as a new sentence. Voice checks apply to narrator prose after removing exact quotations, because a source sentence may legitimately name the thinker.

When quotation paragraphs exceed the body budget, compress them collectively while preserving every marker rather than widening every paragraph independently; small per-paragraph overages compound quickly across twenty quotations. For the exact ending, prefer a natural model-written conclusion plus a subset of already-complete draft sentences over raw token trimming, repeated filler, or reliance on optional-word metadata alone.

**Why:** Repeated live generations showed that prompt-only placement plus raw word trimming could cut the essay mid-sentence, let a reference appendix masquerade as body length, mutate source punctuation, misclassify a name inside a quotation as third-person narration, or overflow the body after individually acceptable repairs. Suppressing draft output during these checks also left the UI at zero words for many minutes even while the server was successfully generating.

**How to apply:** Whenever Paper Writer length or quotation handling changes, test a 1,000-body-word/20-quotation case through both the targeted synthetic flow and the real browser UI. Assert that draft content events arrive before final validation, the reset event occurs before the validated final content, every listed exact quote occurs once with analytical context and sentence boundaries, the body ends cleanly, source punctuation survives, and the UI displays the body count rather than the document-plus-reference count.