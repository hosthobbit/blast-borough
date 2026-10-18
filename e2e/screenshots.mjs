// README screenshots (uses a running dev server: npm run dev). node e2e/screenshots.mjs [url]
import { mkdirSync } from "node:fs";
import { launch, sleep } from "./browser.mjs";
const BASE = process.argv[2] || "http://localhost:5173/";
const OUT = "docs/screenshots";
mkdirSync(OUT, { recursive: true });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const ready = () => page.waitForFunction(() => window.__bb?.screen() === "title");

await page.goto(BASE); await ready(); await sleep(2500);
await page.screenshot({ path: `${OUT}/title.png` });
await page.click("text=How to Play"); await sleep(700);
await page.screenshot({ path: `${OUT}/how-to-play.png` });

// gameplay: a bot drives "you"; capture a moment with several blasts on screen
await page.goto(`${BASE}?autoplay`); await ready();
await page.click("text=Play Solo"); await page.click("[data-seg=difficulty] [data-v=hard]"); await page.click("[data-start]");
for (let i = 0; i < 400; i++) {
  const n = await page.evaluate(() => { const s = window.__bb.state(); return s.phase === "playing" && s.tick > 400 ? Object.keys(s.flames).length : 0; });
  if (n >= 9) break;
  await sleep(100);
}
await page.screenshot({ path: `${OUT}/gameplay.png` });

// results and the daily challenge, sped up
await page.goto(`${BASE}?fast=12&autoplay`); await ready();
await page.click("text=Play Solo"); await page.click("[data-start]");
await page.waitForFunction(() => window.__bb.screen() === "results", null, { timeout: 300000 });
await sleep(1200);
await page.screenshot({ path: `${OUT}/results.png` });
await page.goto(`${BASE}?fast=12&autoplay`); await ready();
await page.click("text=Daily Challenge"); await page.click("[data-start]");
await page.waitForFunction(() => window.__bb.screen() === "results", null, { timeout: 300000 });
await sleep(1200);
await page.screenshot({ path: `${OUT}/daily.png` });
await browser.close();
console.log("done");
