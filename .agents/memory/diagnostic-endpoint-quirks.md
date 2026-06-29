---
name: Diagnostic / generator endpoint quirks
description: Non-obvious request-body and response-shape gotchas when driving the app's generator endpoints programmatically (e.g. synthetic-user / accuracy diagnostics).
---

These bit me while building the synthetic-user and accuracy diagnostics that drive every feature via the real HTTP API.

- **Debate `/api/debate/generate`**: passing `mode:"standard"` (or any unknown mode) is treated as custom and returns JSON `{"error":"Custom mode requires instructions"}` — NOT SSE. Use `mode:"auto"` (no instructions needed) for a generic run, or supply `instructions` for custom mode.
- **Quotes `/api/quotes/generate`**: returns a plain JSON body with a `quotes[]` array, NOT an SSE stream. A robust probe must branch on the `content-type` header (event-stream vs json).
- **Chat `/api/figures/:id/chat` is slow**: it ALWAYS runs `auditedCorpusSearch` (positions→quotes→chunks, LLM-judged) regardless of `dialogueMode`/`enhancedMode`. There is no fast path. Give it ~240s timeout; 100s is not enough.
- **SSE content keys vary by endpoint**: accumulate any string-valued key among `content/token/delta/text/chunk`; streams end with `data: [DONE]`.
- **`/diagnostics` page is intentionally public** (states so in the UI). The `/api/admin/*/stream` endpoints have no auth — same pre-existing pattern as the original self-test. Don't add auth unprompted; it would change behavior of the whole page.
- **UI automation: capturing a NEW audited-chat answer for the SAME question is fragile.** Reopening a figure chat loads prior history, and the assistant message element only appears ~60-100s after send (audit runs first). A `.last()` + "stable text" wait will instantly latch onto the *previous* completed answer (returns in ~12s, identical char count) instead of the new one. Counting messages and waiting for `before+2` is NOT enough because the assistant node appears later than the wait window. Reliable fix: click `button-clear-chat` after reopening so there is no stale completed message, then the stability wait correctly tracks the single fresh streaming answer.
- **Intensity dial genuinely changes chat output** (server `intensityToTemperature` + `buildIntensityGuidance` feed temperature and system-prompt guidance in the chat routes). LOW ("Book-report conservative") vs HIGH ("Wild man") produce materially different answers — not just cosmetic. Within one server run, identical char counts across LOW/HIGH mean you captured a stale message, not that intensity is ignored.

**Why:** these endpoints don't share a uniform contract; assuming SSE + a single content key + a fast chat path all produce silent zero-content failures. And UI-level answer capture must account for late-appearing assistant nodes + persisted history.
