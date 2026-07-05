---
name: Auth history (custom Google OAuth, production-only)
description: Auth went Clerk → custom Google OAuth → removed → rebuilt July 5, 2026 with production-domain-only policy; constraints for any auth work
---
- Timeline: Clerk ripped out July 3, 2026. Custom Google-only OAuth built July 5 → user demanded full removal same day after `redirect_uri_mismatch` (he never registered the callback URI in his Google Cloud console) → hours later re-sent his 25-item spec demanding the same system rebuilt, now with item 25: **production domain only** — never configure, test, or register OAuth with *.replit.dev preview URLs.
- Implementation: manual code flow in `server/googleAuth.ts` (no passport), routes `/api/auth/google`, `/api/auth/google/callback`, `POST /api/logout`, `/api/admin/logins`; admin page `/admin` gated to johnmichaelkuczynski@gmail.com. Login tracking in `login_records`/`login_events` with startup-safe `CREATE TABLE IF NOT EXISTS` (live DB ≠ schema.ts; never rely on db:push).
- Google blocks OAuth inside the Replit preview iframe → sign-in links must use `target="_top"`; real login testing requires a full browser tab on the production domain.
- **Why:** user is adamant: consent screen must show HIS app name (never Replit), fresh credentials per app (never reused), verification only against the deployed production domain. The original failure was HIS console missing the redirect URI — not code.
- **How to apply:** never reintroduce Clerk/Replit Auth. Any auth change keeps the manual flow and requires him to register `https://<prod-domain>/api/auth/google/callback` (redirect URI) and `https://<prod-domain>` (JS origin) in his Google Cloud console. Verify the consent screen with an external screenshot of the auth URL before asking him to test.
