---
name: Auth removed (single-owner mode)
description: Login system was completely removed at user's demand; do not reintroduce
---
- On July 3, 2026 the user demanded the entire login system be ripped out ("RIP IT OUT. DO NOT PATCH. DO NOT REINSTALL. DO NOT FIX.").
- Clerk (Google sign-in), the Sign in/Log out UI, /api/logout, and the Clerk packages were all removed. Every visitor is auto-assigned the single `owner` identity via GET /api/user; express-session + PG session store retained since all data routes key off req.session.userId.
- **Why:** user explicitly wants NO login of any kind. Do not re-add auth, Clerk, or sign-in UI unless he explicitly asks.
- **How to apply:** if a future task needs per-user data, ask first; default is single-owner mode. CLERK secrets may still exist in env but are unused.
