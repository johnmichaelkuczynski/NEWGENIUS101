#!/usr/bin/env node
// R1 — Synthetic User Agent for AskThem
// Produces raw reviewable evidence of every interaction. No green-checkmark theater.

import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// CONFIG
// ============================================================================
const APP_URL = process.env.APP_URL || "http://localhost:5000";
const HEADLESS = process.env.HEADLESS === "true";
const TYPE_DELAY_MS = parseInt(process.env.TYPE_DELAY_MS || "15", 10);
const LIVE_VIEW_PORT = parseInt(process.env.LIVE_VIEW_PORT || "7777", 10);
const SKIP_FUNCTIONS = new Set((process.env.SKIP_FUNCTIONS || "").split(",").filter(Boolean));
const MAX_THINKERS_TO_CHAT = parseInt(process.env.MAX_THINKERS_TO_CHAT || "4", 10);
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "jmkuczynski";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
if (!ADMIN_PASSWORD) console.warn("[R1] ADMIN_PASSWORD env var not set — F0 will probe /api/login with an empty password and record the actual auth surface as a violation. This is expected on this AskThem build (Google OAuth + dev auto-login).");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY is not set");
  process.exit(1);
}

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_DIR = path.resolve(__dirname, "runs", RUN_TS);
const SCREENSHOTS_DIR = path.join(OUTPUT_DIR, "screenshots");
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================================
// LOGGING + OUTPUT FILES
// ============================================================================
const consoleLogStream = fs.createWriteStream(path.join(OUTPUT_DIR, "console.log"), { flags: "a" });
const transcriptStream = fs.createWriteStream(path.join(OUTPUT_DIR, "transcript.jsonl"), { flags: "a" });
const networkStream = fs.createWriteStream(path.join(OUTPUT_DIR, "network.log"), { flags: "a" });

function log(...args) {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const stamped = `[${new Date().toISOString()}] ${line}`;
  process.stdout.write(stamped + "\n");
  consoleLogStream.write(stamped + "\n");
}

function writeTranscript(obj) {
  transcriptStream.write(JSON.stringify(obj) + "\n");
}

function writeNetwork(obj) {
  networkStream.write(JSON.stringify(obj) + "\n");
}

// ============================================================================
// LIVE VIEW SERVER
// ============================================================================
let liveState = {
  status: "starting",
  current: null,             // { function_number, function_name, step_description, url, r1_approach, r1_reasoning, r1_input_so_far, latest_screenshot, app_response_text, network_calls, judge_critique }
  recent_interactions: [],   // last 50 summaries
  totals: { interactions: 0, concerns: 0, violations: 0, sanity_failures: 0 },
  report_url: null,
  output_dir: OUTPUT_DIR,
};

function updateLive(patch) {
  if (patch.current) liveState.current = { ...(liveState.current || {}), ...patch.current };
  if (patch.totals) liveState.totals = { ...liveState.totals, ...patch.totals };
  if (patch.status) liveState.status = patch.status;
  if (patch.report_url) liveState.report_url = patch.report_url;
  if (patch.push_recent) {
    liveState.recent_interactions.unshift(patch.push_recent);
    liveState.recent_interactions = liveState.recent_interactions.slice(0, 50);
  }
}

let LIVE_PORT_ACTUAL = LIVE_VIEW_PORT;
const liveServer = http.createServer((req, res) => {
  if (req.url === "/state.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(liveState));
    return;
  }
  if (req.url?.startsWith("/screenshot/")) {
    const name = req.url.replace("/screenshot/", "").replace(/[^A-Za-z0-9._-]/g, "");
    const p = path.join(SCREENSHOTS_DIR, name);
    if (fs.existsSync(p)) {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      fs.createReadStream(p).pipe(res);
      return;
    }
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(LIVE_VIEW_HTML);
});
function startLiveServer(port, attempt = 0) {
  return new Promise((resolve) => {
    liveServer.once("error", (err) => {
      if (err.code === "EADDRINUSE" && attempt < 10) {
        log(`Live view port ${port} in use, trying ${port + 1}`);
        startLiveServer(port + 1, attempt + 1).then(resolve);
      } else {
        log(`Live view server failed: ${err.message} — continuing without live view`);
        resolve(null);
      }
    });
    liveServer.listen(port, () => {
      LIVE_PORT_ACTUAL = port;
      log(`Live view on http://localhost:${port}`);
      resolve(port);
    });
  });
}
await startLiveServer(LIVE_VIEW_PORT);

const LIVE_VIEW_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>R1 Live</title>
<style>
 body { font: 13px/1.4 -apple-system, system-ui, sans-serif; margin: 0; background: #0b0f14; color: #d6dde5; }
 .grid { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto 1fr; height: 100vh; gap: 8px; padding: 8px; box-sizing: border-box; }
 .panel { background: #131a22; border: 1px solid #1f2a36; border-radius: 6px; padding: 12px; overflow: auto; }
 .panel h2 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b8aaa; }
 .full { grid-column: 1 / -1; }
 pre { white-space: pre-wrap; word-break: break-word; background: #0b0f14; padding: 8px; border-radius: 4px; margin: 4px 0; }
 .row { display: flex; gap: 12px; align-items: center; }
 .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; background: #2a3a4d; color: #d6dde5; font-size: 11px; margin-right: 6px; }
 .badge.warn { background: #6a4a14; }
 .badge.err { background: #6a1f1f; }
 img { max-width: 100%; border: 1px solid #1f2a36; border-radius: 4px; }
 .recent { font-size: 12px; }
 .recent .item { padding: 6px 0; border-bottom: 1px solid #1f2a36; }
 a { color: #6cb4ff; }
 .typing { color: #ffd479; }
</style></head><body>
<div class="grid">
  <div class="panel full" id="top"><h2>Current interaction</h2><div id="curBody">starting…</div></div>
  <div class="panel" id="resp"><h2>App response</h2><div id="respBody">—</div></div>
  <div class="panel" id="log"><h2>Event log (most recent first)</h2><div id="logBody">—</div></div>
</div>
<script>
function esc(s){return String(s||"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function tick(){
  try {
    const s = await fetch("/state.json", {cache:"no-store"}).then(r=>r.json());
    const c = s.current || {};
    document.getElementById("curBody").innerHTML = \`
      <div class="row">
        <span class="badge">F\${c.function_number||"?"}</span>
        <span class="badge">int #\${s.totals.interactions}</span>
        <span class="badge \${s.totals.violations?"err":""}">violations \${s.totals.violations}</span>
        <span class="badge \${s.totals.concerns?"warn":""}">concerns \${s.totals.concerns}</span>
        <span class="badge \${s.totals.sanity_failures?"err":""}">sanity \${s.totals.sanity_failures}</span>
        <span>\${esc(s.status)}</span>
      </div>
      <h3>\${esc(c.function_name||"")} — \${esc(c.step_description||"")}</h3>
      <div><b>URL:</b> \${esc(c.url||"")}</div>
      <div><b>Approach:</b> \${esc(c.r1_approach||"")}</div>
      <div><b>Reasoning:</b> \${esc(c.r1_reasoning||"")}</div>
      <div><b>R1 typing (live):</b> <pre class="typing">\${esc(c.r1_input_so_far||"")}</pre></div>
      \${c.latest_screenshot?\`<img src="/screenshot/\${esc(c.latest_screenshot)}?t=\${Date.now()}">\`:""}
    \`;
    document.getElementById("respBody").innerHTML = \`
      <div><b>App response text (live):</b></div>
      <pre>\${esc(c.app_response_text||"")}</pre>
      <div><b>Network calls:</b></div>
      <pre>\${esc((c.network_calls||[]).map(n=>\`\${n.status||"…"} \${n.method} \${n.url}\`).join("\\n"))}</pre>
      <div><b>Judge critique:</b></div>
      <pre>\${esc(c.judge_critique||"(pending)")}</pre>
      \${c.invariant_violations && c.invariant_violations.length ? \`<div><b>Invariant violations:</b></div><pre style="color:#ff8a8a">\${esc(JSON.stringify(c.invariant_violations,null,2))}</pre>\`:""}
    \`;
    document.getElementById("logBody").innerHTML = \`<div class="recent">\${(s.recent_interactions||[]).map(i=>\`<div class="item"><b>F\${i.function_number}</b> · \${esc(i.step_description)} — \${esc(i.summary)}</div>\`).join("")}</div>\`;
    if (s.status === "complete" && s.report_url) {
      document.title = "R1 — RUN COMPLETE";
    }
  } catch(e) {}
}
setInterval(tick, 1000); tick();
</script></body></html>`;

// ============================================================================
// ANTHROPIC HELPERS
// ============================================================================
async function brainCall(systemPrompt, userPrompt, maxTokens = 800) {
  try {
    const resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = resp.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") || "";
    return text;
  } catch (err) {
    log("brain error:", err?.message || String(err));
    return `__BRAIN_ERROR__: ${err?.message || err}`;
  }
}

function safeParseJsonBlock(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) return null;
  try { return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)); } catch { return null; }
}

async function r1ChooseInput({ step, pageSummary, approachHints }) {
  const sys = `You are R1, a synthetic user beta-testing the AskThem app. For each step you pick one APPROACH from this list and produce one INPUT to type. Be specific and substantive. Approaches: substantive in-wheelhouse, leading invites-contradiction, out-of-period, minimum viable, very long contextualized, probe known constraint, trigger feature path, plausibly-wrong malformed. Reply ONLY as JSON: {"approach": "...", "reasoning": "one sentence", "input": "..."}`;
  const user = `STEP: ${step}\nPAGE SUMMARY: ${pageSummary}\nAPPROACH HINTS: ${approachHints || "open"}\nReturn JSON only.`;
  const raw = await brainCall(sys, user, 700);
  const parsed = safeParseJsonBlock(raw);
  if (parsed && parsed.input) return { ...parsed, raw };
  // Fallback so the harness keeps moving and the failure is recorded.
  return { approach: "fallback", reasoning: "brain returned unparseable JSON", input: "What is your most defensible position, and why?", raw };
}

async function judgeInteraction(interaction, quoteVerification) {
  const sys = `You are the JUDGE for R1's beta test of AskThem. Critique the interaction in 3-6 sentences of PROSE. Note: was the response in-voice and substantive? Did it speak AS the thinker (first person) or ABOUT the thinker (third person)? Did it stay on topic? Were the cited quotes verified? Flag anything broken, slow, off-character, or hallucinated. Reply ONLY as JSON: {"critique":"prose", "concerns":["..."], "speaks_as_thinker": true|false|null, "in_voice": true|false|null}`;
  const trimmed = (interaction.app_response?.page_text_after || "").slice(0, 6000);
  const user = `STEP: ${interaction.step_description}\nR1 INPUT: ${interaction.r1_input}\nAPP RESPONSE (truncated):\n${trimmed}\nQUOTE VERIFICATION: ${JSON.stringify(quoteVerification || {})}\nReply JSON only.`;
  const raw = await brainCall(sys, user, 900);
  const parsed = safeParseJsonBlock(raw) || { critique: raw || "judge returned no text", concerns: [], speaks_as_thinker: null, in_voice: null };
  if (typeof parsed.critique !== "string") parsed.critique = String(parsed.critique || "");
  if (!Array.isArray(parsed.concerns)) parsed.concerns = [];
  return parsed;
}

// ============================================================================
// QUOTE VERIFICATION
// ============================================================================
function extractQuotes(text) {
  if (!text) return [];
  const out = [];
  // Curly + straight double quotes
  const re = /[“"]([^”"]{15,400})[”"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1].trim());
  }
  return Array.from(new Set(out));
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function fuzzyContains(haystack, needle) {
  const H = normalize(haystack);
  const N = normalize(needle);
  if (!N) return false;
  if (H.includes(N)) return true;
  // Word-overlap fallback: require ≥80% of needle words to appear in same order within a 1.4× window.
  const hw = H.split(" "); const nw = N.split(" ");
  if (nw.length < 4) return false;
  for (let i = 0; i + nw.length <= hw.length; i++) {
    const window = hw.slice(i, i + Math.ceil(nw.length * 1.4)).join(" ");
    let hit = 0;
    for (const w of nw) if (window.includes(w)) hit++;
    if (hit / nw.length >= 0.8) return true;
  }
  return false;
}

async function verifyQuotesAgainstDb({ thinkerId, thinkerName, quotes, fetchJson }) {
  const queriesRan = [];
  const verified = [];
  const unverified = [];
  if (!quotes.length) return { quotes_found_in_response: [], quotes_verified: [], quotes_unverified: [], queries_ran: [] };
  // Try fetching the entire quotes set for the figure once.
  let allQuotes = [];
  let allChunks = [];
  for (const id of [thinkerId, thinkerName].filter(Boolean)) {
    const url = `${APP_URL}/api/quotes/${encodeURIComponent(id)}`;
    queriesRan.push(`GET ${url}`);
    try {
      const r = await fetchJson(url);
      if (Array.isArray(r)) allQuotes = allQuotes.concat(r);
    } catch (e) { queriesRan.push(`  ERROR: ${e.message}`); }
  }
  // Also try the random + search endpoints to be thorough.
  try {
    const url = `${APP_URL}/api/quotes/search?thinkerId=${encodeURIComponent(thinkerId)}`;
    queriesRan.push(`GET ${url}`);
    const r = await fetchJson(url);
    if (Array.isArray(r)) allQuotes = allQuotes.concat(r);
  } catch (e) { queriesRan.push(`  ERROR: ${e.message}`); }

  // Pull a sample of raw chunks too so the haystack includes prose, not just curated quotes.
  for (const id of [thinkerId, thinkerName].filter(Boolean)) {
    const url = `${APP_URL}/api/chunks/${encodeURIComponent(id)}?limit=200`;
    queriesRan.push(`GET ${url}`);
    try {
      const r = await fetchJson(url);
      if (Array.isArray(r)) for (const c of r) allChunks.push(c.text || c.content || c.chunk || "");
      else if (r && Array.isArray(r.chunks)) for (const c of r.chunks) allChunks.push(c.text || c.content || c.chunk || "");
    } catch (e) { queriesRan.push(`  ERROR: ${e.message}`); }
  }

  const haystack = allQuotes.map((q) => q.quote || q.text || q.content || "").join("\n") + "\n" + allChunks.join("\n");
  for (const q of quotes) {
    if (fuzzyContains(haystack, q)) verified.push(q);
    else unverified.push({ quote: q, queries_ran: queriesRan.slice(), haystack_size: haystack.length });
  }
  return { quotes_found_in_response: quotes, quotes_verified: verified, quotes_unverified: unverified, queries_ran: queriesRan };
}

// ============================================================================
// NETWORK CAPTURE
// ============================================================================
// Module-level shared sink. recordStep snapshots indices to attribute calls per step.
// chatViaApi (and any other context.request callers) also push synthetic entries here so
// step-level network tables are accurate even for non-page traffic.
const NETWORK_SINK = [];
function attachNetworkCapture(page) {
  const pending = new Map();
  page.on("request", (req) => {
    if (!req.url().includes("/api/")) return;
    pending.set(req, { method: req.method(), url: req.url(), started_at: Date.now(), request_body: (() => { try { return req.postData()?.slice(0, 50000) || null; } catch { return null; } })() });
  });
  page.on("response", async (resp) => {
    const req = resp.request();
    if (!req.url().includes("/api/")) return;
    const meta = pending.get(req) || { method: req.method(), url: req.url(), started_at: Date.now() };
    let body = null;
    let truncated = false;
    let streaming = false;
    const ct = resp.headers()["content-type"] || "";
    if (ct.includes("text/event-stream")) {
      streaming = true; // SSE bodies are best captured via the page DOM; we record metadata.
    } else {
      try {
        const buf = await resp.body();
        if (buf.length > 50000) { truncated = true; body = buf.slice(0, 50000).toString("utf8"); }
        else body = buf.toString("utf8");
      } catch (e) { body = `__BODY_READ_ERROR__: ${e.message}`; }
    }
    const entry = {
      ts: new Date().toISOString(),
      method: meta.method,
      url: req.url(),
      status: resp.status(),
      duration_ms: Date.now() - (meta.started_at || Date.now()),
      content_type: ct,
      streaming,
      request_body: meta.request_body || null,
      response_body: body,
      response_truncated: truncated,
    };
    pending.delete(req);
    writeNetwork(entry);
    NETWORK_SINK.push(entry);
  });
  page.on("requestfailed", (req) => {
    if (!req.url().includes("/api/")) return;
    const entry = { ts: new Date().toISOString(), method: req.method(), url: req.url(), failure: req.failure()?.errorText || "unknown", status: null };
    writeNetwork(entry); NETWORK_SINK.push(entry);
  });
}

// ============================================================================
// SCREENSHOT HELPER
// ============================================================================
let shotCounter = 0;
async function shoot(page, suffix) {
  shotCounter++;
  const name = `${String(shotCounter).padStart(4, "0")}-${suffix}.png`;
  const p = path.join(SCREENSHOTS_DIR, name);
  try { await page.screenshot({ path: p, fullPage: false }); } catch (e) { log("screenshot error", e.message); }
  updateLive({ current: { latest_screenshot: name } });
  return `screenshots/${name}`;
}

// ============================================================================
// STEP RECORDER
// ============================================================================
const RESULTS = []; // all transcript entries

async function recordStep(meta, runFn) {
  liveState.totals.interactions += 1;
  updateLive({ current: {
    function_number: meta.function_number,
    function_name: meta.function_name,
    step_description: meta.step_description,
    url: meta.url || null,
    r1_approach: meta.r1_approach || null,
    r1_reasoning: meta.r1_reasoning || null,
    r1_input_so_far: "",
    app_response_text: "",
    network_calls: [],
    judge_critique: null,
    invariant_violations: [],
    latest_screenshot: null,
  } });

  const sinkStartIdx = NETWORK_SINK.length; // snapshot so we can attribute calls to this step
  const interaction = {
    timestamp: new Date().toISOString(),
    function_number: meta.function_number,
    function_name: meta.function_name,
    step_description: meta.step_description,
    url: meta.url || null,
    is_interactive: !!meta.is_interactive,
    expected_routes: meta.expected_routes || [],
    r1_approach: meta.r1_approach || "",
    r1_reasoning: meta.r1_reasoning || "",
    r1_input: meta.r1_input || "",
    app_response: { page_text_after: "", errors_in_console: [], network_calls: [], sse_events_observed: [] },
    screenshots: [],
    judge_critique: "",
    judge_concerns: [],
    quote_verification: null,
    invariant_violations: [],
  };

  try {
    await runFn({ interaction, shoot: (suffix) => shoot(meta.page, suffix), live: (patch) => updateLive({ current: patch }) });
  } catch (err) {
    log("step error:", err?.message || String(err));
    interaction.invariant_violations.push({ kind: "harness_exception", detail: err?.message || String(err), stack: err?.stack });
    try { interaction.screenshots.push(await shoot(meta.page, "exception")); } catch {}
    try { interaction.app_response.errors_in_console.push(String(err?.message || err)); } catch {}
  }

  // Attribute network calls captured during this step (page-driven traffic AND synthetic
  // entries pushed by helpers like chatViaApi). Preserve anything the step already added.
  const stepCalls = NETWORK_SINK.slice(sinkStartIdx).map((n) => ({ method: n.method, url: n.url, status: n.status, content_type: n.content_type, streaming: n.streaming, duration_ms: n.duration_ms, response_truncated: n.response_truncated }));
  const seen = new Set(interaction.app_response.network_calls.map((c) => `${c.method} ${c.url} ${c.status}`));
  for (const c of stepCalls) {
    const key = `${c.method} ${c.url} ${c.status}`;
    if (!seen.has(key)) { interaction.app_response.network_calls.push(c); seen.add(key); }
  }

  // Update live with final state of this step
  updateLive({ current: { network_calls: interaction.app_response.network_calls } });

  // Persist
  writeTranscript(interaction);
  RESULTS.push(interaction);

  // Recent log summary
  const summary = interaction.invariant_violations.length
    ? `${interaction.invariant_violations.length} violation(s)`
    : (interaction.judge_concerns.length ? `${interaction.judge_concerns.length} concern(s)` : "ok");
  updateLive({ push_recent: { function_number: meta.function_number, step_description: meta.step_description, summary } });

  liveState.totals.concerns += interaction.judge_concerns.length;
  liveState.totals.violations += interaction.invariant_violations.length;
}

// ============================================================================
// THE TESTS
// ============================================================================
async function fetchJsonFromContext(context, url, extra = {}) {
  // Use Playwright's request context so cookies/session are shared.
  const r = await context.request.get(url, { failOnStatusCode: false, ...extra });
  const status = r.status();
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`non-JSON response ${status} from ${url}: ${text.slice(0, 200)}`); }
}

async function runLogin({ page, context }) {
  await recordStep(
    { page, function_number: 0, function_name: "Auth", step_description: "Attempt admin login per spec, then capture actual auth surface", is_interactive: true, expected_routes: [], r1_approach: "probe known constraint", r1_reasoning: "Spec assumes a hardcoded admin login; this AskThem uses Google OAuth + dev auto-login. Document reality." },
    async ({ interaction, shoot }) => {
      await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      interaction.screenshots.push(await shoot("before"));

      // Try the spec'd endpoint directly to see what happens.
      let postLogin;
      try {
        const r = await context.request.post(`${APP_URL}/api/login`, { data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }, failOnStatusCode: false, maxRedirects: 0 });
        postLogin = { status: r.status(), location: r.headers()["location"] || null };
      } catch (e) { postLogin = { error: e.message }; }
      interaction.r1_input = `POST /api/login {username:"${ADMIN_USERNAME}",password:"***"}`;
      interaction.screenshots.push(await shoot("typed"));

      // Check who we actually are.
      let me;
      try { me = await fetchJsonFromContext(context, `${APP_URL}/api/user`); }
      catch (e) { me = { error: e.message }; }

      interaction.app_response.page_text_after = `POST /api/login -> ${JSON.stringify(postLogin)}\nGET /api/user -> ${JSON.stringify(me)}`;
      interaction.screenshots.push(await shoot("after"));

      // The spec demands login work. If it doesn't, record as invariant violation but keep running (dev auto-login may still grant admin access on the server).
      if (postLogin?.status >= 400 || (me?.user == null)) {
        interaction.invariant_violations.push({
          kind: "auth_not_per_spec",
          detail: "Spec expected POST /api/login with username/password to authenticate. This AskThem build redirects /api/login to Google OAuth and relies on dev auto-login. /api/user returned no user during this run.",
          post_login: postLogin,
          api_user: me,
        });
      }

      interaction.judge_critique = "Auth surface diverges from the spec: this AskThem uses Google OAuth and a dev auto-login keyed on DEV_AUTO_LOGIN_EMAIL. The POST /api/login endpoint is a redirect to /api/auth/google. R1 logged the divergence and proceeded; downstream endpoints that require login may return empty results.";
      interaction.judge_concerns = postLogin?.status >= 400 ? ["Spec-specified login endpoint does not accept credentials."] : [];
    },
  );
}

async function fnFeatureAbsent({ page }, num, name, expectedRoutes, evidenceUrls = []) {
  await recordStep(
    { page, function_number: num, function_name: name, step_description: `Probe for ${name}`, is_interactive: false, expected_routes: [], r1_approach: "probe known constraint", r1_reasoning: "Per spec, if a function is not present, skip and note in the report." },
    async ({ interaction, shoot }) => {
      interaction.screenshots.push(await shoot("nav"));
      const probes = [];
      for (const u of evidenceUrls) {
        try {
          const r = await page.context().request.fetch(`${APP_URL}${u.path}`, { method: u.method, failOnStatusCode: false });
          probes.push({ method: u.method, path: u.path, status: r.status() });
        } catch (e) { probes.push({ method: u.method, path: u.path, error: e.message }); }
      }
      interaction.r1_input = "";
      interaction.app_response.page_text_after = `Probed expected routes:\n${probes.map((p) => `  ${p.method} ${p.path} -> ${p.status ?? p.error}`).join("\n")}`;
      interaction.judge_critique = `Feature absent in this AskThem build. The spec describes ${name} via routes ${expectedRoutes.join(", ")}; none of those routes are registered on this server (probes returned 404 or redirect). Per spec, R1 records this as a feature-absence note rather than a green check.`;
      interaction.invariant_violations.push({ kind: "feature_absent", expected_routes: expectedRoutes, probes });
    },
  );
}

async function getFigures(context) {
  try { return await fetchJsonFromContext(context, `${APP_URL}/api/figures`); }
  catch (e) { return []; }
}

const FIGURE_TO_NAME = {
  kuczynski: "J.-M. Kuczynski", freud: "Sigmund Freud", nietzsche: "Friedrich Nietzsche", marx: "Karl Marx",
  berkeley: "George Berkeley", james: "William James", plato: "Plato", spinoza: "Baruch Spinoza",
  russell: "Bertrand Russell", galileo: "Galileo Galilei", leibniz: "Gottfried Wilhelm Leibniz",
  aristotle: "Aristotle", kant: "Immanuel Kant", darwin: "Charles Darwin", bergson: "Henri Bergson",
  schopenhauer: "Arthur Schopenhauer", jung: "Carl Jung", aesop: "Aesop", newton: "Isaac Newton",
  hume: "David Hume", confucius: "Confucius", goldman: "Emma Goldman", hegel: "G.W.F. Hegel",
  locke: "John Locke", machiavelli: "Niccolò Machiavelli", voltaire: "Voltaire", rousseau: "Jean-Jacques Rousseau",
  tocqueville: "Alexis de Tocqueville", veblen: "Thorstein Veblen", smith: "Adam Smith", reich: "Wilhelm Reich",
  engels: "Friedrich Engels", dewey: "John Dewey", mill: "John Stuart Mill", descartes: "René Descartes",
  allen: "James Allen",
};

async function chatViaApi({ context, figureId, message, onChunk }) {
  // Manual fetch so we capture the raw SSE bytes for the network log + assemble final text deterministically.
  const url = `${APP_URL}/api/figures/${figureId}/chat`;
  const startedAt = Date.now();
  const res = await context.request.post(url, {
    data: { message, settings: { responseLength: 400, quoteFrequency: 2 } },
    failOnStatusCode: false,
    timeout: 120000,
  });
  const text = await res.text();
  // Parse SSE
  const events = [];
  let assembled = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") { events.push({ type: "done" }); continue; }
    try {
      const obj = JSON.parse(payload);
      events.push(obj);
      if (typeof obj.content === "string") { assembled += obj.content; onChunk && onChunk(assembled); }
    } catch { events.push({ raw: payload }); }
  }
  const network = {
    ts: new Date().toISOString(),
    method: "POST",
    url,
    status: res.status(),
    duration_ms: Date.now() - startedAt,
    content_type: res.headers()["content-type"] || "",
    streaming: true,
    request_body: JSON.stringify({ message, settings: { responseLength: 400, quoteFrequency: 2 } }),
    response_body: text.length > 50000 ? text.slice(0, 50000) : text,
    response_truncated: text.length > 50000,
  };
  writeNetwork(network);
  NETWORK_SINK.push(network); // ensure recordStep attributes this call to the current step
  return { status: res.status(), assembled, events, network };
}

async function function1Chat({ page, context }, figures) {
  const chosen = figures.slice(0, MAX_THINKERS_TO_CHAT);
  const approaches = [
    { hint: "substantive in-wheelhouse — pick a topic central to this thinker", label: "substantive in-wheelhouse" },
    { hint: "leading invites-contradiction — phrase question to invite contradicting their known views", label: "leading invites-contradiction" },
    { hint: "out-of-period — ask about something from after their lifetime, see if voice holds", label: "out-of-period" },
    { hint: "minimum viable — a single-word question like 'why?'", label: "minimum viable" },
  ];

  for (let i = 0; i < chosen.length; i++) {
    const fig = chosen[i];
    const approachHint = approaches[i % approaches.length];

    // Navigate UI: open the chat for this figure by clicking sidebar item.
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    try {
      const link = page.getByText(fig.name, { exact: true }).first();
      await link.waitFor({ timeout: 5000 });
      await link.click();
    } catch (e) {
      log(`Could not click sidebar entry for ${fig.name}: ${e.message}`);
    }
    await page.waitForTimeout(400);

    // Have R1 compose a question.
    const choice = await r1ChooseInput({
      step: `Ask ${fig.name} a question`,
      pageSummary: `Chat UI for figure "${fig.name}" (id: ${fig.id}). Figure description: ${fig.description || "(none)"}.`,
      approachHints: approachHint.hint,
    });
    if (approachHint.label === "minimum viable") choice.input = "Why?";
    if (approachHint.label === "very long contextualized" || i === chosen.length - 1) {
      // Bonus long question on the last thinker
      choice.input = choice.input + "\n\n" + ("Provide as much context as you need. Take seriously the strongest version of the contrary view, and explain how your own view survives or what it must concede. ".repeat(8));
    }

    await recordStep(
      { page, function_number: 1, function_name: "Chat with a single thinker", step_description: `Ask ${fig.name} — ${approachHint.label}`, url: page.url(), is_interactive: true, expected_routes: [`POST /api/figures/${fig.id}/chat`], r1_approach: choice.approach || approachHint.label, r1_reasoning: choice.reasoning || "" },
      async ({ interaction, shoot, live }) => {
        interaction.r1_input = choice.input;
        interaction.screenshots.push(await shoot("before"));

        // Find a textarea and type into it for the live view, then send via API for clean raw capture.
        try {
          const ta = page.locator("textarea").first();
          await ta.waitFor({ timeout: 5000 });
          await ta.click();
          await ta.fill("");
          // Type with delay so live view shows characters appear.
          let acc = "";
          for (const ch of choice.input) {
            acc += ch;
            await ta.type(ch, { delay: TYPE_DELAY_MS });
            if (acc.length % 8 === 0) live({ r1_input_so_far: acc });
          }
          live({ r1_input_so_far: acc });
        } catch (e) {
          log(`Could not type into chat textarea for ${fig.name}: ${e.message}`);
        }
        interaction.screenshots.push(await shoot("typed"));

        // FIRST: try clicking the actual Send button and verify the UI wires up the chat POST.
        // We watch network events for the expected POST /api/figures/:id/chat call.
        let uiTriggeredChat = false;
        try {
          const sendBtn = page.locator('button:has-text("Send"), button[type="submit"], button[aria-label*="end" i]').first();
          await sendBtn.waitFor({ timeout: 3000 });
          const waitChat = page.waitForRequest((req) => req.url().includes(`/api/figures/${fig.id}/chat`) && req.method() === "POST", { timeout: 5000 }).then(() => true).catch(() => false);
          await Promise.all([waitChat.then((ok) => { uiTriggeredChat = ok; }), sendBtn.click({ trial: false }).catch(() => {})]);
        } catch (e) {
          log(`UI Send for ${fig.name}: ${e.message}`);
        }
        if (!uiTriggeredChat) {
          interaction.invariant_violations.push({ kind: "ui_send_broken", detail: `Clicking the UI Send button did not trigger POST /api/figures/${fig.id}/chat within 5s. Falling back to direct API for capture; UI wiring may be broken.` });
        }

        // Either way: drive the response via direct API to deterministically capture SSE bytes.
        const result = await chatViaApi({
          context,
          figureId: fig.id,
          message: choice.input,
          onChunk: (assembled) => live({ app_response_text: assembled.slice(-4000) }),
        });
        interaction.app_response.page_text_after = result.assembled || `(no content; status ${result.status})`;
        interaction.app_response.sse_events_observed = result.events.slice(0, 200);
        interaction.app_response.network_calls.push({ method: "POST", url: result.network.url, status: result.network.status, content_type: result.network.content_type, streaming: true, duration_ms: result.network.duration_ms });

        await page.waitForTimeout(500);
        interaction.screenshots.push(await shoot("after"));

        // Quote verification
        const quotes = extractQuotes(result.assembled);
        const qv = await verifyQuotesAgainstDb({ thinkerId: fig.id, thinkerName: FIGURE_TO_NAME[fig.id], quotes, fetchJson: (u) => fetchJsonFromContext(context, u) });
        interaction.quote_verification = qv;
        for (const u of qv.quotes_unverified) {
          interaction.invariant_violations.push({ kind: "unverified_quote", thinker_id: fig.id, quote: u.quote, queries_ran: u.queries_ran });
        }

        // Judge
        const judged = await judgeInteraction(interaction, qv);
        interaction.judge_critique = judged.critique;
        interaction.judge_concerns = judged.concerns;
        if (judged.speaks_as_thinker === false) {
          interaction.invariant_violations.push({ kind: "speaks_about_not_as", detail: "Judge determined the response speaks ABOUT the thinker rather than AS the thinker." });
        }
        if (result.status >= 500) {
          interaction.invariant_violations.push({ kind: "5xx_response", status: result.status, url: result.network.url });
        }
        live({ judge_critique: judged.critique, invariant_violations: interaction.invariant_violations });
      },
    );
  }
}

async function function2MultiThinker({ page, context }, figures) {
  const a = figures.find((f) => f.id === "plato") || figures[0];
  const b = figures.find((f) => f.id === "nietzsche") || figures[1];
  if (!a || !b) return;
  await recordStep(
    { page, function_number: 2, function_name: "Multi-thinker dialogue / comparison", step_description: `Debate between ${a.name} and ${b.name}`, url: APP_URL, is_interactive: true, expected_routes: ["POST /api/debate/generate"], r1_approach: "trigger feature path", r1_reasoning: "Probe the multi-thinker debate endpoint exposed by this AskThem build." },
    async ({ interaction, shoot, live }) => {
      interaction.screenshots.push(await shoot("before"));
      const topic = "Is the just life also the happiest life?";
      interaction.r1_input = `topic="${topic}", participants=[${a.id}, ${b.id}]`;
      live({ r1_input_so_far: interaction.r1_input });
      interaction.screenshots.push(await shoot("typed"));
      let result;
      try {
        const res = await context.request.post(`${APP_URL}/api/debate/generate`, { data: { topic, philosopherA: a.id, philosopherB: b.id, rounds: 2 }, failOnStatusCode: false, timeout: 120000 });
        const text = await res.text();
        result = { status: res.status(), text, ct: res.headers()["content-type"] || "" };
        writeNetwork({ ts: new Date().toISOString(), method: "POST", url: `${APP_URL}/api/debate/generate`, status: res.status(), content_type: result.ct, response_body: text.slice(0, 50000), response_truncated: text.length > 50000 });
      } catch (e) {
        result = { status: 0, text: e.message, ct: "" };
      }
      interaction.app_response.page_text_after = (result.text || "").slice(0, 8000);
      interaction.app_response.network_calls.push({ method: "POST", url: `${APP_URL}/api/debate/generate`, status: result.status, content_type: result.ct, streaming: result.ct.includes("event-stream") });
      interaction.screenshots.push(await shoot("after"));

      const quotes = extractQuotes(result.text);
      const qvA = await verifyQuotesAgainstDb({ thinkerId: a.id, thinkerName: FIGURE_TO_NAME[a.id], quotes, fetchJson: (u) => fetchJsonFromContext(context, u) });
      const qvB = await verifyQuotesAgainstDb({ thinkerId: b.id, thinkerName: FIGURE_TO_NAME[b.id], quotes, fetchJson: (u) => fetchJsonFromContext(context, u) });
      const combinedVerified = new Set([...qvA.quotes_verified, ...qvB.quotes_verified]);
      interaction.quote_verification = {
        quotes_found_in_response: quotes,
        quotes_verified: Array.from(combinedVerified),
        quotes_unverified: quotes.filter((q) => !combinedVerified.has(q)).map((q) => ({ quote: q, queries_ran: [...qvA.queries_ran, ...qvB.queries_ran] })),
        per_thinker: { [a.id]: qvA, [b.id]: qvB },
      };
      for (const u of interaction.quote_verification.quotes_unverified) {
        interaction.invariant_violations.push({ kind: "unverified_quote", thinker_id: "debate", quote: u.quote, queries_ran: u.queries_ran });
      }
      if (result.status >= 500) interaction.invariant_violations.push({ kind: "5xx_response", status: result.status });

      const judged = await judgeInteraction(interaction, interaction.quote_verification);
      interaction.judge_critique = judged.critique;
      interaction.judge_concerns = judged.concerns;
      live({ judge_critique: judged.critique, invariant_violations: interaction.invariant_violations });
    },
  );
}

async function function3Browse({ page, context }) {
  await recordStep(
    { page, function_number: 3, function_name: "Browse / search figures", step_description: "Load figures list and compare API count to rendered count", url: APP_URL, is_interactive: false, expected_routes: ["GET /api/figures"], r1_approach: "trigger feature path", r1_reasoning: "Verify the rendered sidebar matches the API." },
    async ({ interaction, shoot, live }) => {
      await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);
      interaction.screenshots.push(await shoot("nav"));
      let apiList = [];
      try { apiList = await fetchJsonFromContext(context, `${APP_URL}/api/figures`); } catch (e) { apiList = []; interaction.invariant_violations.push({ kind: "5xx_response", detail: e.message, url: "/api/figures" }); }
      const renderedCount = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('a, button, div, span'));
        return els.filter((e) => /^[A-Z][a-zA-Z. ]{2,40}$/.test((e.textContent || "").trim())).length;
      });
      interaction.app_response.page_text_after = `API returned ${apiList.length} figures. Rendered nodes that look like figure names: ${renderedCount}.\nFirst 5 API names: ${apiList.slice(0,5).map(f=>f.name).join(", ")}`;
      interaction.app_response.network_calls.push({ method: "GET", url: `${APP_URL}/api/figures`, status: 200 });

      const judged = await judgeInteraction(interaction, null);
      interaction.judge_critique = judged.critique;
      interaction.judge_concerns = judged.concerns;
      if (apiList.length === 0) interaction.invariant_violations.push({ kind: "empty_figures_list", detail: "GET /api/figures returned no entries" });
      live({ judge_critique: judged.critique, invariant_violations: interaction.invariant_violations });
    },
  );
}

async function function4Detail({ page, context }, figures) {
  const target = figures.find((f) => f.id === "plato") || figures[0];
  if (!target) return;
  await recordStep(
    { page, function_number: 4, function_name: "Figure detail / profile", step_description: `Fetch detail for ${target.name}`, url: `${APP_URL}/api/figures/${target.id}`, is_interactive: false, expected_routes: [`GET /api/figures/${target.id}`], r1_approach: "trigger feature path", r1_reasoning: "Verify the detail endpoint returns coherent metadata that matches the list entry." },
    async ({ interaction, shoot, live }) => {
      interaction.screenshots.push(await shoot("nav"));
      let detail = null;
      try { detail = await fetchJsonFromContext(context, `${APP_URL}/api/figures/${target.id}`); } catch (e) { detail = { error: e.message }; }
      interaction.app_response.page_text_after = JSON.stringify(detail, null, 2).slice(0, 4000);
      interaction.app_response.network_calls.push({ method: "GET", url: `${APP_URL}/api/figures/${target.id}`, status: detail?.error ? 500 : 200 });
      if (!detail || detail.error) interaction.invariant_violations.push({ kind: "detail_missing", detail });
      else if (detail.name && target.name && !detail.name.toLowerCase().includes(target.name.toLowerCase().split(" ")[0])) {
        interaction.invariant_violations.push({ kind: "detail_name_mismatch", listed_name: target.name, detail_name: detail.name });
      }
      const judged = await judgeInteraction(interaction, null);
      interaction.judge_critique = judged.critique;
      interaction.judge_concerns = judged.concerns;
      live({ judge_critique: judged.critique, invariant_violations: interaction.invariant_violations });
    },
  );
}

async function function10AntiHallucination({ page, context }) {
  // Pull up to 3 chat responses with quotes from RESULTS.
  const candidates = RESULTS.filter((r) => r.function_number === 1 && r.quote_verification && r.quote_verification.quotes_found_in_response?.length > 0).slice(0, 3);
  await recordStep(
    { page, function_number: 10, function_name: "Anti-hallucination spot checks", step_description: `Re-verify quotes from ${candidates.length} prior chat responses against the public quote APIs`, url: APP_URL, is_interactive: false, expected_routes: candidates.flatMap((c) => [`GET /api/quotes/${c.quote_verification.per_thinker ? "" : ""}`]).filter(Boolean), r1_approach: "probe known constraint", r1_reasoning: "Independent re-verification: do the quoted passages exist in the thinker_quotes table?" },
    async ({ interaction, shoot, live }) => {
      interaction.screenshots.push(await shoot("nav"));
      const findings = [];
      for (const c of candidates) {
        const thinkerId = c.step_description.match(/Ask (\S+)/)?.[1] || "";
        const quotes = c.quote_verification.quotes_found_in_response || [];
        const figureId = (Object.entries(FIGURE_TO_NAME).find(([id, name]) => name === thinkerId || id === thinkerId.toLowerCase()) || [""])[0] || thinkerId.toLowerCase();
        const qv = await verifyQuotesAgainstDb({ thinkerId: figureId, thinkerName: FIGURE_TO_NAME[figureId], quotes, fetchJson: (u) => fetchJsonFromContext(context, u) });
        findings.push({ original_step: c.step_description, figure: figureId, quotes, verified: qv.quotes_verified, unverified: qv.quotes_unverified.map((u) => u.quote), queries_ran: qv.queries_ran });
        for (const u of qv.quotes_unverified) {
          interaction.invariant_violations.push({ kind: "unverified_quote", thinker_id: figureId, quote: u.quote, queries_ran: u.queries_ran, source_step: c.step_description });
        }
      }
      interaction.app_response.page_text_after = JSON.stringify(findings, null, 2);
      const judged = await judgeInteraction(interaction, { findings });
      interaction.judge_critique = judged.critique;
      interaction.judge_concerns = judged.concerns;
      live({ judge_critique: judged.critique, invariant_violations: interaction.invariant_violations });
    },
  );
}

// ============================================================================
// SANITY CHECKS
// ============================================================================
function sanityCheck() {
  const failures = [];
  for (const r of RESULTS) {
    // Route-specific expectation.
    for (const expected of r.expected_routes || []) {
      const [method, p] = expected.split(/\s+/);
      const got = (r.app_response.network_calls || []).some((n) => n.method === method && n.url.includes(p.replace(/^\//, "/")));
      if (!got) failures.push({ step: r.step_description, kind: "expected_route_not_fired", expected, got: r.app_response.network_calls.map((n) => `${n.method} ${n.url}`) });
    }
    if (r.is_interactive && (r.r1_input || "").length < 10 && r.function_number !== 0) {
      failures.push({ step: r.step_description, kind: "r1_input_too_short", length: (r.r1_input || "").length });
    }
    if (r.is_interactive && r.screenshots.length < 3) {
      failures.push({ step: r.step_description, kind: "insufficient_screenshots_interactive", count: r.screenshots.length });
    }
    if (!r.is_interactive && r.screenshots.length < 1) {
      failures.push({ step: r.step_description, kind: "missing_screenshot_navigation", count: r.screenshots.length });
    }
    if ((r.judge_critique || "").split(/\s+/).filter(Boolean).length < 30) {
      failures.push({ step: r.step_description, kind: "judge_critique_too_short", word_count: (r.judge_critique || "").split(/\s+/).filter(Boolean).length });
    }
    if (r.function_number === 1 && !r.quote_verification) {
      failures.push({ step: r.step_description, kind: "missing_quote_verification" });
    }
  }
  return failures;
}

// ============================================================================
// REPORT + FAILURES
// ============================================================================
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function writeReport(sanityFailures) {
  const byFn = new Map();
  for (const r of RESULTS) {
    if (!byFn.has(r.function_number)) byFn.set(r.function_number, []);
    byFn.get(r.function_number).push(r);
  }

  const toc = Array.from(byFn.keys()).sort((a, b) => a - b).map((n) => {
    const items = byFn.get(n);
    return `<li><a href="#fn-${n}">Function ${n} — ${esc(items[0].function_name)}</a> (${items.length} steps)</li>`;
  }).join("");

  const sections = Array.from(byFn.keys()).sort((a, b) => a - b).map((n) => {
    const items = byFn.get(n);
    const stepHtml = items.map((r, i) => `
      <article id="fn-${n}-step-${i}" style="border:1px solid #ccc;border-radius:6px;padding:14px;margin:12px 0;">
        <h3>${esc(r.step_description)}</h3>
        <p><b>Approach:</b> ${esc(r.r1_approach)}<br><b>Reasoning:</b> ${esc(r.r1_reasoning)}<br><b>URL:</b> ${esc(r.url || "")}<br><b>Expected routes:</b> ${esc((r.expected_routes || []).join(", ") || "(none)")}</p>
        <h4>R1 typed</h4>
        <pre>${esc(r.r1_input || "(no input — navigation step)")}</pre>
        <h4>App response (page text after)</h4>
        <pre>${esc(r.app_response.page_text_after || "(empty)")}</pre>
        <h4>Network calls</h4>
        <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px;">
          <tr><th>method</th><th>url</th><th>status</th><th>ct</th><th>stream</th><th>ms</th></tr>
          ${(r.app_response.network_calls || []).map((n) => `<tr><td>${esc(n.method)}</td><td style="max-width:480px;word-break:break-all">${esc(n.url)}</td><td>${esc(n.status)}</td><td>${esc(n.content_type || "")}</td><td>${n.streaming ? "yes" : ""}</td><td>${esc(n.duration_ms || "")}</td></tr>`).join("")}
        </table>
        ${(r.app_response.errors_in_console || []).length ? `<h4>Console errors</h4><pre>${esc(r.app_response.errors_in_console.join("\n"))}</pre>` : ""}
        <h4>Screenshots</h4>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">${(r.screenshots || []).map((s) => `<figure style="margin:0;"><img src="${esc(s)}" style="max-width:380px;border:1px solid #ccc;"><figcaption style="font-size:11px;">${esc(s)}</figcaption></figure>`).join("")}</div>
        <h4>Judge critique</h4>
        <p>${esc(r.judge_critique || "(none)")}</p>
        ${r.judge_concerns?.length ? `<h4>Judge concerns</h4><ul>${r.judge_concerns.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
        ${r.quote_verification ? `<h4>Quote verification</h4>
          <p><b>Quotes found in response:</b> ${r.quote_verification.quotes_found_in_response.length}</p>
          <p><b>Verified:</b> ${r.quote_verification.quotes_verified.length}</p>
          <p><b>Unverified:</b> ${r.quote_verification.quotes_unverified.length}</p>
          ${r.quote_verification.quotes_unverified.length ? `<h5>Unverified quotes</h5><pre>${esc(JSON.stringify(r.quote_verification.quotes_unverified, null, 2))}</pre>` : ""}
          <h5>Queries the verifier ran</h5><pre>${esc((r.quote_verification.queries_ran || []).join("\n"))}</pre>
        ` : ""}
        ${r.invariant_violations?.length ? `<h4 style="color:#b00">Invariant violations</h4><pre style="background:#fee;color:#600;padding:8px;border-radius:4px;">${esc(JSON.stringify(r.invariant_violations, null, 2))}</pre>` : ""}
      </article>
    `).join("\n");
    return `<section id="fn-${n}"><h2>Function ${n} — ${esc(items[0].function_name)}</h2>${stepHtml}</section>`;
  }).join("\n");

  const totals = liveState.totals;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>R1 report — ${esc(RUN_TS)}</title>
  <style>body{font:14px/1.5 -apple-system, system-ui, sans-serif; max-width:1100px; margin:20px auto; padding:0 12px;} pre{white-space:pre-wrap; word-break:break-word; background:#f6f8fa; padding:10px; border-radius:4px;} nav{position:sticky; top:0; background:#fff; border-bottom:1px solid #ddd; padding:8px 0; margin-bottom:16px;} h2{margin-top:32px;}</style>
  </head><body>
  <h1>R1 — AskThem beta test report</h1>
  <p><b>Run:</b> ${esc(RUN_TS)} &middot; <b>App:</b> ${esc(APP_URL)} &middot; <b>Model:</b> ${esc(ANTHROPIC_MODEL)}</p>
  <p><b>Interactions:</b> ${totals.interactions} &middot; <b>Judge concerns:</b> ${totals.concerns} &middot; <b>Critical invariant violations:</b> ${totals.violations} &middot; <b>Harness sanity failures:</b> ${sanityFailures.length}</p>
  <nav><b>Functions:</b><ul>${toc}</ul></nav>
  ${sanityFailures.length ? `<section><h2 style="color:#b00">Harness sanity failures</h2><pre>${esc(JSON.stringify(sanityFailures, null, 2))}</pre></section>` : ""}
  ${sections}
  </body></html>`;
  fs.writeFileSync(path.join(OUTPUT_DIR, "report.html"), html);
}

function writeFailuresMd(sanityFailures) {
  const violations = RESULTS.flatMap((r) => (r.invariant_violations || []).map((v) => ({ ...v, step: r.step_description, function: r.function_number })));
  const lines = [];
  lines.push("# CRITICAL INVARIANT VIOLATIONS");
  lines.push("");
  if (violations.length === 0) lines.push("_None recorded._");
  for (const v of violations) {
    lines.push(`## [F${v.function}] ${v.step} — ${v.kind}`);
    if (v.quote) lines.push(`- **Quote:** ${JSON.stringify(v.quote)}`);
    if (v.thinker_id) lines.push(`- **Thinker:** ${v.thinker_id}`);
    if (v.queries_ran) lines.push(`- **Queries the judge ran:**\n\n\`\`\`\n${v.queries_ran.join("\n")}\n\`\`\``);
    if (v.detail) lines.push(`- **Detail:** ${v.detail}`);
    if (v.expected_routes) lines.push(`- **Expected routes:** ${v.expected_routes.join(", ")}`);
    if (v.probes) lines.push(`- **Probe results:** \n\n\`\`\`json\n${JSON.stringify(v.probes, null, 2)}\n\`\`\``);
    if (v.status) lines.push(`- **Status:** ${v.status}`);
    if (v.stack) lines.push(`- **Stack:**\n\n\`\`\`\n${v.stack}\n\`\`\``);
    lines.push(`- [View in report](report.html#fn-${v.function})`);
    lines.push("");
  }
  lines.push("");
  lines.push("# Judge concerns");
  lines.push("");
  for (const r of RESULTS) {
    if (!r.judge_concerns?.length) continue;
    lines.push(`## [F${r.function_number}] ${r.step_description}`);
    for (const c of r.judge_concerns) lines.push(`- ${c}`);
    lines.push(`- [View in report](report.html#fn-${r.function_number})`);
    lines.push("");
  }
  lines.push("");
  lines.push("# Harness sanity failures");
  lines.push("");
  if (sanityFailures.length === 0) lines.push("_None._");
  for (const f of sanityFailures) lines.push(`- **${f.kind}** at "${f.step}": ${JSON.stringify(f).slice(0, 600)}`);
  fs.writeFileSync(path.join(OUTPUT_DIR, "failures.md"), lines.join("\n"));
}

function writeRunSummary(sanityFailures) {
  const totals = liveState.totals;
  const unverified = RESULTS.flatMap((r) => (r.quote_verification?.quotes_unverified || [])).length;
  const txt = [
    `INTERACTIONS: ${totals.interactions}`,
    `JUDGE CONCERNS RAISED: ${totals.concerns}`,
    `CRITICAL INVARIANT VIOLATIONS: ${totals.violations}`,
    `UNVERIFIED QUOTES: ${unverified}`,
    `HARNESS SANITY FAILURES: ${sanityFailures.length}`,
  ].join("\n");
  fs.writeFileSync(path.join(OUTPUT_DIR, "run-summary.txt"), txt + "\n");
}

function writeExpectedVsActual() {
  const md = `# expected vs actual — AskThem API surface

The spec describes a hypothetical AskThem with admin CRUD for thinkers. This AskThem build has a different surface. R1 records the divergence here so a reviewer can see what is missing without combing the report.

| Spec function | Spec routes | Actual in this build |
|---|---|---|
| 1 Chat single thinker | POST /api/chat | **Present**: \`POST /api/figures/:figureId/chat\` (SSE; \`{content}\` chunks + \`auditEvent\` events + \`[DONE]\`) |
| 2 Multi-thinker | POST /api/dialogue (spec) | **Present as**: \`POST /api/debate/generate\` |
| 3 Browse | GET /api/thinkers | **Present as**: \`GET /api/figures\` |
| 4 Detail | GET /api/thinkers/:id | **Present as**: \`GET /api/figures/:figureId\` |
| 5 Create thinker | POST /api/admin/thinkers | **Absent** — no admin CRUD for figures |
| 6 Upload text | POST /api/admin/thinkers/:id/upload-text | **Absent** |
| 7 Extract positions/quotes | per blueprint | **Absent as admin trigger**; auto-runs internally |
| 8 Chat against new thinker | depends on 5–7 | **Skipped** (5–7 absent) |
| 9 Delete thinker | DELETE /api/admin/thinkers/:id | **Absent** |
| 10 Anti-hallucination | GET /api/admin/thinkers/:id/quotes?search= | **Approximated via**: \`GET /api/quotes/:thinkerId\` and \`GET /api/quotes/search?thinkerId=…\` |
| Auth | POST /api/login with username/password | **Diverged**: Google OAuth via \`/api/auth/google\`; \`POST /api/login\` is a redirect to OAuth; dev environment has auto-login |
`;
  fs.writeFileSync(path.join(OUTPUT_DIR, "expected-vs-actual.md"), md);
}

// ============================================================================
// MAIN
// ============================================================================
console.log(`R1 is running.`);
console.log(`Live view:    http://localhost:${LIVE_VIEW_PORT}`);
console.log(`Output dir:   ${OUTPUT_DIR}`);
console.log(`Watch the live view; do not trust summary output alone.`);

let browser, context, page;
let exitCode = 0;
try {
  browser = await chromium.launch({ headless: HEADLESS });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  page.on("console", (msg) => log(`[browser ${msg.type()}]`, msg.text().slice(0, 500)));
  page.on("pageerror", (err) => log("[pageerror]", err.message));
  attachNetworkCapture(page);

  writeExpectedVsActual();

  await runLogin({ page, context });

  const figures = await getFigures(context);

  if (!SKIP_FUNCTIONS.has("1") && figures.length) await function1Chat({ page, context }, figures);
  if (!SKIP_FUNCTIONS.has("2") && figures.length >= 2) await function2MultiThinker({ page, context }, figures);
  if (!SKIP_FUNCTIONS.has("3")) await function3Browse({ page, context });
  if (!SKIP_FUNCTIONS.has("4") && figures.length) await function4Detail({ page, context }, figures);
  if (!SKIP_FUNCTIONS.has("5")) await fnFeatureAbsent({ page }, 5, "Admin: thinker creation", ["POST /api/admin/thinkers"], [{ method: "POST", path: "/api/admin/thinkers" }]);
  if (!SKIP_FUNCTIONS.has("6")) await fnFeatureAbsent({ page }, 6, "Admin: text upload / ingestion", ["POST /api/admin/thinkers/:id/upload-text"], [{ method: "POST", path: "/api/admin/thinkers/test/upload-text" }]);
  if (!SKIP_FUNCTIONS.has("7")) await fnFeatureAbsent({ page }, 7, "Admin: positions / quotes extraction", ["POST /api/admin/thinkers/:id/extract"], [{ method: "POST", path: "/api/admin/thinkers/test/extract" }]);
  if (!SKIP_FUNCTIONS.has("8")) await fnFeatureAbsent({ page }, 8, "Chat against newly-created test thinker", ["depends on F5-F7"], []);
  if (!SKIP_FUNCTIONS.has("9")) await fnFeatureAbsent({ page }, 9, "Admin: thinker deletion / cleanup", ["DELETE /api/admin/thinkers/:id"], [{ method: "DELETE", path: "/api/admin/thinkers/test" }]);
  if (!SKIP_FUNCTIONS.has("10")) await function10AntiHallucination({ page, context });

  const sanityFailures = sanityCheck();
  liveState.totals.sanity_failures = sanityFailures.length;

  writeReport(sanityFailures);
  writeFailuresMd(sanityFailures);
  writeRunSummary(sanityFailures);

  updateLive({ status: "complete", report_url: path.join(OUTPUT_DIR, "report.html") });

  // Exit code precedence: 3 > 2 > 1 > 0
  if (sanityFailures.length) exitCode = 3;
  else if (liveState.totals.violations) exitCode = 2;
  else if (liveState.totals.concerns) exitCode = 1;

  console.log(`\nR1 finished.`);
  console.log(`Open the report:     ${path.join(OUTPUT_DIR, "report.html")}`);
  console.log(`Open the failures:   ${path.join(OUTPUT_DIR, "failures.md")}`);
  console.log(`Raw transcript:      ${path.join(OUTPUT_DIR, "transcript.jsonl")}`);
  console.log(`Raw network log:     ${path.join(OUTPUT_DIR, "network.log")}`);
  console.log(`\nExit code: ${exitCode}`);
} catch (err) {
  log("FATAL:", err?.stack || err?.message || String(err));
  exitCode = 3;
} finally {
  try { await browser?.close(); } catch {}
  // Keep live view open after exit so the operator can still see the final state.
  // Set LIVE_VIEW_LINGER_MS=0 in smoke/CI to exit immediately.
  const linger = parseInt(process.env.LIVE_VIEW_LINGER_MS ?? "60000", 10);
  if (linger <= 0) { try { liveServer.close(); } catch {} process.exit(exitCode); }
  else setTimeout(() => { try { liveServer.close(); } catch {} process.exit(exitCode); }, linger).unref();
}
