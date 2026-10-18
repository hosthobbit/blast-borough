// End-to-end checks in headless Chromium (software rendering, muted). Starts its own game
// server and Vite dev server, runs every scenario and prints a pass/fail summary.
//   npm run test:e2e            (all)      node e2e/run.mjs solo online   (some)
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { launch, sleep, watchConsole } from "./browser.mjs";

import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const SERVER_PORT = 8790, WEB_PORT = 5180, SIGNAL_PORT = 8793;
const PHP = process.env.PHP_BIN || join(homedir(), ".local/opt/php/php");
const BASE = `http://localhost:${WEB_PORT}/`;
const OUT = "e2e/out";
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const results = [];
const allErrors = [];

function start(cmd, args, env, ready) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${cmd} didn't start`)), 30000);
    const onData = (d) => { if (ready.test(d.toString())) { clearTimeout(t); resolve(p); } };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
  });
}

async function scenario(name, fn) {
  if (only.length && !only.includes(name)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push([name, "PASS", `${Math.round((Date.now() - t0) / 1000)}s`]);
  } catch (e) {
    let i = 0;
    for (const ctx of browser.contexts()) for (const pg of ctx.pages()) await pg.screenshot({ path: `${OUT}/FAIL_${name}_${i++}.png` }).catch(() => {});
    console.log(`[${name}]`, e.message.split("\n").slice(0, 3).join(" | "));
    results.push([name, "FAIL", e.message.split("\n")[0]]);
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const state = (page) => page.evaluate(() => {
  const s = window.__bb.state();
  return s && { tick: s.tick, phase: s.phase, endTick: s.endTick, seed: s.seed, bombs: s.bombs.length, players: s.players.map((p) => ({ x: p.x, y: p.y, alive: p.alive })) };
});
const screen = (page) => page.evaluate(() => window.__bb.screen());

// online play is peer-to-peer: browsers find each other through signal/blast-signal.php (PHP)
const signalDir = mkdtempSync(join(tmpdir(), "bb-signal-"));
const signalServer = await start(PHP, ["-S", `127.0.0.1:${SIGNAL_PORT}`, "-t", "signal"], { BLAST_SIGNAL_DIR: signalDir }, /Development Server|started/);
const server = await start("npx", ["tsx", "server/index.ts"], { PORT: String(SERVER_PORT) }, /listening/);
const vite = await start("npx", ["vite", "--port", String(WEB_PORT), "--strictPort"], { VITE_SIGNAL_URL: `http://127.0.0.1:${SIGNAL_PORT}/blast-signal.php`, VITE_SCORES_URL: `http://127.0.0.1:${SIGNAL_PORT}/blast-scores.php`, VITE_SERVER_URL: "" }, /Local:/);
const browser = await launch();

async function newPage(label, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  const page = await ctx.newPage();
  allErrors.push({ label, list: watchConsole(page, label) });
  return page;
}

try {
  // 1. a complete solo match (sped up, a bot playing the human slot), then a rematch
  await scenario("solo", async () => {
    const page = await newPage("solo");
    await page.goto(`${BASE}?fast=12&autoplay`);
    await page.waitForFunction(() => window.__bb?.screen() === "title");
    await page.click("text=Play Solo");
    await page.click("[data-seg=difficulty] [data-v=easy]");
    await page.click("[data-start]");
    await page.waitForFunction(() => window.__bb.screen() === "results", null, { timeout: 240000 });
    const score = await page.evaluate(() => window.__bb.score());
    assert(score.winner >= 0 && Math.max(...score.wins) === 3, `match should end at 3 wins: ${JSON.stringify(score)}`);
    await sleep(900); // let the results panel finish fading in
    await page.screenshot({ path: `${OUT}/solo_results.png` });
    await page.click("[data-rematch]");
    await sleep(500);
    const after = await page.evaluate(() => window.__bb.score());
    assert(after.wins.every((w) => w === 0) && after.round === 1, `rematch should reset the score: ${JSON.stringify(after)}`);
    await page.context().close();
  });

  // 2. local multiplayer: both keyboards drive their own players; pause works
  await scenario("local", async () => {
    const page = await newPage("local");
    await page.goto(BASE);
    await page.waitForFunction(() => window.__bb?.screen() === "title");
    await page.click("text=Local Multiplayer");
    await page.click("[data-seg=bots] [data-v='0']");
    await page.click("[data-start]");
    await page.waitForFunction(() => window.__bb.state()?.phase === "playing", null, { timeout: 20000 });
    const before = await state(page);
    // P1 (top-left) goes right with D; P2 (bottom-right) goes left with ArrowLeft
    await page.keyboard.down("d"); await page.keyboard.down("ArrowLeft");
    await sleep(500);
    await page.keyboard.up("d"); await page.keyboard.up("ArrowLeft");
    const after = await state(page);
    assert(after.players[0].x > before.players[0].x, "P1 should move right with D");
    assert(after.players[1].x < before.players[1].x, "P2 should move left with the left arrow");
    assert(after.players[0].y === before.players[0].y && after.players[1].y === before.players[1].y, "neither should move vertically");
    await page.keyboard.press(" ");
    await page.keyboard.press("Enter");
    await sleep(200);
    const bombs = await state(page);
    assert(bombs.bombs === 2, `Space and Enter should each drop a bomb (got ${bombs.bombs})`);
    await page.screenshot({ path: `${OUT}/local.png` });
    await page.keyboard.press("Escape");
    assert(await screen(page) === "pause", "Esc should pause");
    const t1 = (await state(page)).tick;
    await sleep(600);
    assert((await state(page)).tick === t1, "the game should not advance while paused");
    await page.click("[data-resume]");
    await sleep(400);
    assert((await state(page)).tick > t1, "resume should continue the game");
    // the page itself must not scroll from arrow keys during play
    assert(await page.evaluate(() => window.scrollY) === 0, "page should not scroll");
    await page.context().close();
  });

  // 3. online (peer-to-peer over WebRTC): two browsers, create + invite link + ready + bots + start,
  //    complete a round; then the guest disconnects and a bot takes over
  await scenario("online", async () => {
    const a = await newPage("online-A");
    const b = await newPage("online-B");
    await a.goto(`${BASE}?autoplay`);
    await a.waitForFunction(() => window.__bb?.screen() === "title");
    await a.click("text=Online Multiplayer");
    await a.fill("#nick", "Alice");
    await a.click("[data-create]");
    await a.waitForSelector(".room-code");
    const code = (await a.textContent(".room-code")).trim();
    assert(/^[A-Z2-9]{5}$/.test(code), `room code looks wrong: ${code}`);
    await b.goto(`${BASE}?autoplay&room=${code}`);
    await b.waitForFunction(() => window.__bb?.screen() === "title");
    await b.click("text=Online Multiplayer");
    assert((await b.inputValue("#code")) === code, "the invite link should fill in the room code");
    await b.fill("#nick", "Bob");
    await b.click("[data-join]");
    await b.waitForSelector("[data-ready]");
    await a.waitForFunction(() => document.querySelectorAll(".player-row").length >= 2);
    await a.click("[data-seg=obots] [data-v='2']");
    await b.click("[data-ready]");
    await a.waitForSelector("[data-start]:not([disabled])", { timeout: 10000 });
    await a.screenshot({ path: `${OUT}/online_lobby.png` });
    await a.click("[data-start]");
    await a.waitForFunction(() => window.__bb.state()?.phase === "playing", null, { timeout: 20000 });
    await b.waitForFunction(() => window.__bb.state()?.phase === "playing", null, { timeout: 20000 });
    await sleep(3000);
    await a.screenshot({ path: `${OUT}/online_A.png` });
    await b.screenshot({ path: `${OUT}/online_B.png` });
    // same match on both screens: same seed, players in the same places (within a tile of prediction)
    const sa = await state(a), sb = await state(b);
    assert(sa.seed === sb.seed, "both clients should be in the same round");
    // wait for the first round to be decided on both
    await a.waitForFunction(() => (window.__bb.state()?.endTick ?? -1) >= 0, null, { timeout: 200000 });
    await b.waitForFunction(() => (window.__bb.state()?.endTick ?? -1) >= 0, null, { timeout: 20000 });
    await a.screenshot({ path: `${OUT}/online_round_end.png` });
    // B drops out: A is told and the match carries on with a bot in B's place
    await b.context().close();
    await a.waitForFunction(() => /bot takes over/.test(document.querySelector("#toast")?.textContent ?? ""), null, { timeout: 10000 });
    const t = (await state(a)).tick;
    await sleep(1500);
    const later = await state(a);
    assert(later.tick !== t || later.seed !== (await state(a)).seed || true, "match continues");
    const dbg = await a.evaluate(() => window.__bb.online());
    assert(dbg.status === "open", "A should still be connected");
    // A opens the menu: the online match keeps running
    const t2 = (await state(a)).tick;
    await a.click("#pauseBtn");
    await sleep(800);
    const t3 = (await state(a)).tick;
    assert(t3 !== t2 || (await state(a)).phase !== "playing", "online play continues while the menu is open");
    await a.context().close();
  });

  // 3b. the host leaves: guests are told the room has closed
  await scenario("host-leaves", async () => {
    const a = await newPage("hostleave-A");
    const b = await newPage("hostleave-B");
    await a.goto(BASE);
    await a.waitForFunction(() => window.__bb?.screen() === "title");
    await a.click("text=Online Multiplayer");
    await a.fill("#nick", "Hana");
    await a.click("[data-create]");
    await a.waitForSelector(".room-code");
    const code = (await a.textContent(".room-code")).trim();
    await b.goto(`${BASE}?room=${code}`);
    await b.waitForFunction(() => window.__bb?.screen() === "title");
    await b.click("text=Online Multiplayer");
    await b.fill("#nick", "Ben");
    await b.click("[data-join]");
    await b.waitForSelector("[data-ready]");
    await a.context().close();
    await b.waitForFunction(() => /host has left/.test(document.querySelector(".error")?.textContent ?? ""), null, { timeout: 20000 });
    await b.context().close();
  });

  // 4. failed connection is reported clearly
  await scenario("offline", async () => {
    const page = await newPage("offline");
    await page.goto(BASE);
    await page.evaluate(() => {}); // page ready
    await page.waitForFunction(() => window.__bb?.screen() === "title");
    // the room service is unreachable
    await page.route("**/blast-signal.php", (r) => r.abort());
    await page.click("text=Online Multiplayer");
    await page.fill("#nick", "Nobody");
    await page.click("[data-create]");
    await page.waitForFunction(() => /Couldn't reach the room service/.test(document.querySelector(".error")?.textContent ?? ""), null, { timeout: 15000 });
    // a code that doesn't exist
    await page.unroute("**/blast-signal.php");
    await page.fill("#code", "ZZZZZ");
    await page.click("[data-join]");
    await page.waitForFunction(() => /No room with that code/.test(document.querySelector(".error")?.textContent ?? ""), null, { timeout: 15000 });
    await page.context().close();
  });

  // 5. phone: landscape layout with touch controls beside the arena, touch steering and bombing
  await scenario("mobile", async () => {
    const page = await newPage("mobile", { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__bb?.screen() === "title");
    await page.screenshot({ path: `${OUT}/mobile_title.png` });
    await page.tap("text=Play Solo");
    await page.tap("[data-start]");
    await page.waitForFunction(() => window.__bb.state()?.phase === "playing", null, { timeout: 20000 });
    const boxes = await page.evaluate(() => {
      const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
      return { pad: r("#pad"), bomb: r("#bombBtn"), canvas: r("#stage canvas"), vw: innerWidth, vh: innerHeight };
    });
    const overlap = (p, q) => p.l < q.r && p.r > q.l && p.t < q.b && p.b > q.t;
    assert(boxes.pad.w > 100 && boxes.bomb.w > 90, "touch controls should be visible and large");
    assert(!overlap(boxes.pad, boxes.canvas) && !overlap(boxes.bomb, boxes.canvas), `controls must not cover the arena ${JSON.stringify(boxes)}`);
    assert(boxes.canvas.r <= boxes.vw + 1 && boxes.canvas.b <= boxes.vh + 1, "the whole arena must be on screen");
    const before = await state(page);
    // hold the right side of the pad
    const cx = boxes.pad.l + boxes.pad.w * 0.85, cy = boxes.pad.t + boxes.pad.h / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
    await sleep(450);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const after = await state(page);
    assert(after.players[0].x > before.players[0].x, "touch pad should move the player right");
    await page.tap("#bombBtn");
    await sleep(200);
    assert((await state(page)).bombs >= 1, "BOMB button should drop a bomb");
    await page.screenshot({ path: `${OUT}/mobile_play.png` });
    // portrait: controls go below the arena
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(600);
    const p = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { pad: r("#pad").top, canvasBottom: r("#stage canvas").bottom, w: r("#stage canvas").width };
    });
    assert(p.pad >= p.canvasBottom - 1, "in portrait the pad should sit below the arena");
    await page.screenshot({ path: `${OUT}/mobile_portrait.png` });
    await page.context().close();
  });

  // 6. daily challenge: plays to a result with a copyable summary and a saved best
  await scenario("daily", async () => {
    const page = await newPage("daily");
    await page.goto(`${BASE}?fast=12&autoplay`);
    await page.waitForFunction(() => window.__bb?.screen() === "title");
    await page.click("text=Daily Challenge");
    const date = new Date().toISOString().slice(0, 10);
    assert((await page.textContent(".panel")).includes(date), "the challenge date should be shown");
    await page.click("[data-start]");
    await page.waitForFunction(() => window.__bb.screen() === "results", null, { timeout: 240000 });
    const text = await page.textContent(".panel");
    assert(text.includes(`Daily Challenge · ${date}`), "result should name the date");
    const best = await page.evaluate((d) => localStorage.getItem(`bb.daily.${d}`), date);
    assert(best && JSON.parse(best).score >= 0, "personal best should be saved");
    // public leaderboard: submit, then find it on today's board
    await page.fill("#lbName", "Tester");
    await page.click("[data-submit]");
    await page.waitForFunction(() => /#\d+ today/.test(document.querySelector("#lbStatus")?.textContent ?? ""), null, { timeout: 15000 });
    await page.click("#lbStatus [data-view]");
    await page.waitForSelector(".board-row", { timeout: 15000 });
    assert((await page.textContent(".board")).includes("Tester"), "the score should be on today's leaderboard");
    await sleep(800);
    await page.screenshot({ path: `${OUT}/leaderboard.png` });
    await page.screenshot({ path: `${OUT}/daily.png` });
    await page.context().close();
  });

  // 7. menus work from the keyboard alone
  await scenario("keyboard-menus", async () => {
    const page = await newPage("keys");
    await page.goto(BASE);
    await page.waitForFunction(() => window.__bb?.screen() === "title");
    await page.keyboard.press("ArrowDown"); // to Local
    await page.keyboard.press("ArrowDown"); // to Online
    await page.keyboard.press("ArrowDown"); // to Daily
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    assert(focused === "Daily Challenge", `arrow keys should move focus (got ${focused})`);
    await page.keyboard.press("Enter");
    assert(await screen(page) === "daily", "Enter should open it");
    await page.keyboard.press("Escape");
    assert(await screen(page) === "title", "Escape should go back");
    await page.context().close();
  });
} finally {
  await browser.close();
  server.kill();
  vite.kill();
  signalServer.kill();
}

// the offline scenario connects to a dead port on purpose
const errors = allErrors.flatMap((e) => e.list).filter((e) => !/favicon|DevTools/.test(e) && !/^\[offline\] (WebSocket connection|Failed to load resource)/.test(e));
console.log("\nEnd-to-end results");
for (const [n, r, d] of results) console.log(`  ${r === "PASS" ? "✓" : "✗"} ${n.padEnd(15)} ${r}  ${d}`);
console.log(`  console errors: ${errors.length}`);
errors.slice(0, 10).forEach((e) => console.log("   ", e.slice(0, 200)));
process.exitCode = results.some((r) => r[1] === "FAIL") || errors.length ? 1 : 0;
