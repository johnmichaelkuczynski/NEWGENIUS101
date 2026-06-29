---
name: LLM provider model names & fallback
description: Why AI generation can silently break across the whole app, and how the provider fallback is meant to work
---

# A retired model name can take down EVERY AI feature at once

Providers (Anthropic especially) retire dated model snapshots. A retired name returns
HTTP 404 `not_found_error` at call time — this is NOT a key problem. If the app calls
that provider first and has no runtime fallback, every AI feature dies together
(paper writer, chat, dialogue/interview/debate, long-form, coherence, audited search).

**Why this app is fragile:** model snapshot names are hardcoded as string literals
scattered across many files in `server/` (routes, services, scripts) — there is no
single shared constant. Each generator carries its own copy.

**How to apply:**
- When "nothing generates", test the provider+model directly with a tiny request
  before touching keys. Distinguish 404 (bad/retired model) from 401/403 (bad key).
- Fixing a bad model name means grepping ALL of `server/` for the old literal — one
  endpoint's copy is not the only one.
- Prefer routing new generators through the shared fallback path so one dead
  provider/model degrades gracefully instead of failing hard. Keep any pre-flight
  "no provider configured" guard consistent with what the fallback chain actually
  supports (don't hardcode just anthropic/openai when deepseek/grok/etc. also work).

# Audited chat search is slow — don't mistake a timeout for a breakage

The figure-chat endpoint runs an LLM-judged "audited search" that makes one LLM call
per examined passage BEFORE streaming the answer, so a single request can exceed 75s.
When smoke-testing with curl, use a long timeout (140s+) or you'll cut off before the
answer streams and wrongly conclude chat is broken.
