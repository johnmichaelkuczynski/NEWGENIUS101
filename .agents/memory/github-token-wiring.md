---
name: GitHub token wiring
description: Why PAT-authenticated GitHub access is separate from the Replit-managed origin.
---

Use the direct `github` remote for operations intended to use `GITHUB_PAT`; preserve the Replit-managed internal `origin`.

**Why:** The user requested wiring a replacement token, not replacing the workspace's Git integration or pushing project contents. The existing origin uses Replit's internal GitHub proxy, rather than GitHub's ordinary HTTPS host.

**How to apply:** Keep authentication repository-local and host-scoped. Resolve the secret from the environment at command time; never save its value in a remote URL, credential file, or Git configuration. Rotating the secret should not require replacing code. Read access and reported write permissions are not proof of a successful push; do not push without a user request.
