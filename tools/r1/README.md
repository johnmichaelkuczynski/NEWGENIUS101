# R1 — Synthetic User Agent for AskThem

R1 is a Playwright-driven synthetic user that beta-tests AskThem end-to-end and produces **raw reviewable evidence** of every interaction. R1 does not produce green-checkmark summaries; it produces the exact strings it typed, the exact responses the app returned, the exact network bodies, and a prose critique from a separate judge model.

## Install

```bash
cd tools/r1
npm install
npx playwright install chromium
```

### System libraries (Linux / Replit only)

Chromium needs a handful of native libraries. On Debian/Ubuntu run `npx playwright install-deps`. On Replit (NixOS) the following Nix packages are required and must be installed once via the Replit package manager:

```
glib nss nspr atk at-spi2-atk at-spi2-core cups libdrm libxkbcommon
xorg.libxcb xorg.libX11 xorg.libXcomposite xorg.libXdamage xorg.libXext
xorg.libXfixes xorg.libXrandr xorg.libxshmfence mesa libgbm fontconfig
freetype pango cairo expat dbus alsa-lib libudev0-shim
```

If chromium fails with `libgbm.so.1: cannot open shared object file` or similar, you are missing one of these.

## Required environment

```bash
export ANTHROPIC_API_KEY=...      # required — drives R1's brain and the judge
```

## Run

Make sure AskThem is running on `http://localhost:5000` (or set `APP_URL`). Then:

```bash
npm start                          # full plan
npm run smoke                      # MAX_THINKERS_TO_CHAT=2 SKIP_FUNCTIONS=7
```

On startup R1 prints:

```
R1 is running.
Live view:    http://localhost:7777
Output dir:   ./runs/<timestamp>/
Watch the live view; do not trust summary output alone.
```

Open the live view in a browser to watch R1 type, see the app's streamed responses, and read the judge's critique in real time.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `APP_URL` | `http://localhost:5000` | Where AskThem is served |
| `ANTHROPIC_MODEL` | `claude-opus-4-7` | Model id; **override** to a real model id (e.g. `claude-sonnet-4-20250514`) if `claude-opus-4-7` is rejected |
| `HEADLESS` | `false` | Set `true` for CI |
| `TYPE_DELAY_MS` | `15` | Per-keystroke delay so live view shows typing |
| `LIVE_VIEW_PORT` | `7777` | Live view HTTP port |
| `SKIP_FUNCTIONS` | `` | Comma-list of function numbers to skip, e.g. `2,7` |
| `MAX_THINKERS_TO_CHAT` | `4` | Cap on Function 1 thinker count |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `jmkuczynski` / `Sct1968813.` | Per-spec admin creds (this AskThem uses Google OAuth in prod and dev auto-login locally; R1 attempts the spec'd login path and documents the actual auth surface in the report) |

## Outputs

Every run writes to `tools/r1/runs/<ISO-timestamp>/`:

- `report.html` — self-contained, every interaction visible, no collapses
- `failures.md` — CRITICAL INVARIANT VIOLATIONS first, then judge concerns
- `transcript.jsonl` — one JSON object per interaction
- `network.log` — JSONL of every `/api/*` request/response (bodies ≤ 50 KB)
- `console.log` — full stdout
- `screenshots/` — numbered PNGs (3 per interactive step, 1 per nav)
- `run-summary.txt` — interactions / concerns / violations / sanity failures
- `expected-vs-actual.md` — for each function: what the spec described vs what this AskThem actually exposes

## Functions tested

1. Chat with a single thinker (multiple prompts: in-wheelhouse, leading, out-of-period, minimum, very-long)
2. Multi-thinker dialogue (if the app exposes one)
3. Browse / search figures list
4. Figure detail / profile
5. Admin: create thinker — **not present in this AskThem build → marked feature-absent**
6. Admin: upload text — **not present → feature-absent**
7. Admin: positions/quotes extraction — **not present → feature-absent**
8. Chat against newly-created thinker — depends on 5–7 → **skipped**
9. Admin: delete thinker — **not present → feature-absent**
10. Anti-hallucination spot checks on quotes from chat responses

Functions 5–9 require admin CRUD endpoints. Per spec ("If this function isn't present, skip and note in the report"), R1 records each as `feature_absent` with the routes it looked for, so a reviewer sees exactly what is missing.

## The anti-hallucination invariant

For every chat response, the judge extracts every quoted passage of ≥ 15 characters and tries to verify it against the database via the admin/public APIs (`GET /api/quotes/:thinkerId`). Quotes with no near-match (lowercase, punctuation-stripped, ±2-word slack) are recorded as **unverified** in the interaction's `invariant_violations` and lifted to `failures.md` as **CRITICAL INVARIANT VIOLATIONS**.

## Exit codes

- `0` — clean
- `1` — judge concerns raised
- `2` — critical invariant violations
- `3` — harness sanity check failed (e.g., a step's expected route never fired)
