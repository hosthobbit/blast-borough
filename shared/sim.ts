// The authoritative game simulation. Pure data in, pure data out: no rendering, no timers, no
// Math.random. The browser (solo/local), the server (online) and the tests all run this code.

import {
  BASE_SPEED, CORNER_ASSIST, COUNTDOWN_TICKS, CRATE_BURN_TICKS, Cell, DX, DY, Dir, END_DELAY_TICKS,
  FLAME_TICKS, FUSE_TICKS, HALF, KICK_SPEED, MAX_BOMBS, MAX_RANGE, MAX_SPEED_UPS, PowerUp,
  ROUND_HARD_CAP, ROUND_TICKS, SPEED_STEP, START_BOMBS, START_RANGE, SUB, SUDDEN_DEATH_AT,
} from "./constants.js";
import { Rng } from "./rng.js";
import { generateMap, type MapLayout } from "./map.js";

export interface Input {
  dir: Dir;
  /** true on the tick the bomb button was pressed */
  bomb: boolean;
}

export const NO_INPUT: Input = { dir: Dir.None, bomb: false };

export interface Player {
  id: number;            // 0..7, also the spawn slot and character
  x: number;             // centre, sub-units
  y: number;
  facing: Dir;
  moving: boolean;
  alive: boolean;
  diedAt: number;        // tick, -1 while alive
  killer: number;        // player id, -1 none/self-less (sudden death)
  bombsMax: number;
  bombsOut: number;
  range: number;
  speedUps: number;
  kick: boolean;
  kills: number;
}

export interface Bomb {
  id: number;
  owner: number;
  x: number;             // centre, sub-units (bombs only leave a cell centre when kicked)
  y: number;
  fuse: number;          // ticks left
  range: number;
  passers: number[];     // players standing on it when placed: they may walk off it, never back
  slide: Dir;            // kicked direction, None when still
}

export interface Flame {
  ticks: number;
  owner: number;
  /** blast shape for rendering: "c" centre, "h"/"v" middle, or end caps "u","d","l","r" */
  part: string;
}

export type GamePhase = "countdown" | "playing" | "ended";

export type GameEvent =
  | { type: "bomb"; x: number; y: number; owner: number }
  | { type: "explode"; x: number; y: number; cells: number[]; owner: number }
  | { type: "crate"; cell: number; owner: number }
  | { type: "reveal"; cell: number; kind: PowerUp }
  | { type: "pickup"; player: number; kind: PowerUp; cell: number }
  | { type: "kick"; player: number; bomb: number }
  | { type: "death"; player: number; killer: number; crushed: boolean }
  | { type: "suddenDeath" }
  | { type: "drop"; cell: number }
  | { type: "go" }
  | { type: "end"; winner: number; draw: boolean };

export interface GameState {
  w: number;
  h: number;
  tick: number;            // ticks since the round was created (countdown included)
  phase: GamePhase;
  grid: Cell[];
  burn: number[];          // per cell: ticks until a burning crate is gone
  hidden: number[];        // per cell: power-up waiting under a crate (0 none)
  powerups: number[];      // per cell: power-up lying on the floor (0 none)
  bombs: Bomb[];
  flames: Record<number, Flame>;
  players: Player[];
  nextBombId: number;
  rngState: number;
  dropOrder: number[];     // sudden-death cells, outside in
  dropIndex: number;
  endTick: number;         // tick the round was decided
  winner: number;          // -1 draw / undecided
  draw: boolean;
  seed: number;
  events: GameEvent[];     // produced by the last step; consumers read then clear
}

export interface RoundOptions {
  seed: number;
  players: number;         // 2..8
}

export const cellIndex = (s: { w: number }, cx: number, cy: number) => cy * s.w + cx;
export const cellOf = (v: number) => Math.floor(v / SUB);
export const centre = (c: number) => c * SUB + HALF;

export function playerSpeed(p: Player): number {
  return BASE_SPEED + SPEED_STEP * p.speedUps;
}

export function createRound(opts: RoundOptions): GameState {
  const layout: MapLayout = generateMap(opts.seed, opts.players);
  const players: Player[] = layout.spawns.map((sp, id) => ({
    id, x: centre(sp.x), y: centre(sp.y), facing: Dir.Down, moving: false, alive: true, diedAt: -1, killer: -1,
    bombsMax: START_BOMBS, bombsOut: 0, range: START_RANGE, speedUps: 0, kick: false, kills: 0,
  }));
  return {
    w: layout.w, h: layout.h, tick: 0, phase: "countdown",
    grid: layout.grid, burn: layout.grid.map(() => 0), hidden: layout.hidden, powerups: layout.grid.map(() => 0),
    bombs: [], flames: {}, players, nextBombId: 1, rngState: new Rng(opts.seed ^ 0x9e3779b9).state,
    dropOrder: spiralOrder(layout.w, layout.h), dropIndex: 0,
    endTick: -1, winner: -1, draw: false, seed: opts.seed, events: [],
  };
}

/** Interior cells from the outer ring inwards, clockwise: the order sudden-death blocks fall in. */
export function spiralOrder(w: number, h: number): number[] {
  const out: number[] = [];
  let x0 = 1, y0 = 1, x1 = w - 2, y1 = h - 2;
  while (x0 <= x1 && y0 <= y1) {
    for (let x = x0; x <= x1; x++) out.push(y0 * w + x);
    for (let y = y0 + 1; y <= y1; y++) out.push(y * w + x1);
    if (y1 > y0) for (let x = x1 - 1; x >= x0; x--) out.push(y1 * w + x);
    if (x1 > x0) for (let y = y1 - 1; y > y0; y--) out.push(y * w + x0);
    x0++; y0++; x1--; y1--;
  }
  return out;
}

/** Ticks between sudden-death drops so the arena closes completely by ROUND_TICKS. */
export function dropInterval(s: GameState): number {
  const open = s.dropOrder.length;
  return Math.max(1, Math.floor((ROUND_TICKS - SUDDEN_DEATH_AT) / open));
}

export function playTick(s: GameState): number {
  return s.tick - COUNTDOWN_TICKS;
}

export function timeLeftTicks(s: GameState): number {
  return Math.max(0, ROUND_TICKS - playTick(s));
}

export function bombAt(s: GameState, cell: number): Bomb | undefined {
  for (const b of s.bombs) if (cellIndex(s, cellOf(b.x), cellOf(b.y)) === cell) return b;
  return undefined;
}

function solid(s: GameState, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= s.w || cy >= s.h) return true;
  return s.grid[cellIndex(s, cx, cy)] !== Cell.Floor;
}

/** Can player p enter cell (cx, cy)? Bombs block everyone except their passers. */
export function passable(s: GameState, p: Player | null, cx: number, cy: number): boolean {
  if (solid(s, cx, cy)) return false;
  const b = bombAt(s, cellIndex(s, cx, cy));
  if (!b) return true;
  return p !== null && b.passers.includes(p.id);
}

// ---------------------------------------------------------------------------------------------
// step

export function step(s: GameState, inputs: readonly Input[]): void {
  s.events = [];
  s.tick++;
  if (s.phase === "countdown") {
    if (s.tick >= COUNTDOWN_TICKS) {
      s.phase = "playing";
      s.events.push({ type: "go" });
    }
    return;
  }
  if (s.phase === "ended") return;

  const t = playTick(s);
  // 1. players act (movement, bombs, kicks)
  for (const p of s.players) {
    if (!p.alive) continue;
    const input = inputs[p.id] ?? { dir: Dir.None, bomb: false };
    if (input.bomb) placeBomb(s, p);
    movePlayer(s, p, input.dir);
  }
  for (const b of s.bombs) b.passers = b.passers.filter((id) => stillOnBomb(s, s.players[id], b));

  // 2. sliding bombs, fuses, explosions (with chain reactions), flames and burning crates
  slideBombs(s);
  updateFlamesAndCrates(s);
  const due: Bomb[] = [];
  for (const b of s.bombs) if (--b.fuse <= 0) due.push(b);
  for (const b of s.bombs) if (b.fuse > 0 && s.flames[cellIndex(s, cellOf(b.x), cellOf(b.y))]) due.push(b); // slid into fire
  if (due.length) explode(s, due);

  // 3. sudden death
  if (t === SUDDEN_DEATH_AT) s.events.push({ type: "suddenDeath" });
  if (t >= SUDDEN_DEATH_AT) {
    const every = dropInterval(s);
    while (s.dropIndex < s.dropOrder.length && (t - SUDDEN_DEATH_AT) >= s.dropIndex * every) dropBlock(s, s.dropOrder[s.dropIndex++]);
  }

  // 4. pickups and deaths (resolved together so simultaneous eliminations are a draw)
  for (const p of s.players) {
    if (!p.alive) continue;
    const c = cellIndex(s, cellOf(p.x), cellOf(p.y));
    const kind = s.powerups[c];
    if (kind) {
      applyPowerUp(p, kind);
      s.powerups[c] = 0;
      s.events.push({ type: "pickup", player: p.id, kind, cell: c });
    }
  }
  const dying: Player[] = [];
  for (const p of s.players) {
    if (!p.alive) continue;
    const c = cellIndex(s, cellOf(p.x), cellOf(p.y));
    if (s.flames[c] || s.grid[c] === Cell.Wall) dying.push(p);
  }
  for (const p of dying) {
    const c = cellIndex(s, cellOf(p.x), cellOf(p.y));
    const crushed = s.grid[c] === Cell.Wall;
    const killer = crushed ? -1 : s.flames[c].owner;
    p.alive = false;
    p.diedAt = s.tick;
    p.killer = killer;
    if (killer >= 0 && killer !== p.id) s.players[killer].kills++;
    s.events.push({ type: "death", player: p.id, killer, crushed });
  }

  // 5. round result
  if (s.endTick < 0) {
    const alive = s.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      s.endTick = s.tick;
      s.winner = alive.length === 1 ? alive[0].id : -1;
      s.draw = alive.length === 0;
      s.events.push({ type: "end", winner: s.winner, draw: s.draw });
    } else if (t >= ROUND_HARD_CAP) {
      s.endTick = s.tick;
      s.winner = -1;
      s.draw = true;
      s.events.push({ type: "end", winner: -1, draw: true });
    }
  } else if (s.tick - s.endTick >= END_DELAY_TICKS) {
    s.phase = "ended";
  }
}

function stillOnBomb(s: GameState, p: Player, b: Bomb): boolean {
  if (!p.alive) return false;
  // the player's body (a bit narrower than a tile) still overlaps the bomb's cell
  const reach = SUB * 0.8;
  return Math.abs(p.x - b.x) < reach && Math.abs(p.y - b.y) < reach;
}

export function placeBomb(s: GameState, p: Player): boolean {
  if (p.bombsOut >= p.bombsMax) return false;
  const cx = cellOf(p.x), cy = cellOf(p.y);
  const c = cellIndex(s, cx, cy);
  if (bombAt(s, c) || s.grid[c] !== Cell.Floor) return false;
  const passers = s.players.filter((q) => q.alive && Math.abs(q.x - centre(cx)) < SUB * 0.8 && Math.abs(q.y - centre(cy)) < SUB * 0.8).map((q) => q.id);
  s.bombs.push({ id: s.nextBombId++, owner: p.id, x: centre(cx), y: centre(cy), fuse: FUSE_TICKS, range: p.range, passers, slide: Dir.None });
  p.bombsOut++;
  s.events.push({ type: "bomb", x: cx, y: cy, owner: p.id });
  return true;
}

function applyPowerUp(p: Player, kind: PowerUp): void {
  switch (kind) {
    case PowerUp.BombUp: p.bombsMax = Math.min(MAX_BOMBS, p.bombsMax + 1); break;
    case PowerUp.FireUp: p.range = Math.min(MAX_RANGE, p.range + 1); break;
    case PowerUp.SpeedUp: p.speedUps = Math.min(MAX_SPEED_UPS, p.speedUps + 1); break;
    case PowerUp.Kick: p.kick = true; break;
  }
}

// ---------------------------------------------------------------------------------------------
// movement: continuous, but locked to lanes. Turning slightly early or late is forgiven: the
// player is slid onto the lane they are aiming for (corner assist).

export function movePlayer(s: GameState, p: Player, dir: Dir): void {
  p.moving = false;
  if (dir === Dir.None) return;
  p.facing = dir;
  let budget = playerSpeed(p);
  const horizontal = dir === Dir.Left || dir === Dir.Right;
  const dx = DX[dir], dy = DY[dir];

  // align across the direction of travel first
  const cx = cellOf(p.x), cy = cellOf(p.y);
  const across = horizontal ? p.y - centre(cy) : p.x - centre(cx);
  if (across !== 0) {
    const aheadX = cx + dx, aheadY = cy + dy;
    let target = horizontal ? centre(cy) : centre(cx);
    if (!passable(s, p, aheadX, aheadY) && Math.abs(across) <= CORNER_ASSIST) {
      // our lane is blocked ahead: maybe the neighbouring lane we're leaning into is open
      const side = Math.sign(across);
      const nx = horizontal ? cx : cx + side, ny = horizontal ? cy + side : cy;
      if (passable(s, p, nx, ny) && passable(s, p, nx + dx, ny + dy)) target = horizontal ? centre(ny) : centre(nx);
      else {
        // nothing to aim for: just face the wall
        return;
      }
    }
    const pos = horizontal ? p.y : p.x;
    const delta = Math.max(-budget, Math.min(budget, target - pos));
    if (horizontal) p.y += delta; else p.x += delta;
    budget -= Math.abs(delta);
    p.moving = delta !== 0;
    if (horizontal ? p.y !== centre(cellOf(p.y)) : p.x !== centre(cellOf(p.x))) return;
  }
  if (budget <= 0) return;

  // move along the lane; stop at the centre of the last open cell
  const lx = cellOf(p.x), ly = cellOf(p.y);
  const pos = horizontal ? p.x : p.y;
  const mid = horizontal ? centre(lx) : centre(ly);
  const nextOpen = passable(s, p, lx + dx, ly + dy);
  let goal = pos + (horizontal ? dx : dy) * budget;
  if (!nextOpen) {
    const sign = horizontal ? dx : dy;
    if ((goal - mid) * sign > 0) goal = (pos - mid) * sign > 0 ? pos : mid;
    if (p.kick) tryKick(s, p, lx + dx, ly + dy, dir);
  }
  if (goal !== pos) p.moving = true;
  if (horizontal) p.x = goal; else p.y = goal;
}

function tryKick(s: GameState, p: Player, cx: number, cy: number, dir: Dir): void {
  if (solid(s, cx, cy)) return;
  const b = bombAt(s, cellIndex(s, cx, cy));
  if (!b || b.slide !== Dir.None || b.passers.includes(p.id)) return;
  // only kick from close up, facing the bomb squarely
  const horizontal = dir === Dir.Left || dir === Dir.Right;
  if (Math.abs(horizontal ? p.x - b.x : p.y - b.y) > SUB * 1.05) return;
  if (!bombCanEnter(s, b, cx + DX[dir], cy + DY[dir])) return;
  b.slide = dir;
  s.events.push({ type: "kick", player: p.id, bomb: b.id });
}

function bombCanEnter(s: GameState, b: Bomb, cx: number, cy: number): boolean {
  if (solid(s, cx, cy)) return false;
  const c = cellIndex(s, cx, cy);
  if (s.powerups[c]) return false;
  const other = bombAt(s, c);
  if (other && other !== b) return false;
  for (const p of s.players) if (p.alive && cellOf(p.x) === cx && cellOf(p.y) === cy) return false;
  return true;
}

function slideBombs(s: GameState): void {
  for (const b of s.bombs) {
    if (b.slide === Dir.None) continue;
    const dx = DX[b.slide], dy = DY[b.slide];
    const cx = cellOf(b.x), cy = cellOf(b.y);
    const mid = { x: centre(cx), y: centre(cy) };
    const along = dx !== 0 ? (b.x - mid.x) * dx : (b.y - mid.y) * dy; // progress past this cell's centre
    if (along >= 0 && !bombCanEnter(s, b, cx + dx, cy + dy)) {
      b.x = mid.x; b.y = mid.y; b.slide = Dir.None;
      continue;
    }
    let nx = b.x + dx * KICK_SPEED, ny = b.y + dy * KICK_SPEED;
    // don't overshoot the centre of a cell we can't leave
    const ncx = cellOf(nx), ncy = cellOf(ny);
    if ((ncx !== cx || ncy !== cy) && !bombCanEnter(s, b, ncx, ncy)) { nx = mid.x; ny = mid.y; b.slide = Dir.None; }
    else if (!bombCanEnter(s, b, ncx + dx, ncy + dy)) {
      const c2 = { x: centre(ncx), y: centre(ncy) };
      if ((dx !== 0 ? (nx - c2.x) * dx : (ny - c2.y) * dy) >= 0) { nx = c2.x; ny = c2.y; b.slide = Dir.None; }
    }
    b.x = nx; b.y = ny;
  }
}

// ---------------------------------------------------------------------------------------------
// explosions

/** Cells a bomb's blast reaches: four straight arms; walls stop it, a crate or bomb takes the hit and stops it. */
export function blastCells(s: GameState, cx: number, cy: number, range: number): { cells: number[]; parts: string[] } {
  const cells = [cellIndex(s, cx, cy)];
  const parts = ["c"];
  const caps = ["", "u", "d", "l", "r"];
  for (let d = 1; d <= 4; d++) {
    for (let i = 1; i <= range; i++) {
      const x = cx + DX[d] * i, y = cy + DY[d] * i;
      if (x < 0 || y < 0 || x >= s.w || y >= s.h) break;
      const c = cellIndex(s, x, y);
      const g = s.grid[c];
      if (g === Cell.Wall) break;
      const stops = g === Cell.Crate || g === Cell.Burning || !!bombAt(s, c);
      cells.push(c);
      parts.push(stops || i === range ? caps[d] : d <= 2 ? "v" : "h");
      if (stops) break;
    }
  }
  return { cells, parts };
}

function explode(s: GameState, first: Bomb[]): void {
  const queue = [...first];
  const done = new Set<number>();
  while (queue.length) {
    const b = queue.shift()!;
    if (done.has(b.id)) continue;
    done.add(b.id);
    s.bombs = s.bombs.filter((o) => o !== b);
    const owner = s.players[b.owner];
    owner.bombsOut = Math.max(0, owner.bombsOut - 1);
    const cx = cellOf(b.x), cy = cellOf(b.y);
    const { cells, parts } = blastCells(s, cx, cy, b.range);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (s.grid[c] === Cell.Crate) {
        s.grid[c] = Cell.Burning;
        s.burn[c] = CRATE_BURN_TICKS;
        s.events.push({ type: "crate", cell: c, owner: b.owner });
      }
      const chained = bombAt(s, c);
      if (chained && !done.has(chained.id)) queue.push(chained);
      if (s.powerups[c]) s.powerups[c] = 0; // blasts destroy loose power-ups
      const existing = s.flames[c];
      s.flames[c] = { ticks: FLAME_TICKS, owner: b.owner, part: existing && existing.part !== parts[i] ? "c" : parts[i] };
    }
    s.events.push({ type: "explode", x: cx, y: cy, cells, owner: b.owner });
  }
}

function updateFlamesAndCrates(s: GameState): void {
  for (const key of Object.keys(s.flames)) {
    const c = Number(key);
    if (--s.flames[c].ticks <= 0) delete s.flames[c];
  }
  for (let c = 0; c < s.grid.length; c++) {
    if (s.grid[c] !== Cell.Burning) continue;
    if (--s.burn[c] > 0) continue;
    s.grid[c] = Cell.Floor;
    if (s.hidden[c]) {
      s.powerups[c] = s.hidden[c];
      s.events.push({ type: "reveal", cell: c, kind: s.hidden[c] });
      s.hidden[c] = 0;
    }
  }
}

function dropBlock(s: GameState, c: number): void {
  if (s.grid[c] === Cell.Wall) return;
  s.grid[c] = Cell.Wall;
  s.hidden[c] = 0;
  s.powerups[c] = 0;
  delete s.flames[c];
  for (const b of s.bombs.filter((o) => cellIndex(s, cellOf(o.x), cellOf(o.y)) === c)) {
    s.bombs = s.bombs.filter((o) => o !== b);
    s.players[b.owner].bombsOut = Math.max(0, s.players[b.owner].bombsOut - 1);
  }
  s.events.push({ type: "drop", cell: c });
}

// ---------------------------------------------------------------------------------------------
// match bookkeeping (first to N round wins)

export interface MatchScore {
  wins: number[];
  kills: number[];  // knockouts across the whole match
  round: number;
  winner: number;   // match winner, -1 while undecided
}

export function newMatch(players: number): MatchScore {
  return { wins: new Array(players).fill(0), kills: new Array(players).fill(0), round: 1, winner: -1 };
}

export function recordRound(m: MatchScore, s: GameState, winsNeeded: number): void {
  if (!s.draw && s.winner >= 0) m.wins[s.winner]++;
  for (const p of s.players) m.kills[p.id] = (m.kills[p.id] ?? 0) + p.kills;
  const best = m.wins.findIndex((w) => w >= winsNeeded);
  if (best >= 0) m.winner = best;
  else m.round++;
}

/** Deep copy (structuredClone keeps it simple; states are small). */
export function cloneState(s: GameState): GameState {
  return structuredClone(s);
}

export function rngFor(s: GameState): Rng {
  return new Rng(s.rngState);
}

export const _internals = { stillOnBomb, explode, dropBlock, solid, FLAME_TICKS, MAX_SPEED_UPS };
