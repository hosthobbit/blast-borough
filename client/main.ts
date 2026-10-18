import "./style.css";
import Phaser from "phaser";
import type { Difficulty } from "../shared/bot.js";
import { COUNTDOWN_TICKS, Dir, POWERUP_INFO, PowerUp, SUDDEN_DEATH_AT, TICK_RATE, WINS_TO_TAKE_MATCH } from "../shared/constants.js";
import { type GameEvent, type GameState, type MatchScore, playTick, timeLeftTicks } from "../shared/sim.js";
import { applyVolumes, setMusicIntensity, sfx, startMusic, stopMusic, unlockAudio } from "./audio.js";
import { ArenaScene, type Frame } from "./game/ArenaScene.js";
import { CHARACTERS, drawCharacter, drawPowerUp } from "./game/art.js";
import { LocalMatch, type Slot, dailyScore, todayUTC } from "./game/localMatch.js";
import { InputSource, KEYS_P1_LOCAL, KEYS_P1_SOLO, KEYS_P2_LOCAL, attachTouchControls, keyboard } from "./input.js";
import { OnlineSession } from "./net.js";
import { joinHost } from "./p2p/guest.js";
import { P2PHost } from "./p2p/host.js";
import { webSocketTransport } from "./p2p/transport.js";

/** A dedicated server if one is configured at build time; otherwise rooms are hosted in a player's browser. */
const SERVER_URL = import.meta.env.VITE_SERVER_URL as string | undefined;
let p2pHost: P2PHost | null = null;
import { saveSettings, settings, storageGet, storageSet } from "./settings.js";
import { type BoardEntry, fetchBoard, submitDaily } from "./leaderboard.js";
import { credit, notePlayedMatch, nudged, shareRow, shouldNudge, wireShare } from "./share.js";

// ------------------------------------------------------------------------------------------
// environment

const params = new URLSearchParams(location.search);
const isTouch = matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints > 0 && !matchMedia("(pointer: fine)").matches) || params.has("touch");
document.body.classList.toggle("touch", isTouch);
const applyMotionClass = () => document.body.classList.toggle("reduced", settings.reducedMotion);
applyMotionClass();

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const screens = $("#screens");
const hud = $("#hud");

const portraitCache = new Map<number, string>();
function portrait(id: number): string {
  if (!portraitCache.has(id)) portraitCache.set(id, drawCharacter(CHARACTERS[id], 0, 0).toDataURL());
  return portraitCache.get(id)!;
}
const puIcon = (k: PowerUp) => drawPowerUp(k).toDataURL();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

let toastTimer = 0;
function toast(text: string) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 2600);
}

// audio starts only after the first interaction
const firstGesture = () => {
  unlockAudio();
  if (settings.music > 0) startMusic();
  window.removeEventListener("pointerdown", firstGesture);
  window.removeEventListener("keydown", firstGesture);
};
window.addEventListener("pointerdown", firstGesture);
window.addEventListener("keydown", firstGesture);

// ------------------------------------------------------------------------------------------
// Phaser + drivers

interface Driver {
  advance(dt: number): void;
  frame(): Frame | null;
  dispose?(): void;
}

let driver: Driver | null = null;
const scene = new ArenaScene();
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "stage",
  backgroundColor: "#1b1430",
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: 780, height: 768 },
  render: { antialias: true, roundPixels: false },
  audio: { noAudio: true },
  banner: false,
  scene: [scene],
});
game.events.on("prestep", (_t: number, delta: number) => driver?.advance(delta));
game.events.once("ready", () => {
  scene.setSource(() => driver?.frame() ?? null);
  showTitle();
});

function setDriver(d: Driver | null) {
  driver?.dispose?.();
  driver = d;
}

// attract mode: four bots playing behind the title menu
function startAttract() {
  const slots: Slot[] = [0, 1, 2, 3].map((i) => ({ kind: "bot", name: CHARACTERS[i].name, difficulty: "normal" }));
  let m: LocalMatch;
  const make = () => new LocalMatch(slots, `attract-${Date.now()}`, { onMatchOver: () => { m = make(); } });
  m = make();
  setDriver({ advance: (dt) => m.advance(dt), frame: () => m.frame() });
  document.body.classList.remove("in-match");
  keyboard.active = false;
  hud.hidden = true;
  setMusicIntensity(0);
}

// ------------------------------------------------------------------------------------------
// screens

type Screen = "board" | "title" | "solo" | "local" | "online" | "lobby" | "howto" | "settings" | "daily" | "results" | "pause" | "none";
let current: Screen = "none";
let back: (() => void) | null = null;

function show(name: Screen, html: string, opts: { clear?: boolean; focus?: string; onBack?: () => void } = {}) {
  current = name;
  back = opts.onBack ?? null;
  screens.innerHTML = html ? `<section class="screen ${opts.clear ? "clear" : ""}" data-screen="${name}">${html}</section>` : "";
  wireShare(screens, toast);
  const target = opts.focus ? screens.querySelector<HTMLElement>(opts.focus) : screens.querySelector<HTMLElement>("button, input");
  target?.focus({ preventScroll: true });
}

function on(sel: string, ev: string, fn: (e: Event) => void) {
  screens.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));
}
screens.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("button")) sfx.click(); });

// arrow keys move between buttons in menus; Escape goes back
window.addEventListener("keydown", (e) => {
  if (keyboard.active && current === "none") return;
  if (e.key === "Escape" && back) { e.preventDefault(); back(); return; }
  if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
  const active = document.activeElement as HTMLElement | null;
  if (active && (active.tagName === "INPUT" && (active as HTMLInputElement).type === "range")) return;
  const items = Array.from(screens.querySelectorAll<HTMLElement>("button:not([disabled]), input, [tabindex='0']"));
  if (!items.length) return;
  const i = items.indexOf(active as HTMLElement);
  const next = e.key === "ArrowDown" ? items[(i + 1) % items.length] : items[(i - 1 + items.length) % items.length];
  next.focus();
  e.preventDefault();
});

function showTitle() {
  if (!driver || inMatch) startAttract();
  inMatch = false;
  show("title", `
    <div class="panel">
      <h1 class="logo">BLAST<br>BOROUGH</h1>
      <div class="tagline">Send a link. Settle it in two minutes.</div>
      <div class="menu">
        <button class="btn" data-go="solo">Play Solo</button>
        <button class="btn" data-go="local">Local Multiplayer</button>
        <button class="btn" data-go="online">Online Multiplayer</button>
        <div class="menu two">
          <button class="btn alt" data-go="daily">Daily Challenge</button>
          <button class="btn alt" data-go="board">Leaderboard</button>
        </div>
        <div class="menu two">
          <button class="btn alt small" data-go="howto">How to Play</button>
          <button class="btn alt small" data-go="settings">Settings</button>
        </div>
      </div>
      ${shareRow("Fancy a bomb battle? Free, in your browser, no download: Blast Borough", { label: "Share the game" })}
      ${credit()}
    </div>`);
  if (shouldNudge()) {
    nudged();
    const card = document.createElement("div");
    card.className = "nudge";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Share Blast Borough");
    card.innerHTML = `<b>Enjoying Blast Borough?</b><p>It's free and made by a small UK company. Sharing it with your friends really helps, and gives you more people to play!</p>
      ${shareRow("I've been playing Blast Borough: free bomb battles in your browser. Fancy a game?")}
      <button class="btn ghost small" data-nudge-close>Maybe later</button>`;
    screens.querySelector(".screen")?.appendChild(card);
    wireShare(card, toast);
    card.querySelector("[data-nudge-close]")!.addEventListener("click", () => card.remove());
    card.querySelectorAll(".share-btn").forEach((b) => b.addEventListener("click", () => setTimeout(() => card.remove(), 300)));
  }
  on("[data-go]", "click", (e) => {
    const go = (e.currentTarget as HTMLElement).dataset.go;
    if (go === "solo") showSolo();
    if (go === "local") showLocal();
    if (go === "online") showOnline();
    if (go === "daily") showDaily();
    if (go === "board") showBoard(showTitle);
    if (go === "howto") showHowTo(showTitle);
    if (go === "settings") showSettings(showTitle);
  });
}

function seg(name: string, options: [string, string][], value: string) {
  return `<div class="seg" role="group" aria-label="${name}" data-seg="${name}">${options.map(([v, label]) => `<button type="button" data-v="${v}" aria-pressed="${v === value}">${label}</button>`).join("")}</div>`;
}
function wireSeg(name: string, set: (v: string) => void) {
  screens.querySelectorAll<HTMLButtonElement>(`[data-seg="${name}"] button`).forEach((b) =>
    b.addEventListener("click", () => {
      screens.querySelectorAll<HTMLButtonElement>(`[data-seg="${name}"] button`).forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
      set(b.dataset.v!);
    }));
}

let soloDifficulty: Difficulty = storageGet("bb.solo.diff", "normal");
function showSolo() {
  show("solo", `
    <div class="panel">
      <h2>Play Solo</h2>
      <p>You are <b>${CHARACTERS[0].name}</b> against three bots. First to ${WINS_TO_TAKE_MATCH} round wins takes the match.</p>
      <label class="field">Bot difficulty</label>
      ${seg("difficulty", [["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]], soloDifficulty)}
      <p class="note">${isTouch ? "Steer with the pad, tap BOMB to drop a bomb." : "Move with WASD or the arrow keys, drop bombs with Space. Esc pauses."}</p>
      <div class="row end"><button class="btn ghost" data-back>Back</button><button class="btn" data-start>Start</button></div>
    </div>`, { onBack: showTitle, focus: "[data-start]" });
  wireSeg("difficulty", (v) => { soloDifficulty = v as Difficulty; storageSet("bb.solo.diff", v); });
  on("[data-back]", "click", showTitle);
  on("[data-start]", "click", () => {
    const me = new InputSource();
    const slots: Slot[] = [{ kind: "human", name: CHARACTERS[0].name, source: me, label: "YOU" }];
    for (let i = 1; i < 4; i++) slots.push({ kind: "bot", name: CHARACTERS[i].name, difficulty: soloDifficulty });
    startLocal(slots, [{ source: me, map: KEYS_P1_SOLO }], "solo");
  });
}

let localBots = storageGet("bb.local.bots", 2);
let localDifficulty: Difficulty = storageGet("bb.local.diff", "normal");
function showLocal() {
  show("local", `
    <div class="panel wide">
      <h2>Local Multiplayer</h2>
      <p>Two players on one keyboard. Fill the other spots with bots if you like.</p>
      <p class="desktop-only-note">Local multiplayer needs a keyboard: it's for computers. On this device, try Solo or Online instead.</p>
      <div class="keys">
        <div class="keycard"><h3><img src="${portrait(0)}" width="28" alt=""> Player 1 · ${CHARACTERS[0].name}</h3>
          Move <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> · Bomb <kbd>Space</kbd></div>
        <div class="keycard"><h3><img src="${portrait(1)}" width="28" alt=""> Player 2 · ${CHARACTERS[1].name}</h3>
          Move <kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd> · Bomb <kbd>Enter</kbd></div>
      </div>
      <div class="row"><label class="field">Bots</label>${seg("bots", [["0", "None"], ["1", "1"], ["2", "2"]], String(localBots))}
        <label class="field">Bot difficulty</label>${seg("ldiff", [["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]], localDifficulty)}</div>
      <p class="note">Esc or P pauses. First to ${WINS_TO_TAKE_MATCH} round wins.</p>
      <div class="row end"><button class="btn ghost" data-back>Back</button><button class="btn" data-start ${isTouch ? "disabled" : ""}>Start</button></div>
    </div>`, { onBack: showTitle, focus: isTouch ? "[data-back]" : "[data-start]" });
  wireSeg("bots", (v) => { localBots = Number(v); storageSet("bb.local.bots", localBots); });
  wireSeg("ldiff", (v) => { localDifficulty = v as Difficulty; storageSet("bb.local.diff", v); });
  on("[data-back]", "click", showTitle);
  on("[data-start]", "click", () => {
    const p1 = new InputSource(), p2 = new InputSource();
    const slots: Slot[] = [
      { kind: "human", name: CHARACTERS[0].name, source: p1, label: "P1" },
      { kind: "human", name: CHARACTERS[1].name, source: p2, label: "P2" },
    ];
    for (let i = 0; i < localBots; i++) slots.push({ kind: "bot", name: CHARACTERS[2 + i].name, difficulty: localDifficulty });
    startLocal(slots, [{ source: p1, map: KEYS_P1_LOCAL }, { source: p2, map: KEYS_P2_LOCAL }], "local");
  });
}

function showHowTo(onBack: () => void) {
  show("howto", `
    <div class="panel wide">
      <h2>How to Play</h2>
      <p>Drop bombs to blast crates, bins and planters, grab what's underneath, and catch your rivals in the blast. Last one standing wins the round; first to ${WINS_TO_TAKE_MATCH} rounds wins the match.</p>
      <ul class="note" style="line-height:1.6">
        <li>Blasts go in four straight lines. Walls stop them; a crate takes the hit and stops them too.</li>
        <li>A blast that reaches another bomb sets it off: chain reactions!</li>
        <li>You can step off a bomb you've just dropped, but not back onto it.</li>
        <li>At <b>0:30</b> left, <b>sudden death</b>: barriers drop in from the edges until the arena closes.</li>
        <li>Everyone caught at once? That round is a draw.</li>
      </ul>
      <div class="pu-list">
        ${[PowerUp.BombUp, PowerUp.FireUp, PowerUp.SpeedUp, PowerUp.Kick].map((k) => `<div class="pu"><img src="${puIcon(k)}" alt=""><div><b>${POWERUP_INFO[k].name}</b><span>${POWERUP_INFO[k].text}</span></div></div>`).join("")}
      </div>
      <p class="note">${isTouch ? "Touch: steer with the pad on the left, BOMB on the right." : "Solo: WASD/arrows + Space. Local: P1 WASD + Space, P2 arrows + Enter. Esc pauses."}</p>
      <div class="row end"><button class="btn" data-back>Got it</button></div>
    </div>`, { onBack });
  on("[data-back]", "click", onBack);
}

function showSettings(onBack: () => void) {
  show("settings", `
    <div class="panel">
      <h2>Settings</h2>
      <label class="field">Music <input type="range" min="0" max="1" step="0.05" value="${settings.music}" data-k="music" aria-label="Music volume"></label>
      <label class="field">Sound effects <input type="range" min="0" max="1" step="0.05" value="${settings.sfx}" data-k="sfx" aria-label="Sound effects volume"></label>
      <label class="toggle"><input type="checkbox" data-k="reducedMotion" ${settings.reducedMotion ? "checked" : ""}> Reduced motion</label>
      <label class="toggle"><input type="checkbox" data-k="screenShake" ${settings.screenShake ? "checked" : ""}> Screen shake</label>
      <p class="note">Saved on this device.</p>
      <div class="row end"><button class="btn" data-back>Done</button></div>
    </div>`, { onBack });
  screens.querySelectorAll<HTMLInputElement>("[data-k]").forEach((el) =>
    el.addEventListener("input", () => {
      const k = el.dataset.k as "music" | "sfx" | "reducedMotion" | "screenShake";
      if (k === "music" || k === "sfx") settings[k] = Number(el.value);
      else settings[k] = el.checked;
      saveSettings();
      applyVolumes();
      applyMotionClass();
      if (k === "music") { if (settings.music > 0) startMusic(); else stopMusic(); }
      if (k === "sfx") sfx.pickup();
    }));
  on("[data-back]", "click", onBack);
}

// ------------------------------------------------------------------------------------------
// local matches (solo, local multiplayer, daily)

let inMatch = false;
let localMatch: LocalMatch | null = null;
let matchKind: "solo" | "local" | "daily" | "online" = "solo";
let countdownShown = -1;
let names: string[] = [];

function startLocal(slots: Slot[], bindings: { source: InputSource; map: typeof KEYS_P1_SOLO }[], kind: "solo" | "local" | "daily", seed?: string) {
  matchKind = kind;
  names = slots.map((s) => s.name);
  const m = new LocalMatch(slots, seed ?? `${kind}-${Date.now()}`, {
    onEvents: (ev, s) => matchEvents(ev, s),
    onRoundStart: () => { countdownShown = -1; },
    onRoundDecided: (s) => roundDecided(s),
    onMatchOver: (score, s) => setTimeout(() => (kind === "daily" ? showDailyResult(m, s) : showResults(score, s)), 1100),
  }, { daily: kind === "daily" });
  if (params.has("fast")) m.speed = Number(params.get("fast")) || 1;
  if (params.has("autoplay")) autoplay(slots[0].source!, () => m.state, 0);
  localMatch = m;
  keyboard.bind(bindings);
  touchSource = slots[0].source ?? null;
  enterMatchUi();
  setDriver({ advance: (dt) => m.advance(dt), frame: () => m.frame() });
}

/** Automated tests only (?autoplay): a bot drives a human slot through the normal input path. */
function autoplay(src: InputSource, state: () => GameState | null, slot: number) {
  import("../shared/bot.js").then(({ BotBrain }) => {
    let brain = new BotBrain(slot, "hard", 1), lastSeed = -1;
    const orig = src.take.bind(src);
    src.take = () => {
      const s = state();
      orig();
      if (!s) return { dir: Dir.None, bomb: false };
      if (s.seed !== lastSeed) { brain = new BotBrain(slot, "hard", s.seed); lastSeed = s.seed; }
      return brain.input(s);
    };
  });
}

let touchSource: InputSource | null = null;
attachTouchControls($("#pad"), $("#bombBtn"), () => touchSource);

function enterMatchUi() {
  inMatch = true;
  scene.localPlayers = new Set(matchKind === "online" ? [online?.youSlot ?? -1] : (localMatch ? [...localMatch.local.keys()] : []));
  keyboard.active = true;
  document.body.classList.add("in-match");
  show("none", "");
  hud.hidden = false;
  game.scale.refresh();
  window.dispatchEvent(new Event("resize"));
}

function leaveMatch() {
  inMatch = false;
  localMatch = null;
  online?.leave();
  online = null;
  touchSource = null;
  keyboard.bind([]);
  startAttract();
  showTitle();
}

// HUD ---------------------------------------------------------------------------------------

function renderHud() {
  const s = currentState();
  if (!s || hud.hidden) return;
  const score = currentScore();
  const left = Math.ceil(timeLeftTicks(s) / TICK_RATE);
  const sudden = playTick(s) >= SUDDEN_DEATH_AT;
  const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, "0");
  const chips = s.players.map((p) => {
    const wins = score && matchKind !== "daily" ? "★".repeat(score.wins[p.id]) + "☆".repeat(Math.max(0, WINS_TO_TAKE_MATCH - score.wins[p.id])) : "";
    return `<div class="chip ${p.alive ? "" : "out"}" style="border-color:${CHARACTERS[p.id].colour}" title="${esc(names[p.id] ?? "")}">
      <img src="${portrait(p.id)}" alt=""><span>${esc(names[p.id] ?? CHARACTERS[p.id].name)}</span>${wins ? `<span class="wins" aria-label="${score!.wins[p.id]} wins">${wins}</span>` : ""}</div>`;
  }).join("");
  const label = matchKind === "daily" ? `Daily ${todayUTC()}` : `Round ${score?.round ?? 1}`;
  hud.innerHTML = `
    <div class="hud-timer ${sudden ? "sudden" : ""}" aria-label="Time left">${mm}:${ss}</div>
    <div class="hud-players" aria-label="Players">${chips}</div>
    <span class="hud-status">${label}${online ? ` · <span class="conn ${online.connClass()}">${online.connText()}</span>` : ""}</span>
    <button class="hud-btn" id="pauseBtn" aria-label="${matchKind === "online" ? "Menu" : "Pause"}">${matchKind === "online" ? "☰" : "❚❚"}</button>`;
  hud.querySelector("#pauseBtn")!.addEventListener("click", openPause);
}
setInterval(() => { if (inMatch) { renderHud(); countdown(); } }, 200);

function currentState(): GameState | null {
  if (localMatch) return localMatch.state;
  if (online) return online.view();
  return null;
}
function currentScore(): MatchScore | null {
  if (localMatch) return localMatch.score;
  if (online) return online.score;
  return null;
}

function banner(cls: string, html: string, ms = 1100) {
  if (current !== "none" && current !== "pause") return;
  const el = document.createElement("div");
  el.className = `screen clear`;
  el.innerHTML = `<div class="banner ${cls}">${html}</div>`;
  screens.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function countdown() {
  const s = currentState();
  if (!s || s.phase !== "countdown") return;
  const n = Math.ceil((COUNTDOWN_TICKS - s.tick) / TICK_RATE);
  if (n !== countdownShown && n > 0) {
    countdownShown = n;
    sfx.count();
    banner("count", String(n), 800);
  }
}

function matchEvents(ev: GameEvent[], s: GameState) {
  scene.handleEvents(ev, s);
  for (const e of ev) {
    if (e.type === "go") { sfx.go(); banner("count", "GO!", 700); setMusicIntensity(0); }
    if (e.type === "suddenDeath") { sfx.alarm(); banner("sd", "SUDDEN DEATH<small>The borough is closing in!</small>", 2200); setMusicIntensity(1); }
    if (e.type === "death") renderHud();
  }
}

function roundDecided(s: GameState) {
  setMusicIntensity(0);
  const local = s.winner >= 0 && (matchKind === "online" ? online?.youSlot === s.winner : true);
  if (s.draw) { sfx.draw(); banner("msg", "DRAW!<small>Everyone caught at once</small>", 1800); }
  else if (s.winner >= 0) {
    if (local) sfx.win(); else sfx.draw();
    banner("msg", `${esc(names[s.winner] ?? "")} WINS THE ROUND!`, 1800);
  }
  renderHud();
}

// pause / menu ---------------------------------------------------------------------------------

function openPause() {
  if (!inMatch) return;
  const isOnline = matchKind === "online";
  if (localMatch) localMatch.paused = true;
  keyboard.active = false;
  const resume = () => {
    if (localMatch) localMatch.paused = false;
    keyboard.active = true;
    show("none", "");
  };
  show("pause", `
    <div class="panel">
      <h2>${isOnline ? "Menu" : "Paused"}</h2>
      ${isOnline ? `<p>The match keeps going while this is open.</p>` : ""}
      <div class="menu">
        <button class="btn" data-resume>${isOnline ? "Back to the match" : "Resume"}</button>
        ${isOnline ? "" : `<button class="btn alt" data-restart>Restart match</button>`}
        <button class="btn alt" data-howto>How to Play</button>
        <button class="btn alt" data-settings>Settings</button>
        <button class="btn ghost" data-quit>${isOnline ? "Leave match" : "Quit to menu"}</button>
      </div>
    </div>`, { onBack: resume });
  on("[data-resume]", "click", resume);
  on("[data-restart]", "click", () => { localMatch?.restart(); resume(); });
  on("[data-howto]", "click", () => showHowTo(openPause));
  on("[data-settings]", "click", () => showSettings(openPause));
  on("[data-quit]", "click", leaveMatch);
}
window.addEventListener("keydown", (e) => {
  if (!inMatch || current !== "none") return;
  if (e.key === "Escape" || e.key === "p" || e.key === "P") { e.preventDefault(); openPause(); }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && inMatch && localMatch && current === "none") openPause();
});

// results ------------------------------------------------------------------------------------

function showResults(score: MatchScore, s: GameState) {
  if (!inMatch) return;
  notePlayedMatch();
  keyboard.active = false;
  const w = score.winner;
  const order = s.players.map((p) => p.id).sort((a, b) => score.wins[b] - score.wins[a]);
  const isOnline = matchKind === "online";
  const canRematch = !isOnline || online?.isHost();
  show("results", `
    <div class="panel">
      <div class="winner-hero"><img src="${portrait(w)}" alt=""><h2>${esc(names[w])} takes the match!</h2></div>
      <div class="results">
        ${order.map((id) => `<div class="result-row ${id === w ? "win" : ""}"><img src="${portrait(id)}" alt=""><b>${esc(names[id])}</b><span>${"★".repeat(score.wins[id])}${"☆".repeat(Math.max(0, WINS_TO_TAKE_MATCH - score.wins[id]))}</span><span class="note">${score.kills?.[id] ?? 0} KO</span></div>`).join("")}
      </div>
      <div class="menu two">
        ${canRematch ? `<button class="btn" data-rematch>Rematch</button>` : `<button class="btn" disabled>Waiting for host…</button>`}
        <button class="btn alt" data-menu>${isOnline ? "Leave room" : "Main menu"}</button>
      </div>
      ${isOnline && online?.isHost() ? `<button class="btn ghost small" data-lobby style="margin-top:10px;width:100%">Back to lobby</button>` : ""}
      ${shareRow(brag(score, w), { label: "Share" })}
      ${credit()}
    </div>`, { onBack: leaveMatch });
  on("[data-rematch]", "click", () => {
    if (isOnline) { online?.send({ t: "start" }); return; }
    localMatch?.restart();
    keyboard.active = true;
    show("none", "");
  });
  on("[data-lobby]", "click", () => online?.send({ t: "lobby" }));
  on("[data-menu]", "click", leaveMatch);
}

function brag(score: MatchScore, w: number): string {
  const me = matchKind === "online" ? online?.youSlot ?? -1 : 0;
  if (matchKind !== "local" && w === me) return `I just won ${score.wins[w]}-${Math.max(...score.wins.filter((_, i) => i !== w))} at Blast Borough! Think you can beat me?`;
  return "Just had a brilliant bomb battle in Blast Borough. Free in your browser: fancy a game?";
}

// public leaderboard ---------------------------------------------------------------------------

let boardTab: "today" | "all" = "today";
function showBoard(onBack: () => void) {
  const date = todayUTC();
  const render = (body: string) => {
    show("board", `
      <div class="panel wide">
        <h2>Leaderboard</h2>
        <p class="note">Daily Challenge scores from players everywhere. Everyone gets the same arena each day (UTC).</p>
        ${seg("boardTab", [["today", `Today · ${date}`], ["all", "All time"]], boardTab)}
        <div class="board">${body}</div>
        <div class="row end"><button class="btn ghost" data-back>Back</button><button class="btn" data-play>Play today's challenge</button></div>
      </div>`, { onBack, focus: "[data-back]" });
    wireSeg("boardTab", (v) => { boardTab = v as "today" | "all"; load(); });
    on("[data-back]", "click", onBack);
    on("[data-play]", "click", showDaily);
  };
  const row = (e: BoardEntry, i: number) => {
    const t = `${Math.floor(e.seconds / 60)}:${String(e.seconds % 60).padStart(2, "0")}`;
    return `<div class="board-row ${i < 3 ? "top" : ""} ${e.name === settings.nickname ? "me" : ""}"><span class="rank">${i + 1}</span><b class="name">${esc(e.name)}</b><b class="pts">${e.score}</b><span class="detail">${e.won ? "🏆 " : ""}${e.kills} KO · ${e.crates} crates · ${t}${e.date ? ` · ${e.date}` : ""}</span></div>`;
  };
  const load = () => {
    render(`<p class="note">Loading…</p>`);
    fetchBoard(boardTab === "today" ? { date } : { all: true })
      .then((list) => { if (current === "board") render(list.length ? list.map(row).join("") : `<p class="note">No scores yet${boardTab === "today" ? " today. Be the first!" : "."}</p>`); })
      .catch((err: Error) => { if (current === "board") render(`<p class="error">${esc(err.message)}</p>`); });
  };
  load();
}

// daily challenge ----------------------------------------------------------------------------

interface DailyRecord { date: string; score: number; won: boolean; kills: number; crates: number; seconds: number }
function showDaily() {
  const date = todayUTC();
  const best = storageGet<DailyRecord | null>(`bb.daily.${date}`, null);
  const ever = storageGet<DailyRecord | null>("bb.daily.best", null);
  show("daily", `
    <div class="panel">
      <h2>Daily Challenge</h2>
      <p><b style="color:var(--gold)">${date}</b> (UTC): the same arena, spawns and bots for everyone today.</p>
      <ul class="note" style="line-height:1.6">
        <li>One round against three Normal bots.</li>
        <li>Points: survival time, crates you blast, power-ups, knockouts (150 each) and a big bonus for winning, more if you win quickly.</li>
      </ul>
      <p class="note">Your best today: <b>${best ? `${best.score} pts` : "not played yet"}</b>${ever ? ` · Your best ever: <b>${ever.score}</b> (${ever.date})` : ""}<br>After playing you can put your score on the public leaderboard.</p>
      <div class="row end"><button class="btn ghost" data-back>Back</button><button class="btn alt" data-board>Leaderboard</button><button class="btn" data-start>Play today's challenge</button></div>
    </div>`, { onBack: showTitle, focus: "[data-start]" });
  on("[data-back]", "click", showTitle);
  on("[data-board]", "click", () => showBoard(showDaily));
  on("[data-start]", "click", () => {
    const me = new InputSource();
    const slots: Slot[] = [{ kind: "human", name: CHARACTERS[0].name, source: me, label: "YOU" }];
    for (let i = 1; i < 4; i++) slots.push({ kind: "bot", name: CHARACTERS[i].name, difficulty: "normal" });
    startLocal(slots, [{ source: me, map: KEYS_P1_SOLO }], "daily", `daily-${date}`);
  });
}

function showDailyResult(m: LocalMatch, s: GameState) {
  if (!inMatch) return;
  notePlayedMatch();
  keyboard.active = false;
  const date = todayUTC();
  const d = m.dailyStats;
  const score = dailyScore(d);
  const seconds = Math.floor(d.survivedTicks / TICK_RATE);
  const rec: DailyRecord = { date, score, won: d.won, kills: d.kills, crates: d.crates, seconds };
  const prev = storageGet<DailyRecord | null>(`bb.daily.${date}`, null);
  const newBest = !prev || score > prev.score;
  if (newBest) storageSet(`bb.daily.${date}`, rec);
  const ever = storageGet<DailyRecord | null>("bb.daily.best", null);
  if (!ever || score > ever.score) storageSet("bb.daily.best", rec);
  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const summary = `Blast Borough Daily ${date}\n${d.won ? "🏆 Won" : s.draw ? "🤝 Draw" : "💥 Knocked out"} · ${score} pts\n💣 ${d.crates} crates · 👊 ${d.kills} KO · ⏱ ${mmss}\n${location.origin}${location.pathname}`;
  show("results", `
    <div class="panel">
      <h2>Daily Challenge · ${date}</h2>
      <div class="winner-hero"><img src="${portrait(0)}" alt=""><h2>${d.won ? "You won!" : s.draw ? "A draw!" : "Knocked out!"}</h2></div>
      <div class="results">
        <div class="result-row win"><span></span><b>Score</b><b>${score}</b><span>${newBest ? "New best!" : `Best ${prev!.score}`}</span></div>
        <div class="result-row"><span></span><span>Survived</span><b>${mmss}</b><span></span></div>
        <div class="result-row"><span></span><span>Crates blasted</span><b>${d.crates}</b><span></span></div>
        <div class="result-row"><span></span><span>Knockouts</span><b>${d.kills}</b><span></span></div>
      </div>
      <div class="row submit-row">
        <input type="text" id="lbName" maxlength="16" autocomplete="nickname" placeholder="Your name" value="${esc(settings.nickname)}" aria-label="Your name for the leaderboard">
        <button class="btn small" data-submit>Add to leaderboard</button>
      </div>
      <div class="note" id="lbStatus" role="status"></div>
      <div class="menu two">
        <button class="btn alt" data-copy>Copy result</button>
        <button class="btn alt" data-again>Try again</button>
      </div>
      <button class="btn ghost small" data-menu style="margin-top:10px;width:100%">Main menu</button>
      ${shareRow(`I scored ${score} in today's Blast Borough Daily Challenge (${date}). Can you beat it?`, { label: "Challenge friends" })}
      ${credit()}
    </div>`, { onBack: leaveMatch, focus: "[data-copy]" });
  on("[data-copy]", "click", async () => {
    try { await navigator.clipboard.writeText(summary); toast("Result copied: paste it to your friends!"); }
    catch { prompt("Copy your result:", summary); }
  });
  on("[data-submit]", "click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const name = screens.querySelector<HTMLInputElement>("#lbName")!.value.trim();
    const status = screens.querySelector<HTMLElement>("#lbStatus")!;
    if (name.length < 2) { status.textContent = "Type a name first (2 to 16 letters)."; return; }
    settings.nickname = name; saveSettings();
    btn.disabled = true;
    status.textContent = "Sending…";
    try {
      const r = await submitDaily({ name, date, won: d.won, kills: d.kills, crates: d.crates, pickups: d.pickups, seconds, score });
      status.innerHTML = `${r.best ? "On the board!" : `Your best today is still ${r.score}.`} You're <b>#${r.rank}</b> today. <a href="#" data-view>See the leaderboard</a>`;
      status.querySelector("[data-view]")!.addEventListener("click", (ev) => { ev.preventDefault(); showBoard(leaveMatch); });
    } catch (err) {
      btn.disabled = false;
      status.textContent = (err as Error).message;
    }
  });
  screens.querySelector("#lbName")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") screens.querySelector<HTMLButtonElement>("[data-submit]")?.click(); });
  on("[data-again]", "click", () => { m.restart(); keyboard.active = true; show("none", ""); });
  on("[data-menu]", "click", leaveMatch);
}

// ------------------------------------------------------------------------------------------
// online (screens live here; the connection logic is in net.ts)

let online: OnlineSession | null = null;

function showOnline(error = "") {
  const invite = params.get("room") ?? "";
  show("online", `
    <div class="panel">
      <h2>Online Multiplayer</h2>
      <p>Private rooms for 2 to 8 players. Create one and send the link, or type a friend's code.</p>
      <label class="field">Your name <input type="text" id="nick" maxlength="16" autocomplete="nickname" value="${esc(settings.nickname)}" placeholder="e.g. Sam"></label>
      <div class="menu" style="margin-top:12px">
        <button class="btn" data-create>Create a room</button>
        <div class="row"><input type="text" id="code" maxlength="5" placeholder="CODE" value="${esc(invite)}" aria-label="Room code" style="flex:1;text-transform:uppercase;letter-spacing:0.2em;text-align:center"><button class="btn alt" data-join>Join</button></div>
      </div>
      <div class="error" role="alert">${esc(error)}</div>
      <p class="note">${SERVER_URL ? `Server: <code>${esc(SERVER_URL)}</code>` : "Whoever creates the room hosts the game in their browser: keep this tab open until the match is over. Friends connect to you directly."}</p>
      <div class="row end"><button class="btn ghost" data-back>Back</button></div>
    </div>`, { onBack: showTitle, focus: invite ? "#nick" : "#nick" });
  const nick = screens.querySelector<HTMLInputElement>("#nick")!;
  const getName = () => {
    const n = nick.value.trim();
    if (!n) { showErr("Pick a name first."); nick.focus(); return null; }
    settings.nickname = n;
    saveSettings();
    return n;
  };
  const showErr = (t: string) => { screens.querySelector(".error")!.textContent = t; };
  on("[data-back]", "click", showTitle);
  on("[data-create]", "click", () => { const n = getName(); if (n) connect({ t: "create", name: n }); });
  const join = () => {
    const n = getName();
    const code = screens.querySelector<HTMLInputElement>("#code")!.value.trim().toUpperCase();
    if (!n) return;
    if (code.length !== 5) { showErr("Room codes are 5 letters and numbers."); return; }
    connect({ t: "join", name: n, code });
  };
  on("[data-join]", "click", join);
  screens.querySelector("#code")!.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") join(); });
}

function connect(first: { t: "create"; name: string } | { t: "join"; name: string; code: string }) {
  online?.leave();
  const what = SERVER_URL ? "Connecting to the server" : first.t === "create" ? "Setting up your room" : "Connecting to the host";
  show("lobby", `<div class="panel"><h2>Connecting…</h2><p><span class="conn wait">${what}…</span></p><div class="row end"><button class="btn ghost" data-back>Cancel</button></div></div>`, { onBack: () => { online?.leave(); online = null; showOnline(); } });
  on("[data-back]", "click", () => { online?.leave(); online = null; showOnline(); });
  p2pHost?.stop();
  p2pHost = null;
  let connectFn;
  if (SERVER_URL) connectFn = () => webSocketTransport(SERVER_URL);
  else if (first.t === "create") { const host = new P2PHost(); p2pHost = host; connectFn = () => host.start(); }
  else { const code = first.code; connectFn = () => joinHost(code); }
  const session = new OnlineSession(first, {
    lobby: () => { if (!inMatch || current === "results") showLobby(); },
    match: () => startOnlineMatch(),
    events: (ev, s) => matchEvents(ev, s),
    decided: (s) => roundDecided(s),
    roundStart: () => { countdownShown = -1; },
    over: (score, s) => setTimeout(() => showResults(score, s), 1100),
    error: (msg) => {
      if (inMatch) { toast(msg); return; }
      online = null;
      showOnline(msg);
    },
    notice: (msg) => toast(msg),
  }, connectFn);
  online = session;
}

function showLobby() {
  if (!online) return;
  const L = online.lobbyInfo;
  if (!L) return;
  if (inMatch) { inMatch = false; document.body.classList.remove("in-match"); hud.hidden = true; keyboard.active = false; startAttract(); }
  const me = L.players.find((p) => p.id === online!.you);
  const host = !!me?.host;
  const humans = L.players.filter((p) => p.connected).length;
  const total = humans + L.bots;
  const allReady = L.players.filter((p) => p.connected && !p.host).every((p) => p.ready);
  const canStart = host && total >= 2 && allReady;
  const link = `${location.origin}${location.pathname}?room=${L.code}`;
  if (p2pHost) p2pHost.slowPoll = false;
  show("lobby", `
    <div class="panel">
      <div class="row"><h2 style="flex:1">Room</h2><span class="conn ${online.connClass()}">${online.connText()}</span></div>
      <div class="room-code" aria-label="Room code">${L.code}</div>
      <div class="menu two"><button class="btn alt small" data-copy>Copy invite link</button><button class="btn alt small" data-copycode>Copy code</button></div>
      <div class="players">
        ${L.players.map((p, i) => `<div class="player-row"><img src="${portrait(i)}" alt=""><span class="name">${esc(p.name)}${p.id === online!.you ? " (you)" : ""}</span>${p.host ? `<span class="badge host">Host</span>` : ""}${!p.connected ? `<span class="badge">Left</span>` : p.host ? "" : `<span class="badge ${p.ready ? "ready" : ""}">${p.ready ? "Ready" : "Not ready"}</span>`}</div>`).join("")}
        ${Array.from({ length: L.bots }, (_, k) => `<div class="player-row"><img src="${portrait(L.players.length + k)}" alt=""><span class="name">${CHARACTERS[L.players.length + k]?.name ?? "Bot"}</span><span class="badge bot">Bot · ${L.difficulty}</span></div>`).join("")}
      </div>
      ${host ? `<div class="row"><label class="field">Bots</label>${seg("obots", Array.from({ length: Math.max(0, L.max - L.players.length) + 1 }, (_, i) => [String(i), String(i)] as [string, string]).slice(0, 8), String(L.bots))}</div>
        <div class="row" style="margin-top:8px"><label class="field">Bot difficulty</label>${seg("odiff", [["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]], L.difficulty)}</div>` : ""}
      <p class="note">${isTouch ? "Steer with the pad, tap BOMB to drop a bomb." : "Move with WASD or the arrow keys, Space drops a bomb."} First to ${WINS_TO_TAKE_MATCH} round wins.</p>
      ${p2pHost ? `<p class="note"><b>You're hosting:</b> the game runs in this browser, so keep this tab open until you're done.</p>` : ""}
      <p class="note">${host ? (canStart ? "Everyone's ready." : total < 2 ? "Waiting for at least one more player (or add a bot)." : "Waiting for everyone to be ready.") : "Waiting for the host to start."}</p>
      <div class="row end">
        <button class="btn ghost" data-leave>Leave</button>
        ${host ? `<button class="btn" data-start ${canStart ? "" : "disabled"}>Start match</button>` : `<button class="btn" data-ready>${me?.ready ? "Not ready" : "I'm ready"}</button>`}
      </div>
    </div>`, { onBack: () => { online?.leave(); online = null; showOnline(); }, focus: host ? "[data-start]" : "[data-ready]" });
  wireSeg("obots", (v) => online?.send({ t: "bots", count: Number(v), difficulty: L.difficulty }));
  wireSeg("odiff", (v) => online?.send({ t: "bots", count: L.bots, difficulty: v as Difficulty }));
  on("[data-copy]", "click", async () => { try { await navigator.clipboard.writeText(link); toast("Invite link copied"); } catch { prompt("Copy the invite link:", link); } });
  on("[data-copycode]", "click", async () => { try { await navigator.clipboard.writeText(L.code); toast("Room code copied"); } catch { prompt("Room code:", L.code); } });
  on("[data-leave]", "click", () => { online?.leave(); online = null; showOnline(); });
  on("[data-start]", "click", () => online?.send({ t: "start" }));
  on("[data-ready]", "click", () => online?.send({ t: "ready", ready: !me?.ready }));
}

function startOnlineMatch() {
  if (!online) return;
  matchKind = "online";
  names = online.slots.map((s) => s.name);
  localMatch = null;
  const src = new InputSource();
  online.setInput(src);
  if (params.has("autoplay")) { const o = online; autoplay(src, () => o.view(), o.youSlot); }
  keyboard.bind([{ source: src, map: KEYS_P1_SOLO }]);
  touchSource = src;
  countdownShown = -1;
  enterMatchUi();
  const o = online;
  if (p2pHost) p2pHost.slowPoll = true;
  setDriver({ advance: (dt) => o.advance(dt), frame: () => o.frame() });
}

// keep the HUD's connection badge fresh and expose a tiny read-only hook for automated tests
(window as unknown as { __bb: object }).__bb = {
  screen: () => current,
  state: () => currentState(),
  score: () => currentScore(),
  kind: () => matchKind,
  online: () => online?.debug(),
};
