---
name: Custom modals (figure-chat & compare) are NOT Radix dialogs
description: Two of the app's main modals are hand-rolled overlays, not Radix Dialogs — Escape won't close them and [role="dialog"] won't match them.
---

The figure-chat modal and the Compare-Two-Thinkers modal are both hand-rolled
overlays, NOT Radix `Dialog`s. Each renders a `div.fixed.inset-0` backdrop (z-40)
plus a separate floating window (`div.fixed.z-50`). The generator popups (paper /
dialogue / interview / debate) ARE real Radix dialogs (`[role="dialog"]`).

**Why:** when driving the app programmatically (recording harness, synthetic users),
this causes two silent failures:
- `Escape` does not close figure-chat / compare. The leftover backdrop sits over the
  page and swallows every subsequent click. Close them explicitly: click
  `button[title="Close"]` / `button-close-comparison`, or click the backdrop.
- Waiting on `[role="dialog"]` for compare/chat content matches nothing → the wait
  runs to its cap with 0 chars even though generation succeeded server-side.

**How to apply:**
- Detect compare-stream completion via the floating window text (`div.fixed.z-50`)
  settling AND the streaming spinner gone — avatars carry `.animate-spin` only while
  `isStreaming1/2` is true (`div.fixed.z-50 .animate-spin` count === 0 means done).
- Compare runs two SEQUENTIAL chat calls (one per figure), each ~2 min, so the whole
  compare segment is ~5 min — budget accordingly.
- Radix `selectRadix` helpers must verify the trigger text actually changed and retry;
  the click sometimes opens the listbox without committing a selection.
