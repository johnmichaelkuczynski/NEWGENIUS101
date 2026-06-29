import { chromium } from 'playwright';
const TARGET = process.env.TARGET_URL || 'http://localhost:5000';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let page;
async function dismiss(){ await page.keyboard.press('Escape').catch(()=>{}); await sleep(250); }
async function closeFigureChat() {
  for (let i=0;i<3;i++){
    const closeBtn = page.locator('button[title="Close"]').first();
    if ((await closeBtn.count()) && await closeBtn.isVisible().catch(()=>false)) { await closeBtn.click({timeout:5000}).catch(()=>{}); await sleep(500); }
    const backdrop = page.locator('div.fixed.inset-0.z-40').first();
    if ((await backdrop.count()) && await backdrop.isVisible().catch(()=>false)) { await backdrop.click({position:{x:6,y:6},force:true}).catch(()=>{}); await sleep(500); }
    else break;
  }
  await dismiss();
}
async function selectRadix(triggerLoc, optionName, { required=true } = {}) {
  const before = (await triggerLoc.innerText().catch(()=> '')).trim();
  for (let attempt=1; attempt<=3; attempt++) {
    await dismiss();
    await triggerLoc.scrollIntoViewIfNeeded().catch(()=>{});
    await triggerLoc.click({timeout:10000}).catch(()=>{});
    await sleep(500);
    let opt = page.getByRole('option', { name: optionName, exact: true }).first();
    if (!(await opt.count())) opt = page.locator('[role="option"]', { hasText: optionName }).first();
    let clicked=false;
    if (await opt.count()) {
      try { await opt.scrollIntoViewIfNeeded().catch(()=>{}); await opt.click({timeout:5000}); clicked=true; }
      catch { try { await opt.click({timeout:4000, force:true}); clicked=true; } catch {} }
    }
    if (!clicked) { await page.keyboard.type(optionName,{delay:45}); await sleep(750); await page.keyboard.press('Enter'); }
    await sleep(500);
    if (await page.locator('[role="listbox"],[role="option"]').count()) { await page.keyboard.press('Escape').catch(()=>{}); await sleep(200); }
    const after = (await triggerLoc.innerText().catch(()=> '')).trim();
    if (after && after !== before) { console.log(`  selectRadix "${optionName}" committed -> "${after}"`); return after; }
    console.log(`  selectRadix attempt ${attempt} for "${optionName}" not committed (trigger="${after}")`);
  }
  if (required) throw new Error(`selectRadix failed to commit "${optionName}"`);
  return null;
}
(async()=>{
  const b = await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const ctx = await b.newContext({viewport:{width:1280,height:800}});
  page = await ctx.newPage();
  await page.goto(TARGET,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForLoadState('networkidle',{timeout:60000}).catch(()=>{});
  await sleep(2500);
  // Reproduce real sequence: open Freud chat (custom modal), open audit, then CLOSE it.
  await page.getByTestId('input-search-figures').fill('Freud'); await sleep(900);
  await page.getByTestId('button-talk-freud').click({timeout:10000}); await sleep(1500);
  await page.getByTestId('button-audit-trail').click({timeout:5000}).catch(()=>{}); await sleep(800);
  const chatOpenBefore = await page.locator('button[title="Close"]').first().isVisible().catch(()=>false);
  console.log('figure chat modal open before close?', chatOpenBefore);
  await closeFigureChat();
  const chatOpenAfter = await page.locator('div.fixed.inset-0.z-40').first().isVisible().catch(()=>false);
  console.log('figure chat backdrop still visible after close?', chatOpenAfter);
  // Now the selects must work
  const paper = page.locator('#paper-writer-section');
  await paper.scrollIntoViewIfNeeded(); await sleep(500);
  await selectRadix(paper.getByTestId('select-philosopher-paper'), 'Kuczynski');
  await paper.getByTestId('input-topic-paper').fill('Test topic for enablement check.');
  await sleep(300);
  console.log('paper generate disabled?', await paper.getByTestId('button-generate-paper').isDisabled().catch(()=>null));
  const dlg = page.locator('#dialogue-creator-section');
  await dlg.scrollIntoViewIfNeeded(); await sleep(500);
  await selectRadix(dlg.getByTestId('select-author-1'), 'Freud');
  await selectRadix(dlg.getByTestId('select-author-2'), 'Bergson');
  const iv = page.locator('#interview-creator-section');
  await iv.scrollIntoViewIfNeeded(); await sleep(500);
  await selectRadix(iv.getByTestId('select-thinker'), 'Bergson');
  console.log('SELECT-TEST DONE');
  await ctx.close(); await b.close();
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
