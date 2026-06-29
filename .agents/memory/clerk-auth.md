---
name: Clerk auth (Google sign-in)
description: Why this app uses Clerk for Google login and the non-obvious pitfalls when wiring @clerk/express with the Vite dev server.
---

# Clerk auth for Google sign-in

This app's Google sign-in is done with **Clerk** (`@clerk/clerk-react` + `@clerk/express`), NOT hand-rolled `passport-google-oauth20`.

**Why:** Google refuses to render its OAuth consent inside an iframe, and the Replit preview/canvas IS an iframe. The custom passport flow could not complete there. Clerk's `<SignInButton mode="modal">` runs OAuth on Clerk's own domain and works inside the iframe. The user's other working apps (e.g. Comic-Creator-Tool) use Clerk for the same reason.

## Critical pitfall: never mount clerkMiddleware globally
`app.use(clerkMiddleware())` mounted globally crashes with **"Cannot set headers after they are sent to the client"** — it conflicts with the Vite dev middleware (clerk's handshake on non-API document/asset requests).
**Fix:** scope it. Define `const clerkAuth = clerkMiddleware();` and attach it only to the API route(s) that need it (e.g. `app.get("/api/user", clerkAuth, ...)`). Then read identity with `getAuth(req)`.

## Identity bridging
The app is **single-owner by design** (see replit.md): unauthenticated visitors auto-resolve to a shared `owner` id. `/api/user` reads `getAuth(req)`; when a Clerk userId is present it fetches the Clerk user, dedupes existing DB rows by email then id, upserts, and bridges the identity into `req.session.userId`/`username` so session-keyed routes (chat history, messages, settings) keep working. Other `/api` routes still read `req.session.userId` via `getSessionId`, so the frontend invalidates session-keyed queries when `userData.user.id` changes to avoid showing stale pre-sign-in data.

## Keys / deployment
- Secrets `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` (frontend reads `import.meta.env.VITE_CLERK_PUBLISHABLE_KEY`). Publishable + VITE_ values are the same `pk_...`.
- Secrets are global (not env-scoped), so the same keys serve both preview and the deployed `.replit.app` — including at frontend build time. Clerk **development** instances are not domain-locked and ship Google enabled via Clerk's shared OAuth creds, so Google sign-in works on any domain (with the dev-keys banner + usage limits). A `pk_live_` production instance would require the user's own Google OAuth credentials + a verified domain in the Clerk dashboard.
