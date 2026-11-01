---
name: Deployment readiness evidence
description: Distinguishing platform startup-probe failures from proven application exceptions.
---

Do not identify an Express homepage exception as the cause merely because deployment logs say “healthcheck / returned status 500.”

**Why:** In this project, those messages appeared before Node had started listening. The same existing production bundle returned HTTP 200 locally, and the public deployment later recovered without these workspace changes being published. Failed readiness is verified; the original underlying exception was not exposed.

**How to apply:** Compare probe timestamps with application startup, scope telemetry to the affected revision, and distinguish confirmed symptoms from an unproven root cause. Recheck current public status before calling the site down.
