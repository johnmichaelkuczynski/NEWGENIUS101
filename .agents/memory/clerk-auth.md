---
name: Auth history (all login removed; new approach pending)
description: Auth went Clerk → custom Google OAuth → fully removed July 5, 2026; user has an unexplained "new approach"; constraints if auth ever returns
---
- Current state: NO login at all. All auth code removed July 5, 2026 on user's explicit order after repeated Google Console redirect_uri_mismatch failures (his console entry had a one-char typo he denied). Anonymous guest sessions remain (express-session + Postgres store, SESSION_SECRET required). `/api/user` returns `{user:null}` as a compatibility endpoint.
- User announced "I HAVE NEW APPROACH. WILL EXPLAIN AFTER YOU REMOVE" — do NOT build any auth until he explains it.
- Timeline: Clerk ripped out July 3 → custom Google-only OAuth built July 5 per his 25-item spec → removed → rebuilt with production-only policy → fully removed again the same day.
- Leftovers: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets still exist (agent tools cannot delete secrets — only the user can, via Secrets tab). login_records / login_events tables may still physically exist in the Neon DB (harmless; nothing reads them).
- **Why:** user is hostile to auth friction; the recurring failure was always Google Cloud console configuration on HIS side, not code. He blamed the system each time.
- **How to apply if auth returns:** never Clerk/Replit Auth; consent screen must show HIS app name (never Replit); production-domain-only OAuth (never *.replit.dev); sign-in links need `target="_top"` (Google blocks OAuth in the Replit preview iframe); verify the consent screen yourself via external screenshot of the auth URL before asking him to test; expect his console entries to contain typos — verify them character by character against a live curl test of the domain.
