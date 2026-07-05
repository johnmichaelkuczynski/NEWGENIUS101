---
name: Auth history (custom Google OAuth now)
description: Auth went Clerk → no login → custom Google-only OAuth (July 2026); constraints for any future auth work
---
- July 3, 2026: user demanded the entire Clerk login be ripped out. July 5, 2026: user demanded a **custom Google-only OAuth** — explicitly NO Clerk, NO Replit Auth, NO Replit-branded consent screen; must show HIS Google Cloud app name with HIS own unique credentials (GOOGLE_CLIENT_ID/SECRET/SESSION_SECRET, never reused from another app).
- Implemented as a manual OAuth code flow in `server/googleAuth.ts` (no passport). Login `/api/auth/google`, callback `/api/auth/google/callback`, logout POST `/api/logout`. Anonymous visitors still work via guest sessions; `/api/user` returns Google user or null.
- Admin analytics: only johnmichaelkuczynski@gmail.com may access `/admin` + `/api/admin/logins`; logins recorded in `login_records`/`login_events` (created via raw SQL, NOT db:push — live DB ≠ schema.ts).
- Google blocks OAuth inside the Replit preview iframe → sign-in links must use `target="_top"`; testing real login requires opening the app in a full browser tab.
- **Why:** user is adamant about branding (consent screen must not say Replit) and about fresh credentials per app.
- **How to apply:** never reintroduce Clerk/Replit Auth; any auth change must keep the custom flow and the redirect URIs `https://<domain>/api/auth/google/callback` registered in his Google Cloud console. Old CLERK_* secrets may linger unused.
