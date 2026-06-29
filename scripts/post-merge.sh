#!/bin/bash
set -e

# Install dependencies only.
# NOTE: Do NOT run `drizzle-kit push` here. This project's live PostgreSQL
# schema is out of sync with shared/schema.ts and is managed manually via
# direct ALTER TABLE statements. `db:push` prompts interactively (which hangs
# post-merge since stdin is closed) and, with --force, would risk dropping the
# 130k-row RAG corpus. Apply schema changes manually when needed.
npm install
