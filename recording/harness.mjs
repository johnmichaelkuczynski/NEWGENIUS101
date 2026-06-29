import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.TARGET_URL || 'http://localhost:5000';
const OUT_DIR = path.join(__dirname, 'videos');
const W = 1280, H = 800;

fs.mkdirSync(OUT_DIR, { recursive: true });

const t0 = Date.now();
function ts() { const s = Math.floor((Date.now() - t0) / 1000); return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
function log(...a) { console.log(`[${ts()}]`, ...a); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ------- fake cursor injected into the page -------
const CURSOR_SCRIPT = `
(() => {
  if (window.__cursorInit) return; window.__cursorInit = true;
  const ensure = () => {
    if (document.getElementById('__vcursor')) return;
    const c = document.createElement('div');
    c.id = '__vcursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;margin-left:-3px;margin-top:-3px;transition:transform .04s linear;';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 2 L2 16 L6 12 L9 19 L12 18 L9 11 L15 11 Z" fill="black" stroke="white" stroke-width="1.4"/></svg>';
    document.documentElement.appendChild(c);
    const ring = document.createElement('div');
    ring.id='__vring';
    ring.style.cssText='position:fixed;left:0;top:0;width:34px;height:34px;border:3px solid rgba(59,130,246,.9);border-radius:50%;z-index:2147483646;pointer-events:none;margin-left:-17px;margin-top:-17px;opacity:0;transform:scale(.4);transition:opacity .25s,transform .25s;';
    document.documentElement.appendChild(ring);
  };
  ensure();
  const move = (x,y) => { const c=document.getElementById('__vcursor'); if(c) c.style.transform='translate('+x+'px,'+y+'px)'; const r=document.getElementById('__vring'); if(r){r.style.left=x+'px';r.style.top=y+'px';} };
  document.addEventListener('mousemove', e => move(e.clientX, e.clientY), true);
  document.addEventListener('mousedown', e => { const r=document.getElementById('__vring'); if(r){r.style.left=e.clientX+'px';r.style.top=e.clientY+'px';r.style.opacity='1';r.style.transform='scale(1)';setTimeout(()=>{r.style.opacity='0';r.style.transform='scale(.4)';},260);} }, true);
  setInterval(ensure, 1500);
})();
`;

let page;
async function glideTo(loc) {
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(()=>{});
    const box = await loc.boundingBox();
    if (!box) return null;
    const x = box.x + box.width / 2, y = box.y + Math.min(box.height/2, box.height-3);
    await page.mouse.move(x, y, { steps: 22 });
    await sleep(220);
    return { x, y };
  } catch { return null; }
}
async function click(loc, opts={}) {
  await glideTo(loc);
  try {
    await loc.click({ timeout: 12000, ...opts });
  } catch (e) {
    await dismissOverlays();
    await glideTo(loc);
    await loc.click({ timeout: 8000, force: true, ...opts });
  }
  await sleep(350);
}
async function typeInto(loc, text, delay=6) {
  await glideTo(loc);
  await loc.click({ timeout: 15000 }).catch(()=>{});
  try { await loc.fill(''); } catch {}
  await loc.pressSequentially(text, { delay });
  await sleep(300);
}
async function selectRadix(triggerLoc, optionName, { required = true } = {}) {
  const before = (await triggerLoc.innerText().catch(() => '')).trim();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await dismissOverlays();
    await click(triggerLoc);
    await sleep(500);
    let opt = page.getByRole('option', { name: optionName, exact: true }).first();
    if (!(await opt.count())) opt = page.locator('[role="option"]', { hasText: optionName }).first();
    let clicked = false;
    if (await opt.count()) {
      try {
        await opt.scrollIntoViewIfNeeded().catch(() => {});
        await glideTo(opt);
        await opt.click({ timeout: 5000 });
        clicked = true;
      } catch {
        try { await opt.click({ timeout: 4000, force: true }); clicked = true; } catch {}
      }
    }
    if (!clicked) {
      // Radix typeahead: focus is on the open listbox; type to highlight, Enter to commit.
      await page.keyboard.type(optionName, { delay: 45 });
      await sleep(750);
      await page.keyboard.press('Enter');
    }
    await sleep(500);
    if (await page.locator('[role="listbox"],[role="option"]').count()) { await page.keyboard.press('Escape').catch(() => {}); await sleep(200); }
    const after = (await triggerLoc.innerText().catch(() => '')).trim();
    if (after && after !== before) { log(`  selectRadix: "${optionName}" committed -> "${after}"`); return after; }
    log(`  selectRadix: attempt ${attempt} for "${optionName}" did not commit (trigger="${after}")`);
  }
  if (required) throw new Error(`selectRadix failed to commit "${optionName}"`);
  return null;
}
async function scrollPage(px, steps=12) {
  const per = px / steps;
  for (let i=0;i<steps;i++){ await page.mouse.wheel(0, per); await sleep(280); }
}
async function scrollEl(loc, total=1400, steps=10) {
  try {
    const h = await loc.elementHandle();
    if (!h) return;
    for (let i=0;i<steps;i++){ await page.evaluate(([el,d])=>{ el.scrollBy(0,d); }, [h, total/steps]); await sleep(300); }
  } catch {}
}
async function waitVisible(loc, capMs, label) {
  const start = Date.now();
  while (Date.now()-start < capMs) {
    try { if (await loc.first().isVisible()) { log(`  done-signal: ${label} (${Math.round((Date.now()-start)/1000)}s)`); return true; } } catch {}
    await sleep(2000);
  }
  log(`  WARN: ${label} not visible within ${Math.round(capMs/1000)}s`);
  return false;
}
// Wait until a locator's text stabilizes (streaming finished). Optionally auto-scroll a container to follow stream.
async function waitStable(loc, { stableMs=10000, capMs=300000, pollMs=2500, scroll=null } = {}, label='') {
  const start = Date.now(); let last=''; let lastChange=Date.now(); let started=false;
  while (Date.now()-start < capMs) {
    let txt='';
    try { txt = await loc.first().innerText({ timeout: 5000 }); } catch {}
    if (txt !== last) { last = txt; lastChange = Date.now(); if (txt.trim().length>3) started=true; }
    if (scroll) { try { const h = await scroll.elementHandle(); if (h) await page.evaluate(el=>el.scrollTo(0, el.scrollHeight), h); } catch {} }
    if (started && (Date.now()-lastChange) >= stableMs) { log(`  stable: ${label} after ${Math.round((Date.now()-start)/1000)}s, ${last.length} chars`); return last; }
    await sleep(pollMs);
  }
  log(`  WARN: ${label} cap reached (${Math.round(capMs/1000)}s), ${last.length} chars`);
  return last;
}
async function dismissOverlays() {
  await page.keyboard.press('Escape').catch(()=>{});
  await sleep(300);
}
// Compare-modal is a CUSTOM modal (div.fixed.z-50, NOT role="dialog"). Both columns stream
// concurrently; avatars carry `.animate-spin` only while isStreaming1/2 is true. Done = no
// spinner visible AND the window text has settled.
async function waitCompare({ stableMs=9000, capMs=420000, pollMs=2500 } = {}, label='comparison stream') {
  const win = page.locator('div.fixed.z-50').last();
  const start=Date.now(); let last=''; let lastChange=Date.now(); let started=false;
  while (Date.now()-start < capMs) {
    let txt=''; try { txt = await win.innerText({ timeout: 5000 }); } catch {}
    if (txt !== last) { last = txt; lastChange = Date.now(); if (txt.trim().length>20) started=true; }
    // follow both streaming columns
    try { await page.evaluate(()=>{ document.querySelectorAll('div.fixed.z-50 [data-radix-scroll-area-viewport], div.fixed.z-50 .overflow-y-auto').forEach(el=>el.scrollTo(0, el.scrollHeight)); }); } catch {}
    let spinning=false;
    try { spinning = (await page.locator('div.fixed.z-50 .animate-spin').count()) > 0; } catch {}
    if (started && !spinning && (Date.now()-lastChange) >= stableMs) {
      log(`  stable: ${label} after ${Math.round((Date.now()-start)/1000)}s, ${last.length} chars`); return last;
    }
    await sleep(pollMs);
  }
  log(`  WARN: ${label} cap reached (${Math.round(capMs/1000)}s), ${last.length} chars`);
  return last;
}
async function closeFigureChat() {
  for (let i=0;i<3;i++){
    const closeBtn = page.locator('button[title="Close"]').first();
    if ((await closeBtn.count()) && await closeBtn.isVisible().catch(()=>false)) {
      await closeBtn.click({ timeout: 5000 }).catch(()=>{});
      await sleep(500);
    }
    // fallback: click the semi-transparent backdrop to dismiss
    const backdrop = page.locator('div.fixed.inset-0.z-40').first();
    if ((await backdrop.count()) && await backdrop.isVisible().catch(()=>false)) {
      await backdrop.click({ position: { x: 6, y: 6 }, force: true }).catch(()=>{});
      await sleep(500);
    } else {
      break;
    }
  }
  await dismissOverlays();
}
async function closeAllMiniPopups() {
  for (let i=0;i<6;i++){
    const c = page.locator('[data-testid="button-mini-close"]').first();
    if ((await c.count()) && await c.isVisible().catch(()=>false)) { await c.click().catch(()=>{}); await sleep(350); }
    else break;
  }
}
// Universal generator driver: clicks Generate, expands the streaming popup, follows the
// stream, and finishes when the Stop button disappears (isGenerating=false) and text settles.
async function runPopupGenerator(genBtn, label, capMs=360000) {
  await closeAllMiniPopups();
  await click(genBtn);
  log(`  generating ${label}...`);
  const dlg = page.locator('[role="dialog"]').last();
  const t0 = Date.now();
  while (Date.now()-t0 < 35000) {
    if (await dlg.isVisible().catch(()=>false)) break;
    const exp = page.locator('[data-testid="button-mini-expand"]').first();
    if ((await exp.count()) && await exp.isVisible().catch(()=>false)) { await exp.click().catch(()=>{}); await sleep(900); }
    await sleep(1000);
  }
  if (!(await dlg.isVisible().catch(()=>false))) log(`  WARN: ${label} popup not visible after start`);
  const stopBtn = page.locator('[data-testid="button-popup-stop"]').first();
  await stopBtn.waitFor({ state:'visible', timeout:30000 }).catch(()=>{});
  const s2 = Date.now(); let lastLen=-1, lastChange=Date.now();
  while (Date.now()-s2 < capMs) {
    const gen = await stopBtn.isVisible().catch(()=>false);
    let len=0; try { len = (await dlg.innerText({ timeout:4000 })).length; } catch {}
    if (len !== lastLen) { lastLen = len; lastChange = Date.now(); }
    if (!gen && (Date.now()-lastChange) > 4000 && lastLen > 0) break;
    await sleep(2500);
  }
  log(`  ${label} finished (~${Math.round((Date.now()-s2)/1000)}s, ${lastLen} chars)`);
  await sleep(2000);
  const close = page.locator('[data-testid="button-popup-close"]').first();
  if (await close.count()) await close.click().catch(()=>dismissOverlays());
  await sleep(700);
}
async function segment(name, fn) {
  await dismissOverlays();
  log(`==== SEGMENT: ${name} ====`);
  try { await fn(); } catch (e) { log(`  ERROR in ${name}: ${e.message.split('\n')[0]}`); }
  await dismissOverlays();
  await sleep(700);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--force-color-profile=srgb'] });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT_DIR, size: { width: W, height: H } },
  });
  await context.addInitScript(CURSOR_SCRIPT);
  page = await context.newPage();
  page.on('console', m => { if (m.type()==='error') log('  [browser console error]', m.text().slice(0,160)); });

  log('Navigating to', TARGET);
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(()=>{});
  await page.evaluate(CURSOR_SCRIPT).catch(()=>{});
  await sleep(2500);
  await dismissOverlays();
  await sleep(1500);

  // Wait until a textarea/input value stops changing (streaming finished).
  const waitInputStable = async (loc, { stableMs=7000, capMs=180000, pollMs=2500 } = {}, label='') => {
    const start=Date.now(); let last=''; let lastChange=Date.now(); let started=false;
    while (Date.now()-start < capMs) {
      let v=''; try { v = await loc.first().inputValue({ timeout: 4000 }); } catch {}
      if (v !== last) { last = v; lastChange = Date.now(); if (v.trim().length>3) started=true; }
      if (started && (Date.now()-lastChange) >= stableMs) { log(`  stable: ${label} after ${Math.round((Date.now()-start)/1000)}s, ${last.length} chars`); return last; }
      await sleep(pollMs);
    }
    log(`  WARN: ${label} cap (${Math.round(capMs/1000)}s), ${last.length} chars`); return last;
  };
  // Move the global Intensity meter (sidebar). 'low' = Home (Book report), 'high' = End (Wild man).
  async function setIntensity(which) {
    await page.evaluate(()=>window.scrollTo({top:0})); await sleep(500);
    const slider = page.getByTestId('slider-intensity-level').getByRole('slider').first();
    await glideTo(slider); await slider.focus().catch(()=>{});
    await page.keyboard.press(which==='low' ? 'Home' : 'End');
    await sleep(1100);
    const lbl = await page.getByTestId('text-intensity-level').innerText().catch(()=>'');
    log(`  intensity (${which}) ->`, lbl);
  }
  // Send a chat message and wait for a NEW assistant reply (handles reopened chats that show prior history).
  const askInChat = async (question, label, capMs = 300000) => {
    const sel = '[data-testid^="figure-message-"]';
    const before = await page.locator(sel).count();
    await typeInto(page.getByTestId('input-figure-message'), question, 4); await sleep(400);
    await click(page.getByTestId('button-send-figure-message'));
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if ((await page.locator(sel).count()) >= before + 2) break;
      await sleep(1500);
    }
    await waitStable(page.locator(sel).last(), { stableMs: 11000, capMs, pollMs: 3000 }, label);
  };

  // brief sidebar pan to show the roster of thinkers (no intro screen)
  await segment('Sidebar roster pan', async () => {
    const firstBtn = page.locator('[data-testid^="button-talk-"]').first();
    await glideTo(firstBtn);
    for (let i=0;i<6;i++){ await page.mouse.wheel(0, 320); await sleep(380); }
    for (let i=0;i<4;i++){ await page.mouse.wheel(0, -360); await sleep(300); }
    await sleep(600);
  });

  // ===== A. TURN A STATEMENT INTO AN ESSAY (Paper Writer) — multiple thinkers =====
  await segment('Essay from statement — Kuczynski (Aesthetics upload)', async () => {
    const sec = page.locator('#paper-writer-section');
    await sec.scrollIntoViewIfNeeded(); await sleep(800);
    await selectRadix(sec.getByTestId('select-philosopher-paper'), 'Kuczynski');
    const S = "Turn the following statement into an essay: Beauty and ugliness are categorically identical with, respectively, content-bioavailability and content-non-bioavailability. A literary work is beautiful when its style and narration make its content easy to absorb, and ugly when they do not.";
    await typeInto(sec.getByTestId('input-topic-paper'), S, 3);
    await typeInto(sec.getByTestId('input-word-length'), '700', 40);
    await sleep(400);
    await runPopupGenerator(sec.getByTestId('button-generate-paper'), 'essay (Kuczynski)', 360000);
  });
  await segment('Essay from statement — Freud (Aggression vs Sexuality upload)', async () => {
    const sec = page.locator('#paper-writer-section');
    await sec.scrollIntoViewIfNeeded(); await sleep(800);
    await selectRadix(sec.getByTestId('select-philosopher-paper'), 'Freud');
    const S = "Turn the following statement into an essay: It is aggression, not sexuality, that is the primary object of repression. We repress sexuality only to the extent that it is informed by aggression; masochism is inverted aggression turned against the self.";
    await typeInto(sec.getByTestId('input-topic-paper'), S, 3);
    await typeInto(sec.getByTestId('input-word-length'), '700', 40);
    await sleep(400);
    await runPopupGenerator(sec.getByTestId('button-generate-paper'), 'essay (Freud)', 360000);
  });

  // ===== B. EVALUATE A STATEMENT (figure chat) =====
  await segment('Evaluate a statement — Hume (free will, from upload)', async () => {
    const search = page.getByTestId('input-search-figures');
    await typeInto(search, 'Hume', 60); await sleep(800);
    await click(page.getByTestId('button-talk-hume')); await sleep(1500);
    await click(page.getByTestId('button-audit-trail')).catch(()=>{}); await sleep(800);
    const Q = "Evaluate this statement: Freedom is not about being outside the web of causal law; it is about one's choices making a difference within that causal law. Do you agree, and why?";
    log('  sent evaluate-statement to Hume; awaiting audited answer...');
    await askInChat(Q, 'Hume evaluation');
    await scrollPage(500, 6); await sleep(1200);
  });
  await closeFigureChat(); await sleep(800);

  // ===== C. INTERVIEW SEVERAL THINKERS BASED ON UPLOADED EXCERPTS =====
  await segment('Interview from upload — Kuczynski (Psychopathy excerpt)', async () => {
    const sec = page.locator('#interview-creator-section');
    await sec.scrollIntoViewIfNeeded(); await sleep(800);
    await selectRadix(sec.getByTestId('select-thinker'), 'Kuczynski');
    await click(sec.getByTestId('tab-upload-interview')); await sleep(800);
    const fi = sec.locator('input[type="file"]').first();
    await fi.setInputFiles(path.join(__dirname, 'excerpts', 'psychopathy.txt')); await sleep(1800);
    await typeInto(sec.getByTestId('input-word-length'), '700', 40).catch(()=>{});
    await sleep(400);
    await runPopupGenerator(sec.getByTestId('button-generate-interview'), 'interview (upload, Kuczynski)', 360000);
  });
  await segment('Interview from upload — Freud (Attachment Theory excerpt)', async () => {
    const sec = page.locator('#interview-creator-section');
    await sec.scrollIntoViewIfNeeded(); await sleep(800);
    await selectRadix(sec.getByTestId('select-thinker'), 'Freud');
    await click(sec.getByTestId('tab-upload-interview')); await sleep(800);
    const fi = sec.locator('input[type="file"]').first();
    await fi.setInputFiles(path.join(__dirname, 'excerpts', 'attachment.txt')); await sleep(1800);
    await typeInto(sec.getByTestId('input-word-length'), '700', 40).catch(()=>{});
    await sleep(400);
    await runPopupGenerator(sec.getByTestId('button-generate-interview'), 'interview (upload, Freud)', 360000);
  });

  // ===== D. DIALOGUE BETWEEN MULTIPLE THINKERS ABOUT UPLOADED =====
  await segment('Dialogue from upload — Freud + Bergler (Psychic Masochism excerpt)', async () => {
    const sec = page.locator('#dialogue-creator-section');
    await sec.scrollIntoViewIfNeeded(); await sleep(800);
    await click(sec.getByTestId('tab-upload')); await sleep(800);
    const fi = sec.locator('input[type="file"]').first();
    await fi.setInputFiles(path.join(__dirname, 'excerpts', 'bergler.txt')); await sleep(1800);
    await selectRadix(sec.getByTestId('select-author-1'), 'Freud');
    await selectRadix(sec.getByTestId('select-author-2'), 'Bergler');
    await typeInto(sec.getByTestId('textarea-customization'), 'Discuss whether all neurotic aggression is really pseudoaggression masking psychic masochism.', 3).catch(()=>{});
    await typeInto(sec.getByTestId('input-word-length'), '800', 40);
    await sleep(400);
    await runPopupGenerator(sec.getByTestId('button-generate'), 'dialogue (upload)', 360000);
  });

  // ===== E. QUOTES, ARGUMENTS, AND POSITIONS ABOUT ISSUES IN THE UPLOADS =====
  await segment('Quotes — Kuczynski on beauty / content-bioavailability', async () => {
    const sec = page.locator('#quote-generator-section');
    await sec.scrollIntoViewIfNeeded(); await sleep(800);
    await click(sec.getByTestId('select-author-quotes')); await sleep(500);
    const ci = page.getByPlaceholder('Search authors...');
    await ci.fill('Kuczynski').catch(()=>{}); await sleep(700);
    await page.getByRole('option', { name: 'Kuczynski', exact: true }).first().click().catch(async()=>{
      await page.getByText('Kuczynski', { exact: true }).first().click();
    });
    await sleep(600);
    await typeInto(sec.getByTestId('input-query-quotes'), 'beauty as content bioavailability', 6);
    await typeInto(sec.getByTestId('input-num-quotes'), '8', 60);
    await sleep(400);
    await click(sec.getByTestId('button-generate-quotes'));
    log('  generating quotes (author)...');
    await waitStable(sec.locator('.prose').first(), { stableMs: 6000, capMs: 120000, pollMs: 2500 }, 'quotes (author)');
    await scrollPage(400, 5); await sleep(800);
  });
  await segment('Quotes — extracted directly from uploaded excerpt', async () => {
    const sec = page.locator('#quote-generator-section');
    await sec.scrollIntoViewIfNeeded();
    await click(sec.getByTestId('tab-mode-upload')); await sleep(800);
    const fi = sec.locator('input[type="file"]').first();
    await fi.setInputFiles(path.join(__dirname, 'excerpts', 'aesthetics.txt')); await sleep(1500);
    await click(sec.getByTestId('button-generate-quotes'));
    log('  extracting quotes from upload...');
    await waitStable(sec.locator('.prose').first(), { stableMs: 6000, capMs: 120000, pollMs: 2500 }, 'quotes (upload)');
    await sleep(900);
  });
  await segment('Arguments — Kuczynski on aggression & repression', async () => {
    const sec = page.locator('#argument-generator-section');
    await sec.scrollIntoViewIfNeeded(); await sleep(800);
    await selectRadix(sec.getByTestId('select-argument-thinker'), 'Kuczynski');
    await typeInto(sec.getByTestId('input-argument-keywords'), 'aggression, sexuality, repression, masochism', 4);
    await typeInto(sec.getByTestId('input-num-arguments'), '3', 60).catch(()=>{});
    await sleep(400);
    await click(sec.getByTestId('button-generate-arguments'));
    log('  generating arguments...');
    await waitVisible(sec.getByTestId('button-copy-arguments'), 120000, 'arguments ready');
    await waitStable(sec.getByTestId('textarea-generated-arguments'), { stableMs: 4000, capMs: 60000, pollMs: 2000 }, 'arguments');
    await scrollPage(400, 5); await sleep(800);
  });
  await segment('Positions — Kuczynski on OCD as misdirected mental health', async () => {
    const sec = page.locator('#position-generator-section');
    await sec.scrollIntoViewIfNeeded(); await sleep(800);
    await selectRadix(sec.getByTestId('select-position-thinker'), 'Kuczynski');
    await typeInto(sec.getByTestId('input-position-topic'), 'OCD, depression and paranoia as misdirected mental health', 4);
    await typeInto(sec.getByTestId('input-num-positions'), '8', 60).catch(()=>{});
    await sleep(400);
    await click(sec.getByTestId('button-generate-positions'));
    log('  generating positions...');
    await waitVisible(sec.getByTestId('button-copy-positions'), 120000, 'positions ready');
    await waitStable(sec.getByTestId('textarea-generated-positions'), { stableMs: 4000, capMs: 60000, pollMs: 2000 }, 'positions');
    await scrollPage(400, 5); await sleep(800);
  });

  // ===== F. SAME THINKER, DIFFERENT ANSWERS BY INTENSITY METER =====
  const INTENSITY_Q = "Is OCD a mental illness, or is it misdirected mental health?";
  await segment('Intensity demo — Freud at LOW intensity', async () => {
    await setIntensity('low');
    const search = page.getByTestId('input-search-figures');
    await typeInto(search, 'Freud', 60); await sleep(700);
    await click(page.getByTestId('button-talk-freud')); await sleep(1500);
    await click(page.getByTestId('button-clear-chat')).catch(()=>{}); await sleep(1200);
    await click(page.getByTestId('button-audit-trail')).catch(()=>{}); await sleep(600);
    log('  Freud LOW-intensity answer...');
    await askInChat(INTENSITY_Q, 'Freud LOW');
    await scrollPage(400, 5); await sleep(1200);
  });
  await closeFigureChat(); await sleep(700);
  await segment('Intensity demo — Freud at HIGH intensity (same question)', async () => {
    await setIntensity('high');
    const search = page.getByTestId('input-search-figures');
    await typeInto(search, 'Freud', 60); await sleep(700);
    await click(page.getByTestId('button-talk-freud')); await sleep(1500);
    await click(page.getByTestId('button-clear-chat')).catch(()=>{}); await sleep(1500);
    log('  Freud HIGH-intensity answer (same question)...');
    await askInChat(INTENSITY_Q, 'Freud HIGH');
    await scrollPage(400, 5); await sleep(1200);
  });
  await closeFigureChat(); await sleep(700);
  log('All segments complete. Finalizing video...');
  await sleep(1500);
  const video = page.video();
  await context.close();
  await browser.close();
  if (video) {
    const p = await video.path();
    const dest = path.join(OUT_DIR, 'genius101-demo.webm');
    fs.copyFileSync(p, dest);
    log('VIDEO SAVED:', dest, `(${(fs.statSync(dest).size/1e6).toFixed(1)} MB)`);
  } else {
    log('WARN: no video handle');
  }
  log('TOTAL RUNTIME:', ts());
  log('DONE_MARKER');
  if (process.env.HOLD) { log('HOLD: keeping process alive (remove workflow to stop)'); await new Promise(()=>{}); }
})().catch(e => {
  log('FATAL:', e.stack || e.message);
  if (process.env.HOLD) { log('HOLD after fatal'); return new Promise(()=>{}); }
  process.exit(1);
});
