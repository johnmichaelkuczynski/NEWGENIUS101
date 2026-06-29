---
name: Dev server has no watch / backend reload
description: How code changes get picked up in this repl's dev workflow
---

The `Start application` workflow runs `npm run dev` = `tsx server/index.ts` with **no watch mode**.

**Why:** The Express server does NOT auto-reload on backend file edits. Vite HMR handles frontend (`client/`) changes live, but any change under `server/` requires a manual workflow restart.

**How to apply:** After editing backend code, call `restart_workflow("Start application")` before testing (e.g. via `curl http://localhost:5000`). Only restart when no generation is in progress — restarting mid-stream kills the user's in-flight output and looks like a "Failed to fetch" bug.
