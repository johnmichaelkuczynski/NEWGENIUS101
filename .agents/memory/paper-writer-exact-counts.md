---
name: Paper Writer quality safeguards
description: Durable rules for instruction priority, grounded relevance, flexible length, streaming, and verified quotations.
---

Treat the requested word count as a target for the essay body, with an accepted range of minus 15% to plus 15%. Argumentative completeness and a natural ending take priority over exact length. A “Direct Quotations Used” reference list may follow, but it does not count toward the body range.

Never force exact length or slice raw streamed text at the requested word. Compress only when the complete draft exceeds the upper limit, preserving every required argument and ending on complete sentence punctuation.

Explicit custom instructions are the governing specification. They override transferred answers, uploaded source text, generic topic wording, retrieved positions, and model priors. Preserve exact logical force: “does not validate” must never become “refutes,” “falsifies,” or “invalidates.” Treat transferred or uploaded text as possible evidence, not as the thesis.

Retrieve structured arguments by relevance to the governing instructions and include them in grounding. When zero quotations are requested, inject zero quotations into the outline context. Ignore unrelated database material rather than allowing it to redirect the paper.

Start a short instruction-faithful provisional opening immediately, in parallel with retrieval and outline construction, so visible prose appears within a few seconds. Replace that preview before the grounded paper begins. Stream grounded draft prose while each segment is generated. Disable response compression for Paper Writer SSE and flush each content event immediately; event order alone does not prove that the browser receives words in real time. Send an explicit content-reset event before streaming the validated final paper, then close the stream with [DONE].

“Reject and regenerate de novo” must remain available inside the active popup, not only after completion. It aborts and discards the rejected output, preserves the original topic and custom instructions, and starts a visibly new generation that cannot use the rejected text.

Do not rely on prompt instructions alone for quote placement or formatting. Models may put markers late, omit analysis, repeat markers, or split a source excerpt across sentence boundaries. Validate and deterministically recover those cases before returning output; fail rather than emit a detached, unused, or truncated quotation.

Treat every selected source sentence as immutable after whitespace cleanup. Preserve its internal straight and curly quotation marks; outer presentation delimiters must never rewrite source punctuation.

Every source marker represents a complete sentence. Introduce it after a colon or sentence boundary, and require following analysis to begin as a new sentence. Voice checks apply to narrator prose after removing exact quotations, because a source sentence may legitimately name the thinker.

When quotation paragraphs exceed the body budget, compress them collectively while preserving every marker rather than widening every paragraph independently; small per-paragraph overages compound quickly across twenty quotations. Prefer a natural model-written conclusion and complete draft sentences over raw token trimming, repeated filler, or reliance on optional-word metadata.

**Why:** Repeated live generations showed that exact-count finalization cut later required arguments, while transferred answers and irrelevant retrieval overrode explicit instructions. Prompt-only safeguards also strengthened user claims, injected unrelated quotations, and left users unable to reject a bad stream. Exact quotation and punctuation validation remains necessary, but body length must be flexible.

**How to apply:** Test instruction-heavy papers through the proxied API and real browser. Measure first-content arrival against an explicit threshold; require draft content before reset_content, validated final content after reset_content, and [DONE]. Also require a body inside the ±15% range; every requested argument developed; no unrelated themes; exact instruction polarity; relevant thinker-only grounding; working active-stream de novo rejection; and exact quotation, punctuation, and body-count integrity.
