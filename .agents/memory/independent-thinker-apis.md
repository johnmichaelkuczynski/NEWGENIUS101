---
name: Independent thinker APIs
description: The required architecture for exposing individual thinkers to the user's other apps.
---

Create each external thinker integration as an independent proxy with its own credential and endpoint, restricted to that thinker's corpus. Do not turn the Kuczynski proxy or its credential into a shared multi-thinker mechanism.

**Why:** Dr. Kuczynski explicitly requires separate thinker identities and corrected an attempt to generalize or extend the Kuczynski proxy.

**How to apply:** When adding another thinker, follow the Aristotle pattern: separate authentication, separate route, strict author-filtered retrieval, and a response identity matching only that thinker.