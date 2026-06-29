# expected vs actual — AskThem API surface

The spec describes a hypothetical AskThem with admin CRUD for thinkers. This AskThem build has a different surface. R1 records the divergence here so a reviewer can see what is missing without combing the report.

| Spec function | Spec routes | Actual in this build |
|---|---|---|
| 1 Chat single thinker | POST /api/chat | **Present**: `POST /api/figures/:figureId/chat` (SSE; `{content}` chunks + `auditEvent` events + `[DONE]`) |
| 2 Multi-thinker | POST /api/dialogue (spec) | **Present as**: `POST /api/debate/generate` |
| 3 Browse | GET /api/thinkers | **Present as**: `GET /api/figures` |
| 4 Detail | GET /api/thinkers/:id | **Present as**: `GET /api/figures/:figureId` |
| 5 Create thinker | POST /api/admin/thinkers | **Absent** — no admin CRUD for figures |
| 6 Upload text | POST /api/admin/thinkers/:id/upload-text | **Absent** |
| 7 Extract positions/quotes | per blueprint | **Absent as admin trigger**; auto-runs internally |
| 8 Chat against new thinker | depends on 5–7 | **Skipped** (5–7 absent) |
| 9 Delete thinker | DELETE /api/admin/thinkers/:id | **Absent** |
| 10 Anti-hallucination | GET /api/admin/thinkers/:id/quotes?search= | **Approximated via**: `GET /api/quotes/:thinkerId` and `GET /api/quotes/search?thinkerId=…` |
| Auth | POST /api/login with username/password | **Diverged**: Google OAuth via `/api/auth/google`; `POST /api/login` is a redirect to OAuth; dev environment has auto-login |
