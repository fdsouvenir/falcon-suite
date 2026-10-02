import { chromium } from 'playwright';
const [inp, out, w = '1440'] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: +w, height: +(process.argv[5] ?? 1000) }, deviceScaleFactor: 1 });
await p.goto('file://' + inp, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await p.waitForTimeout(1500);
await p.screenshot({ path: out, fullPage: true });
await b.close();
