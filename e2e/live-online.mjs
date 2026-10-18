// Checks online play on the published site: two browsers, a room via the live introductions
// service, a round played over a direct WebRTC connection.  node e2e/live-online.mjs [url]
import { launch, sleep, watchConsole } from "./browser.mjs";
const BASE = process.argv[2] || "https://hosthobbit.github.io/blast-borough/";
const browser = await launch();
const a = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
const b = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
const errors = [...[watchConsole(a, "A"), watchConsole(b, "B")]];
const ready = (p) => p.waitForFunction(() => window.__bb?.screen() === "title", null, { timeout: 60000 });
const t0 = Date.now();
for (const [p, n] of [[a, "A"], [b, "B"]]) {
  p.on("request", (r) => { if (r.url().includes("blast-signal")) r._t = Date.now(); });
  p.on("requestfinished", async (r) => { if (r.url().includes("blast-signal") && process.env.TRACE) { const body = r.postData() || ""; const act = (body.match(/"action":"(\w+)"/) || [])[1]; if (act !== "poll" || n === "B") console.log(`${(Date.now() - t0) / 1000}s ${n} ${act} ${Date.now() - r._t}ms`); } });
}
await a.goto(`${BASE}?autoplay`); await ready(a);
await a.click("text=Online Multiplayer"); await a.fill("#nick", "Alice"); await a.click("[data-create]");
await a.waitForSelector(".room-code", { timeout: 30000 });
const code = (await a.textContent(".room-code")).trim();
console.log("room", code, "after", Date.now() - t0, "ms");
await b.goto(`${BASE}?autoplay&room=${code}`); await ready(b);
await b.click("text=Online Multiplayer"); await b.fill("#nick", "Bob"); await b.click("[data-join]");
await b.waitForSelector("[data-ready]", { timeout: 45000 });
console.log("joined after", Date.now() - t0, "ms");
if (process.env.TRACE) { await browser.close(); process.exit(0); }
await a.click("[data-seg=obots] [data-v='2']");
await b.click("[data-ready]");
await a.waitForSelector("[data-start]:not([disabled])", { timeout: 15000 });
await a.click("[data-start]");
await b.waitForFunction(() => window.__bb.state()?.phase === "playing", null, { timeout: 30000 });
console.log("playing after", Date.now() - t0, "ms");
await a.waitForFunction(() => (window.__bb.state()?.endTick ?? -1) >= 0, null, { timeout: 200000 });
const s = await b.evaluate(() => ({ dbg: window.__bb.online(), winner: window.__bb.state().winner }));
console.log("round decided; guest sees", JSON.stringify(s));
await sleep(500);
const errs = errors.flat();
console.log("console errors:", errs.length, errs.slice(0, 5));
await browser.close();
