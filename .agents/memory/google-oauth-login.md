---
name: Google OAuth login (Genius 101)
description: Why Google login failed end-to-end and the constraints any auth change must respect
---

# Google OAuth login — root causes & invariants

Active Google strategy is INLINE in `server/routes.ts` registerRoutes (~line 443).
`server/googleAuth.ts` and `server/replitAuth.ts` are DEAD code. Frontend uses `/api/user`.

## The `users` table has UNIQUE constraints on BOTH `email` AND `username`
Any login that INSERTs a user can violate either one. The verify callback must
match an EXISTING account and reuse its row, not blindly insert.

**Match order that works:** by email first, then by id; only create new if neither found.
**Why:** the DB contains a LEGACY row whose id is prefixed `google_<sub>` (from an older
auth flow) that already holds the owner's gmail. The current strategy uses the raw
`profile.id` (no prefix), so id-only lookup misses it and an insert hits
`users_email_unique`. Username collisions (`users_username_unique`) hit the same way.

## Sessions must be PostgreSQL-backed (connect-pg-simple), not in-memory
Deployment is autoscale → in-memory sessions are lost across instances/restarts, so a
successful Google login bounces back to logged-out. Also requires `app.set('trust proxy',1)`
before session middleware so secure cookies work behind Replit's proxy.

## Testing gotchas (not bugs)
- Google login CANNOT run inside the Replit embedded preview/canvas iframe (Google refuses
  framing). Test in a real standalone browser tab.
- A stale `/?error=auth_failed` URL just replays the old error on reload — start a fresh
  Sign in.
- Two redirect URIs must be registered on the OAuth client: the prod `.replit.app` one AND
  the dev `.kirk.replit.dev` one. Production needs a Republish to pick up code/secret changes.
