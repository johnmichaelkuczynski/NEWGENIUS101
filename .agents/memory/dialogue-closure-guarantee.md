---
name: Long-form closure guarantee (Dialogue / Debate / Interview)
description: How the scaffolded Dialogue, Debate, and Interview creators guarantee a real ending; the over-generation pitfall, layered fallbacks, and per-endpoint gotchas.
---

# Long-form closure guarantee (Dialogue / Debate / Interview)

The same skeleton + closure-guarantee pattern is applied to three SSE endpoints in
`server/routes.ts`: Dialogue (`/api/dialogue-creator`), Debate (`/api/debate/generate`),
and Interview (`/api/interview-creator`). Each plans a skeleton `{thesis, beats[],
closure}` for targets ≥ 600 words and guarantees the planned ending is delivered.

## Per-endpoint notes
- **Debate**: single chunk loop, mirrors Dialogue exactly (closureDelivered tracking +
  post-loop forced closure + deterministic labeled fallback before the existing
  mid-sentence check). Fallback label = `Speaker 2` (elevenLabs) else last-name CAPS.
- **Interview**: 3 exit paths (coherence-success, coherence-continuation, chapter+
  continuation). A shared `deliverInterviewClosure(currentText)` helper does the
  forced-stream + deterministic fallback and is called before the TWO free-generation
  exits. **Do NOT call it on the coherence-success path** — the coherence engine
  already produces a closed result, so forcing closure there reads as a second ending.
  Arc is injected into `INTERVIEW_SYSTEM_PROMPT` (covers chapter/continuation gens, not
  the coherence engine which builds its own prompt).

## Gotchas (cost real architect Fails)
- **Debate `elevenLabsMode` is raw from JSON body.** A string `"false"` is truthy, so
  normalize: `raw === true || raw === 'true'` BEFORE any prompt/label branching.
- Guard every closure write against write-after-end: `if (res.writableEnded) return`.

---

## Core rule (applies to all three)

The Dialogue Creator plans a skeleton `{thesis, beats[], closure}` for non-continue
dialogues with target ≥ 600 words, then generates in chunks. Delivering the planned
closure must be guaranteed.

**Rule:** Never treat a *pre-computed* final-chunk flag as proof closure happened.

**Why:** `isFinalChunk` is computed from `remainingWords` BEFORE a chunk generates.
A non-final chunk can over-generate past `generationTarget`, so the `while` loop
exits with NO chunk ever flagged final → closure never issued and the dialogue
stops mid-arc. (Two separate architect Fails came from variants of this.)

**How to apply — the closure path must be layered:**
1. Track `closureDelivered` and set it true ONLY after a final-flagged chunk
   actually adds words (`thisChunkIsFinal && totalWords > wordsBeforeChunk`), not
   when the chunk is merely flagged final (a flagged-but-empty chunk must not
   suppress the fallback).
2. Post-loop guard: if scaffold planned and `!closureDelivered`, run one short
   forced-closure streaming call.
3. Deterministic fallback: if that stream throws OR yields no new words
   (`totalWords <= wordsBeforeClosure`), append a hardcoded closing turn.
4. The deterministic fallback must emit a VALID dialogue TURN with a speaker label
   (`Speaker N:` in elevenLabsMode, else `participants[i].shortName` in CAPS) — NOT
   raw narration, or it breaks the format contract / ElevenLabs strict format.
   Note: `skeletonClosure` is a stage-direction-style *description* of the ending
   and must NOT be spoken verbatim; use a generic in-character line instead.

**Scope note:** Streamed chunk output (including the forced-closure stream) is not
post-hoc format-validated anywhere in this endpoint — it relies on the shared
`DIALOGUE_SYSTEM_PROMPT` (which carries the ElevenLabs strict-format directive).
Adding output-validation only to the closure path would be inconsistent with the
rest of the endpoint.
