import { chromium } from 'playwright';
try {
  console.log('executablePath:', chromium.executablePath());
} catch (e) { console.log('execPath error:', e.message); }
try {
  const b = await chromium.launch({ args:['--no-sandbox'] });
  console.log('LAUNCH OK', await b.version());
  await b.close();
} catch (e) { console.log('LAUNCH FAIL:', e.message.split('\n').slice(0,6).join(' | ')); }
