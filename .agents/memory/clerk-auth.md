---
name: Auth history (NO auth now)
description: Auth went Clerk → custom Google OAuth → fully removed (July 5, 2026); constraints for any future auth work
---
- Timeline: Clerk ripped out July 3, 2026 → custom Google-only OAuth built July 5, 2026 → user demanded the ENTIRE auth system removed the same day after Google kept rejecting login with `redirect_uri_mismatch` (he never registered the callback URL in his Google Cloud console).
- Current state: NO login system at all. No auth routes, no admin page, no login tracking, no GOOGLE_*/CLERK_* secrets. Guest sessions (express-session + SESSION_SECRET, Postgres store) remain — they are app functionality (conversations, persona settings, chat history), NOT auth. `users` table remains for guest FK constraints. Orphaned `login_records`/`login_events` tables may still exist in the live DB.
- **Why:** user is volatile and demanded removal after login "did nothing" — root causes were (a) Replit preview iframe blocks navigation to Google (needs new-tab/`_top`), and (b) his Google Cloud client lacked the registered redirect URI. Neither is fixable in code.
- **How to apply:** never reintroduce any login (Clerk, Replit Auth, or Google) unless he explicitly asks. If Google OAuth ever returns: manual code flow, HIS fresh credentials, consent screen must show HIS app name, sign-in must open in a new tab, and HE must register `https://<domain>/api/auth/google/callback` in his console before anything can work — test with an external screenshot of the auth URL first.
