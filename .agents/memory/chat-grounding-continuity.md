---
name: Conversation-grounded author answers
description: Why follow-up retrieval must retain its subject, and why a finished SSE iterator does not prove a finished answer.
---

Every top-chat reply must remain grounded in the selected author's database material, including short conversational follow-ups. A new self-contained question must nevertheless start a fresh topic rather than inherit irrelevant older material.

**Why:** Dr. Kuczynski reported a good initial author-specific answer followed by a generic model answer. Production logs showed the follow-up search used only “DO YOU PERSONALLY AGREE WITH THIS VIEW?” without resolving the referenced thesis. It returned many source chunks, but counts alone concealed loss of the subject.

**How to apply:** Resolve references using recent conversation before every retrieval layer and source-binding step. Keep a deterministic topical fallback when the query-rewriting provider fails or simply repeats the unresolved question. Test a substantive question followed by a short agreement/evaluation request in the same conversation; inspect the subject and author's actual arguments, not merely retrieval counts.

Fresh source constraints must survive every generation-provider fallback and any continuation. No provider should receive source context only as an old user utterance, and unavailable sources must not silently become generic advice impersonating the author.

**Why:** Changing the underlying model does not replace author grounding. The user explicitly objected to a response that sounded like a generic model rather than Kuczynski.

**How to apply:** Preserve current primary-source context in each provider's system channel. A continuation must use the same source position and resume existing text rather than append a second opening.

Gemini's streaming transport can end mid-word without a terminal reason or SDK exception. Exhausting the iterator, returning HTTP 200, and emitting the app's completion marker do not prove the answer is complete.

**Why:** Real main-chat checks repeatedly received truncated prose that the app had marked successful. The defect was only exposed by inspecting the final sentence; checking topic keywords and word count had passed.

**How to apply:** Validate natural completion as well as source grounding. Avoid exposing an unfinished tail when recovering a stream, continue from the last completed text with the same source constraints, and preserve the total requested length rather than asking a fallback provider for an additional full-length answer.
