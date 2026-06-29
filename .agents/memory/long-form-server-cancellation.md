---
name: Long-form server-side cancellation
description: How to actually stop in-progress long-form generation server-side so a disconnect doesn't keep burning LLM calls
---

# Long-form server-side cancellation (Dialogue / Debate / Interview)

When letting users Stop an in-progress generation, the client AbortController only
frees the UI. The server keeps running unless it detects the disconnect.

**Rule:** Detect disconnect with `let clientGone=false; res.on('close',()=>{clientGone=true;})`,
then guard EVERY place that can issue an LLM call or write to the response — not just
the main chunk loop:
- Top of each chunk/continuation `while` loop AND each multi-chapter `for` loop: `if (clientGone) break;`
- Forced-closure block guard: `&& !clientGone && !res.writableEnded`
- **Critically**, short-circuit ALL post-loop completion work with an early
  `if (clientGone || res.writableEnded) return;` placed AFTER the forced-closure block
  but BEFORE the mid-sentence "completion tail" logic and the final `done`/`[DONE]`/`res.end()` writes.

**Why:** The first architect review failed the feature because breaking the main loop
still fell through to post-loop logic — mid-sentence completion makes an extra LLM call,
and final writes hit a closed socket. Guarding only the loop is not enough.

**How to apply:** Any new long-form endpoint with chunked/continuation generation must
replicate this in all three spots (loop tops, closure guards, post-loop early return).
`res.on('close')` also fires on normal completion, but that's harmless here because the
guards only matter while work is still in flight.
