---
name: GitHub token wiring
description: Verify the actual origin push path and distinguish account rights from fine-grained token permissions.
---

When asked to wire in a GitHub token, verify that the user's actual `origin` push path uses `GITHUB_PAT`, not merely that a secondary remote can read the repository.

**Why:** The user repeatedly requested wiring replacement tokens and still received a push rejection. Git URL prefix rewriting redirected nominal GitHub URLs through Replit's internal proxy. Separately, GitHub's repository API reported account push rights while the fine-grained token itself was denied the Git push handshake.

**How to apply:** Inspect the effective push URL as well as the stored URL; keep any routing correction narrowly repository-scoped. Keep authentication repository-local and host-scoped, resolving the secret from the environment at command time without persisting its value. Test the push handshake or a dry run before claiming push access; repository API `permissions.push` describes account rights, not necessarily token authorization. Fine-grained tokens need the target repository selected and Contents read/write permission. Do not push or force-push merely to verify credentials.
