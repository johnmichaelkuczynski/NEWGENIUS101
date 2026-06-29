import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.TARGET_URL || 'http://localhost:5000';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const CURSOR = `(()=>{const c=document.createElement('div');c.id='__vc';c.style.cssText='position:fixed;width:20px;height:20px;background:red;z-index:99999;pointer-events:none';document.documentElement.appendChild(c);document.addEventListener('mousemove',e=>{c.style.left=e.clientX+'px';c.style.top=e.clientY+'px'},true);})();`;

(async()=>{
  const b = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
  const ctx = await b.newContext({ viewport:{width:1280,height:800} });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  await page.goto(TARGET,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForLoadState('networkidle',{timeout:60000}).catch(()=>{});
  await sleep(2500);
  const checks = [
    'input-search-figures','button-talk-freud','button-compare-thinkers','button-chat-history',
    'link-diagnostics','input-response-length','input-quote-frequency','select-ai-model',
    'slider-intensity-level','switch-dialogue-mode',
  ];
  for (const id of checks) {
    const cnt = await page.getByTestId(id).count();
    console.log(`${cnt>0?'OK ':'MISS'} ${id} (${cnt})`);
  }
  // sections
  for (const s of ['model-builder-section','paper-writer-section','quote-generator-section','dialogue-creator-section','interview-creator-section','debate-creator-section']) {
    const cnt = await page.locator('#'+s).count();
    console.log(`${cnt>0?'OK ':'MISS'} #${s} (${cnt})`);
  }
  // open freud chat, check inputs
  await page.getByTestId('button-talk-freud').click();
  await sleep(2000);
  for (const id of ['input-figure-message','button-send-figure-message','button-audit-trail']) {
    console.log(`${await page.getByTestId(id).count()>0?'OK ':'MISS'} ${id}`);
  }
  // section-scoped duplicates
  const paper = page.locator('#paper-writer-section');
  console.log('paper word-length count:', await paper.getByTestId('input-word-length').count());
  await page.keyboard.press('Escape');
  await sleep(800);
  await page.screenshot({ path: path.join(__dirname,'smoke.png') });
  console.log('SMOKE DONE');
  await ctx.close(); await b.close();
})().catch(e=>{console.error('SMOKE FATAL',e.message); process.exit(1);});
