# GENIUS 101 — COMPLETE APP BLUEPRINT
*For AI assistants (Grok, Claude, GPT) who need full context to fix or extend the app.*
*Last updated: July 24, 2026*

---

## 1. WHAT THIS APP IS

A philosophical Q&A platform. Users pick one of ~50 historical thinkers from a sidebar and have an AI-powered conversation with that thinker. The AI is grounded in a RAG database of 130,000+ actual text chunks from the thinker's real writings.

**Live URL:** `https://genius101.xyz`
**Dev URL:** `https://<hash>.replit.dev` (auto-assigned by Replit)
**V2 experiment page:** `/v2` (identical clone of main page, safe to modify)

---

## 2. TECH STACK

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript + Vite |
| Routing | Wouter |
| State / data fetching | TanStack Query v5 |
| UI components | Shadcn UI + Tailwind CSS |
| Backend | Express.js + Node.js (ESM) |
| ORM | Drizzle ORM |
| Database | Neon PostgreSQL (pgvector extension) |
| Auth | Passport.js + Google OAuth 2.0 |
| Sessions | connect-pg-simple (stored in `sessions` table in Neon) |
| AI providers | OpenAI (GPT-4o), Anthropic (Claude Sonnet 4.5), DeepSeek, Perplexity, Grok |
| Embeddings | OpenAI `text-embedding-ada-002` (1536 dimensions) |
| Streaming | Server-Sent Events (SSE) |
| File parsing | Multer + pdf-parse + mammoth |
| TTS | Azure Cognitive Services Speech SDK |

---

## 3. DIRECTORY STRUCTURE

```
/
├── client/src/
│   ├── App.tsx                        ← Router + AuthGate
│   ├── main.tsx
│   ├── pages/
│   │   ├── chat.tsx                   ← MAIN PAGE (V1) — do not touch
│   │   ├── chat-v2.tsx                ← V2 CLONE — all experiments go here
│   │   ├── admin.tsx                  ← Visit analytics (owner only)
│   │   └── diagnostics.tsx            ← Public diagnostics page
│   ├── components/
│   │   ├── chat-input.tsx             ← Bottom input bar (has externalDocument prop)
│   │   ├── chat-message.tsx           ← Renders a single message
│   │   ├── figure-chat.tsx            ← Per-thinker chat modal
│   │   ├── comparison-modal.tsx       ← Side-by-side compare two thinkers
│   │   ├── audit-panel.tsx            ← Live RAG audit stream panel
│   │   ├── user-documents.tsx         ← "My Documents" panel (upload/paste)
│   │   ├── paper-writer-section.tsx   ← Paper writer UI
│   │   ├── dialogue-creator-section.tsx
│   │   ├── interview-creator-section.tsx
│   │   ├── model-builder-section.tsx
│   │   ├── quote-generator-section.tsx
│   │   ├── argument-generator-section.tsx
│   │   ├── position-generator-section.tsx
│   │   ├── sections/
│   │   │   ├── debate-creator-section.tsx
│   │   │   └── document-reconstructor-section.tsx
│   │   └── ui/
│   │       ├── streaming-output-popup.tsx  ← Reusable SSE output popup
│   │       └── [shadcn components...]
│   ├── data/
│   │   └── [thinker]-topics.ts        ← "What to Ask" topic suggestions per thinker
│   ├── contexts/
│   │   └── popup-manager-context.tsx
│   └── lib/
│       ├── queryClient.ts             ← TanStack Query client + apiRequest helper
│       └── elevenlabs.ts
│
├── server/
│   ├── index.ts                       ← Express app entry point
│   ├── routes.ts                      ← ALL API endpoints (~7,500 lines)
│   ├── auth.ts                        ← CANONICAL AUTH — NEVER REWRITE
│   ├── storage.ts                     ← IStorage interface + DatabaseStorage impl
│   ├── db.ts                          ← Drizzle DB connection
│   ├── vector-search.ts               ← RAG search functions (pgvector)
│   ├── prompt-builder.ts              ← System prompt builder
│   ├── audited-search.ts              ← Audited corpus search (streams events)
│   ├── PhilosopherCoherenceService.ts ← Coherence generation service
│   ├── vite.ts                        ← Vite dev server integration
│   ├── internal-auth.ts               ← ZHI key auth middleware
│   ├── prompt-builder.ts              ← System prompt builder
│   ├── nietzsche-db.ts                ← SQLite standalone Nietzsche DB
│   ├── plato-db.ts                    ← SQLite standalone Plato DB
│   ├── bible-verses.ts                ← Bible verse lookup
│   ├── author-assets-cache.ts         ← Portrait image cache
│   ├── services/
│   │   ├── longFormGenerator.ts       ← Two-tier skeleton long-form generator (≤50K words)
│   │   ├── reconstructionEngine.ts    ← Document reconstructor
│   │   ├── semanticSkeleton.ts        ← Skeleton/chunk/stitch helpers
│   │   ├── coherence/                 ← Coherence processing pipeline
│   │   ├── ttsService.ts
│   │   └── selfTest.ts
│   └── scripts/                       ← One-time ingestion/embedding scripts (not served)
│
├── shared/
│   ├── schema.ts                      ← ALL Drizzle table definitions + types
│   ├── audit-types.ts
│   └── coherence-types.ts
│
├── author_database/                   ← Text files used during ingestion (not served)
├── PY_FILES/                          ← Python engine scripts (not served)
├── RULES_FULL/                        ← Rules JSON files (not served)
└── BLUEPRINT.md                       ← This file
```

---

## 4. AUTHENTICATION

**RULE: `server/auth.ts` is CANONICAL. Never rewrite it. Never replace with Clerk/Replit Auth/Auth.js.**

### How it works
- **Provider:** Google OAuth 2.0 via `passport-google-oauth20`
- **Sessions:** `connect-pg-simple` stored in `sessions` table in Neon DB
- **Required in production only.** Dev bypass: if hostname ends in `.replit.dev` or is `localhost`, the `AuthGate` in `App.tsx` skips the login wall.

### Two user tables (BOTH exist in live Neon DB, NOT in schema migrations)
| Table | PK type | Purpose |
|---|---|---|
| `users` | `varchar` (UUID) | Guest session users (legacy, still used for chat data keying) |
| `auth_users` | `serial int` | Google OAuth logins |

### Auth endpoints
```
GET  /api/auth/google           ← Initiates Google OAuth
GET  /api/auth/google/callback  ← Google redirects here after login
GET  /api/auth/user             ← Returns { authenticated, user } — used by AuthGate
GET  /api/auth/me               ← Same as above (alias)
POST /api/auth/logout           ← Destroys session
GET  /api/admin/visits          ← Login analytics (gated to johnmichaelkuczynski@gmail.com)
```

### Auth middleware in routes.ts
```typescript
// After setupAuth(app), before any /api/* routes:
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next(); // exempt
  if (process.env.NODE_ENV !== 'production') return next(); // dev bypass
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  next();
});
```

### Important notes
- Sign-in links use `target="_top"` — Google blocks OAuth inside iframes
- Callback URL: `/api/auth/google/callback`
- Trusted prod domains: `genius101.xyz`, `www.genius101.xyz`, `genius-101-xyz-2.replit.app`
- Credentials: reads `GOOGLE_LOGIN_CLIENT_ID/SECRET` → `GOOGLE_OAUTH_CLIENT_ID/SECRET` → `GOOGLE_CLIENT_ID/SECRET`
- `SESSION_SECRET` env var required in production

---

## 5. DATABASE TABLES (Neon PostgreSQL + pgvector)

### Core app tables (in `shared/schema.ts`)
| Table | Purpose | Key columns |
|---|---|---|
| `sessions` | express-session storage | `sid`, `sess`, `expire` |
| `users` | Guest session users | `id` (UUID varchar), `username`, `email` |
| `auth_users` | Google OAuth users | `id` (serial), `google_id`, `email`, `display_name` |
| `visits` | Login event analytics | `user_id`, `email`, `visited_at` |
| `persona_settings` | Per-user settings | `user_id`, `response_length`, `quote_frequency`, `selected_model`, `intensity_level`, `dialogue_mode` |
| `conversations` | Chat conversation containers | `user_id`, `title` |
| `messages` | Chat messages | `conversation_id`, `role`, `content` |
| `figures` | Thinker definitions (legacy) | `id`, `name`, `system_prompt` |
| `figure_conversations` | Per-figure chat history | `user_id`, `figure_id` |
| `figure_messages` | Messages in figure chats | `conversation_id`, `role`, `content` |

### RAG / knowledge tables
| Table | Purpose | Key columns |
|---|---|---|
| `paper_chunks` | Embedded text chunks (per figure) | `figure_id`, `author`, `content`, `embedding` (vector 1536) |
| `text_chunks` | Embedded text chunks (by thinker name) | `thinker`, `chunk_text`, `source_file` |
| `positions` | Structured philosophical positions | `thinker`, `topic`, `position_text`, `embedding` |
| `quotes` | Structured quotes | `thinker`, `quote_text`, `topic`, `embedding` |
| `thinker_quotes` | Curated thinker quotes | `thinker_id`, `thinker_name`, `quote`, `topic` |
| `thinker_positions` | Curated position statements | `thinker_id`, `position`, `source`, `category` |
| `texts` | Complete works (raw) | `thinker`, `title`, `content` |
| `argument_statements` | Structured arguments (premises + conclusion) | `thinker`, `argument_type`, `premises[]`, `conclusion`, `embedding` |
| `auxiliary` | Works by non-site authors | `author`, `content`, `source` |

### Long-form generation tables
| Table | Purpose |
|---|---|
| `coherent_sessions` | Generation sessions for long-form content |
| `coherent_chunks` | Individual chunks generated per session |
| `stitch_results` | Final stitched output |
| `reconstruction_jobs` | Document reconstruction jobs |
| `reconstruction_chunks` | Per-chunk reconstruction results |

### User document table (created via raw DDL, NOT schema.ts migration)
```sql
CREATE TABLE user_documents (
  id SERIAL PRIMARY KEY,
  auth_user_id INTEGER REFERENCES auth_users(id),
  original_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  extracted_text TEXT,
  raw_bytes TEXT,        -- base64
  size_bytes INTEGER,
  uploaded_at TIMESTAMP DEFAULT NOW()
);
```

---

## 6. ALL API ENDPOINTS

### Auth
```
GET  /api/auth/google
GET  /api/auth/google/callback
GET  /api/auth/user
GET  /api/auth/me
POST /api/auth/logout
GET  /api/admin/visits
```

### Chat (main)
```
POST /api/chat/stream              ← Main SSE chat endpoint
GET  /api/chat-history             ← List all conversations
GET  /api/chat/:id                 ← Get conversation + messages
GET  /api/chat/:id/download        ← Download conversation as text
POST /api/chat/new                 ← Start new conversation
GET  /api/messages                 ← Get messages for current conversation
DELETE /api/messages/:id           ← Delete a message
GET  /api/persona-settings         ← Get user settings
POST /api/persona-settings         ← Save user settings
```

### Thinkers / Figures
```
GET  /api/figures                           ← List all ~50 thinkers
GET  /api/figures/:figureId                 ← Get one thinker
GET  /api/figures/:figureId/messages        ← Get figure chat history
DELETE /api/figures/:figureId/messages      ← Clear figure chat
POST /api/figures/:figureId/chat            ← Chat with a figure (SSE)
POST /api/figures/:figureId/write-paper     ← Write a paper as this figure (SSE)
POST /api/figures/:figureId/rewrite-paper   ← Rewrite a paper (SSE)
POST /api/figures/:figureId/long-form       ← Long-form generator ≤50K words (SSE)
GET  /api/figures/:figureId/thinking-quotes ← Get quotes for loading screen
```

### Generators
```
POST /api/quotes/generate       ← Quote generator (returns JSON, NOT SSE)
POST /api/positions/generate    ← Position generator
POST /api/arguments/generate    ← Argument generator
POST /api/dialogue-creator      ← Dialogue between thinkers (SSE)
POST /api/interview-creator     ← Interview with thinker (SSE)
POST /api/debate/generate       ← Debate between thinkers (SSE)
POST /api/model-builder         ← Logical model builder
```

### Document / Paper tools
```
POST /api/parse-file                     ← Parse uploaded file to text
POST /api/quotes/extract                 ← Extract quotes from file
POST /api/generate-strict-outline        ← Generate document outline
POST /api/full-document-generator        ← Full document from outline
POST /api/reconstruction                 ← Start reconstruction job
POST /api/reconstruction/:jobId/resume   ← Resume reconstruction job
GET  /api/reconstruction/:jobId/result   ← Get reconstruction result
GET  /api/reconstruction-job/:jobId      ← Get job status
GET  /api/coherence/:documentId          ← Get coherence state
```

### Standalone DBs (Plato, Nietzsche)
```
GET  /api/plato/dialogues
GET  /api/plato/speakers
POST /api/plato/search
GET  /api/nietzsche/works
GET  /api/nietzsche/years
GET  /api/nietzsche/stats
POST /api/nietzsche/search
```

### Quotes DB
```
GET  /api/quotes                    ← All quotes
GET  /api/quotes/:thinkerId         ← Quotes for one thinker
GET  /api/quotes/:thinkerId/random  ← Random quote
GET  /api/quotes/search             ← Search quotes
POST /api/arguments/import          ← Bulk import arguments
GET  /api/arguments/stats           ← Argument DB stats
GET  /api/arguments/:thinker        ← Arguments for one thinker
```

### User Documents
```
POST /api/user-documents            ← Upload file (multipart)
POST /api/user-documents/text       ← Paste text (JSON)
GET  /api/user-documents            ← List user's documents
GET  /api/user-documents/:id/text   ← Get document text
GET  /api/user-documents/:id/download ← Download document
DELETE /api/user-documents/:id      ← Delete document
```

### TTS / Voice
```
POST /api/tts              ← Azure TTS
POST /api/tts/convert      ← Convert audio format
POST /api/voice/transcribe ← Transcribe audio
```

### Internal / ZHI
```
POST /zhi/query             ← ZHI Knowledge Provider API (key-authenticated, outside /api/)
POST /api/internal/knowledge ← Internal knowledge endpoint (key-authenticated)
```

### Admin / Diagnostics
```
GET /api/admin/self-test/stream      ← Self-test stream (SSE)
GET /api/admin/synthetic-test/stream ← Synthetic user test (SSE)
GET /api/admin/accuracy-test/stream  ← Accuracy test (SSE)
```

---

## 7. RAG SYSTEM

The core intelligence pipeline. Every chat response pulls from the database.

### Search order (routes.ts `/api/figures/:figureId/chat`)
1. **positions** table — structured positions (most authoritative)
2. **argument_statements** table — structured arguments
3. **text_chunks** table — raw text chunks (semantic search via pgvector)
4. **paper_chunks** table — figure-specific chunks

### Key files
- `server/vector-search.ts` — all search functions (1,300 lines)
  - `findRelevantChunks()` — main semantic search
  - `searchPhilosophicalChunks()` — search paper_chunks
  - `searchTextChunks()` — search text_chunks
  - `searchPositions()` — search positions table
  - `normalizeAuthorName()` — maps figure IDs to DB thinker names
- `server/audited-search.ts` — streams live audit events showing which passages matched

### Author name mapping (figureId → DB thinker name)
The `figureId` in URLs (e.g., `kuczynski`, `le_bon`) must be mapped to the exact string stored in the `thinker` column. This mapping lives in `normalizeAuthorName()` in `vector-search.ts`.

### Embedding model
- `text-embedding-ada-002` (OpenAI), 1536 dimensions
- Stored in `embedding` vector columns
- pgvector cosine similarity: `1 - (embedding <=> query_embedding)`

---

## 8. AI PROVIDERS & MODELS

| Provider | Model | Used for |
|---|---|---|
| Anthropic | `claude-sonnet-4-5-20250929` | Primary chat, coherence eval |
| OpenAI | `gpt-4o` | Fallback, embeddings |
| DeepSeek | `deepseek-chat` | Default chat model (user-selectable) |
| Grok | `grok-2-1212` | User-selectable |
| Perplexity | `llama-3.1-sonar-large-128k-online` | User-selectable |

**CRITICAL:** If an Anthropic model name is wrong → 404 → ALL AI features fail. Model names are hardcoded across multiple files. Always check `claude-sonnet-4-5-20250929` is the current model.

### Streaming pattern (SSE)
```typescript
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
// Send chunks:
res.write(`data: ${JSON.stringify({ type: 'content', text: chunk })}\n\n`);
// Signal done:
res.write('data: [DONE]\n\n');
res.end();
```

---

## 9. FRONTEND PAGES & COMPONENTS

### Pages
| Route | File | Description |
|---|---|---|
| `/` | `chat.tsx` | Main page — V1 (do not modify) |
| `/v2` | `chat-v2.tsx` | Experiment clone — modify freely |
| `/diagnostics` | `diagnostics.tsx` | Public diagnostics |
| `/admin` | `admin.tsx` | Visit analytics (owner only) |

### Main page layout (chat.tsx / chat-v2.tsx)
3-column layout:
1. **Left sidebar** — thinker list with avatar portraits, search
2. **Center column** — settings panel (response length, quotes, model, intensity)
3. **Right main area** — seven stacked tool sections:
   - Main chat (top)
   - Model Builder
   - Paper Writer
   - Quote Generator
   - Dialogue Creator
   - Interview Creator
   - Debate Creator
   - (+ Document Reconstructor at bottom)

### Key component props
```typescript
// ChatInput
interface ChatInputProps {
  onSend: (message: string, file?: File) => void;
  externalDocument?: { name: string; text: string; version: number }; // from My Documents
  disabled?: boolean;
}

// FigureChat (per-thinker modal)
// Opens when user clicks a thinker in sidebar
// Uses /api/figures/:figureId/chat SSE endpoint

// StreamingOutputPopup (reusable SSE viewer)
// Used by Paper Writer, Dialogue, Interview, Debate, Long-form
```

### State management
- TanStack Query for all server state
- Local `useState` for UI state
- `externalDocument` prop pattern for cross-component content injection (My Documents → ChatInput)
- `PopupManagerContext` for managing multiple streaming output popups

---

## 10. SETTINGS (persona_settings table)

| Field | Default | Description |
|---|---|---|
| `response_length` | 750 | Target word count (0 = auto) |
| `quote_frequency` | 0 | Mandatory quotes (0 = none) |
| `selected_model` | `deepseek` | AI model |
| `intensity_level` | 30 | 0=conservative, 100=wild |
| `dialogue_mode` | false | Short conversational vs essay |
| `write_paper` | false | Formal academic paper mode |
| `enhanced_mode` | true | (legacy flag) |

Settings are keyed to `users.id` (the UUID guest user, NOT auth_users.id).

---

## 11. USER DOCUMENTS (My Documents panel)

### What it does
Lets signed-in users upload or paste text documents, then "load into chat" to inject into a question.

### Backend
- `POST /api/user-documents` — multipart upload (txt, md, doc, docx, pdf up to 5MB)
- `POST /api/user-documents/text` — paste text via JSON `{name, text}` ← must be registered BEFORE the upload route
- `GET /api/user-documents` — list (no text/bytes, just metadata)
- `GET /api/user-documents/:id/text` — get extracted text
- `DELETE /api/user-documents/:id` — delete

### Auth requirement
All user-document endpoints require `req.user` (Google OAuth). Returns 401 if not signed in.

### Frontend
- `client/src/components/user-documents.tsx`
- Header button "My Documents" → modal with two tabs: Upload File, Paste Text
- "Load into chat" triggers `onUseDocument(name, text)` callback → sets `externalDocument` on `ChatInput`

---

## 12. THINKER LIST (~50 figures)

IDs used in routes, sidebar, and DB queries:

`adler, aesop, allen, aristotle, bacon, bergler, bergson, berkeley, confucius, darwin, descartes, dewey, dworkin, engels, freud, galileo, gardner, goldman, hegel, hobbes, hume, james, jung, kant, kernberg, kuczynski, la_rochefoucauld, laplace, le_bon, leibniz, locke, luther, machiavelli, maimonides, marden, marx, mill, nietzsche, peirce, plato, poincare, popper, rousseau, russell, sartre, schopenhauer, smith, spencer, spinoza, stekel, tocqueville, veblen, weyl, whewell`

**Note:** `spinoza`, `newton`, `gibbon`, `hobbes`, `locke`, `luther` appear in DB data but may have incomplete position coverage.

---

## 13. SYSTEM PROMPT RULES (prompt-builder.ts)

Every response is shaped by `buildSystemPrompt()`. Key rules injected:
- NO self-introduction ("I am X...")
- NO opening preamble
- NO closing disclaimers about word count
- Short paragraphs (2-4 sentences max)
- First person voice
- Unfiltered authenticity (historical views stated as-is)
- Intensity dial: 0=conservative, 100=wild (maps to temperature 0.2–1.0)
- Quote mandate: if `quoteFrequency > 0`, must include that many verbatim quotes
- Dialogue mode: short conversational replies, ask questions back
- Mandatory framework application: identify thinker's specific theory, apply it step-by-step
- Answer validation: find 3 supporting passages, if they conflict present both views

---

## 14. ENVIRONMENT VARIABLES

| Variable | Required | Purpose |
|---|---|---|
| `EXTERNAL_DATABASE_URL` | YES | Neon PostgreSQL connection |
| `SESSION_SECRET` | YES (prod) | Express session signing |
| `GOOGLE_CLIENT_ID` | YES (prod) | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | YES (prod) | Google OAuth client secret |
| `OPENAI_API_KEY` | YES | Embeddings + GPT-4o fallback |
| `ANTHROPIC_API_KEY` | YES | Claude models |
| `DEEPSEEK_API_KEY` | YES | Default chat model |
| `GROK_API_KEY` | YES | Grok model |
| `PERPLEXITY_API_KEY` | optional | Perplexity model |
| `AZURE_SPEECH_KEY` | optional | TTS |
| `AZURE_SPEECH_REGION` | optional | TTS region |
| `ASSEMBLYAI_API_KEY` | optional | Voice transcription |
| `ZHI_PRIVATE_KEY` | optional | Internal ZHI API key |
| `VENICE_API_KEY` | optional | Venice AI |

---

## 15. KNOWN QUIRKS & GOTCHAS

1. **Auth in dev:** All auth is bypassed on `.replit.dev` and `localhost`. The `AuthGate` in `App.tsx` checks `hostname.endsWith(".replit.dev") || hostname === "localhost"` and skips the Google login wall.

2. **Two user tables:** `users` (varchar UUID, legacy guest sessions) vs `auth_users` (serial int, Google login). Settings/conversations are keyed to `users.id`. `user_documents` is keyed to `auth_users.id`.

3. **Live DB ≠ schema.ts:** `auth_users`, `visits`, and `user_documents` were created with raw DDL. Never use `db:push` or Drizzle migrations for them.

4. **Route order matters:** `POST /api/user-documents/text` must be registered BEFORE `POST /api/user-documents` (the multer file upload) or Express matches the wrong handler.

5. **Quotes endpoint is JSON not SSE:** `/api/quotes/generate` returns `application/json`, not `text/event-stream`. Every other generator uses SSE.

6. **Debate needs `mode: "auto"`:** The debate generator's body must include `mode: "auto"` or it errors.

7. **Anthropic model names:** `claude-sonnet-4-5-20250929` is currently used. Wrong name → 404 → all AI dies.

8. **Figure chat is slow (~240s):** The audited search does 3 sequential RAG passes. Clients must use long timeouts.

9. **Custom modals (not Radix):** `figure-chat.tsx` and `comparison-modal.tsx` are hand-rolled fixed overlays. `Escape` key does not close them. `[role=dialog]` selectors won't match.

10. **Kuczynski ID:** Was `jmk` in old code. Now universally `kuczynski` in DB and all code.

11. **General Knowledge Fund:** Author `"GeneralKnowledge"` / figureId `"general_knowledge"` — accessible to all philosophers. Contains modern research.

12. **Standalone DBs:** Plato and Nietzsche have separate SQLite databases (`server/plato-db.ts`, `server/nietzsche-db.ts`) in addition to their records in the main Neon DB.

13. **V2 page:** `client/src/pages/chat-v2.tsx` is a safe sandbox clone. V1 (`chat.tsx`) must never be modified during experiments.

---

## 16. WHAT NOT TO DO

- **NEVER rewrite `server/auth.ts`** — it is canonical, copied verbatim from the owner's proven production auth.
- **NEVER replace Google OAuth with Clerk, Replit Auth, Auth.js, or any other system.**
- **NEVER run `db:push`** — live DB schema differs from `schema.ts`. Always use raw DDL for new tables.
- **NEVER put Python files or Rules JSON in the root** — they go in `PY_FILES/` and `RULES_FULL/`.
- **NEVER touch `chat.tsx` (V1)** when experimenting — use `chat-v2.tsx`.
- **NEVER modify `vite.config.ts` or `package.json`** without asking first.

---

## 17. HOW TO ADD A NEW FEATURE (checklist)

1. **New DB table?** → Write raw DDL, run against Neon directly. Add Drizzle table def to `shared/schema.ts` for type safety. Add CRUD methods to `IStorage` in `storage.ts` + implement in `DatabaseStorage`.

2. **New API endpoint?** → Add to `server/routes.ts`. If it needs auth, it's automatic (auth middleware covers all `/api/*` except `/api/auth/*` in production).

3. **New frontend component?** → Add to `client/src/components/`. Register in `chat-v2.tsx` first to test before adding to `chat.tsx`.

4. **New page/route?** → Add file to `client/src/pages/`, register in `client/src/App.tsx` Router.

5. **New SSE endpoint?** → Follow the SSE header pattern. Client uses `EventSource` or `fetch` with streaming. Use `StreamingOutputPopup` component for display.

6. **New thinker?** → Add to `validThinkers` map in `storage.ts` `getAllThinkers()`. Add portrait to `customIcons`. Add topics file to `client/src/data/`. Ingest text chunks into `text_chunks` table.
