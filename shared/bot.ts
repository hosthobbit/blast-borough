// Bots: plan on the cell grid with a forecast of when every cell will be on fire (chain
// reactions included), and only bomb when a safe escape exists. They send the same inputs a
// human would, so they get no hidden advantages; difficulty changes how fast they react and
// how ambitious their decisions are.

import { Cell, DX, DY, Dir, FLAME_TICKS, FUSE_TICKS, SUB, SUDDEN_DEATH_AT } from "./constants.js";
import { Rng } from "./rng.js";
import {
  type Bomb, type GameState, type Input, type Player, blastCells, bombAt, cellIndex, cellOf, centre, dropInterval,
  playTick, playerSpeed,
} from "./sim.js";

export type Difficulty = "easy" | "normal" | "hard";

interface Tuning {
  think: number;         // ticks between decisions (reaction time)
  hunt: number;          // 0..1 appetite for attacking players rather than crates
  wander: number;        // chance of an aimless move when nothing urgent
  margin: number;        // ticks of safety kept around forecast flames
  bombChance: number;    // how readily a good bombing spot is used
}

const TUNING: Record<Difficulty, Tuning> = {
  easy: { think: 14, hunt: 0.15, wander: 0.25, margin: 8, bombChance: 0.45 },
  normal: { think: 7, hunt: 0.5, wander: 0.08, margin: 5, bombChance: 0.8 },
  hard: { think: 3, hunt: 0.9, wander: 0, margin: 4, bombChance: 1 },
};

/** Danger forecast: for each cell, the time windows (in ticks from now) when it will be on fire. */
export type Forecast = Map<number, [number, number][]>;

/** When each bomb will go off, taking chain reactions into account. */
export function detonationTimes(s: GameState, extra: Bomb[] = []): Map<Bomb, number> {
  const bombs = [...s.bombs, ...extra];
  const t = new Map<Bomb, number>(bombs.map((b) => [b, b.fuse]));
  const reach = new Map<Bomb, number[]>();
  // with extra bombs present, blasts must see them as blockers too
  const view = extra.length ? { ...s, bombs } : s;
  for (const b of bombs) reach.set(b, blastCells(view, cellOf(b.x), cellOf(b.y), b.range).cells);
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of bombs) {
      const ta = t.get(a)!;
      for (const c of reach.get(a)!) {
        const hit = bombs.find((o) => o !== a && cellIndex(s, cellOf(o.x), cellOf(o.y)) === c);
        if (hit && t.get(hit)! > ta) { t.set(hit, ta); changed = true; }
      }
    }
  }
  return t;
}

export function forecast(s: GameState, extra: Bomb[] = []): Forecast {
  const f: Forecast = new Map();
  const add = (c: number, from: number, to: number) => {
    const list = f.get(c);
    if (list) list.push([from, to]); else f.set(c, [[from, to]]);
  };
  for (const [key, fl] of Object.entries(s.flames)) add(Number(key), 0, fl.ticks);
  const bombs = [...s.bombs, ...extra];
  const view = extra.length ? { ...s, bombs } : s;
  const det = detonationTimes(s, extra);
  for (const b of bombs) {
    const t = det.get(b)!;
    for (const c of blastCells(view, cellOf(b.x), cellOf(b.y), b.range).cells) add(c, t, t + FLAME_TICKS);
  }
  // sudden death: cells about to be closed are deadly from then on
  const pt = playTick(s);
  if (pt >= SUDDEN_DEATH_AT - 60) {
    const every = dropInterval(s);
    for (let i = s.dropIndex; i < s.dropOrder.length; i++) {
      const at = SUDDEN_DEATH_AT + i * every - pt;
      if (at > 150) break;
      add(s.dropOrder[i], Math.max(0, at), 1e9);
    }
  }
  return f;
}

function dangerAt(f: Forecast, c: number, from: number, to: number): boolean {
  const list = f.get(c);
  if (!list) return false;
  for (const [a, b] of list) if (a <= to && b >= from) return true;
  return false;
}

function everDangerous(f: Forecast, c: number, after: number): boolean {
  const list = f.get(c);
  if (!list) return false;
  return list.some(([, b]) => b >= after);
}

interface Node { cell: number; t: number; first: number; steps: number }

/**
 * Breadth-first search over cells, timing each step from the bot's speed and rejecting steps
 * that would be on fire when the bot gets there. Returns the reachable cells with arrival times.
 */
function explore(s: GameState, p: Player, f: Forecast, margin: number, extra: Bomb[] = []): Node[] {
  const per = Math.ceil(SUB / playerSpeed(p));
  const start = cellIndex(s, cellOf(p.x), cellOf(p.y));
  // time to reach our own cell's centre first
  const off = Math.abs(p.x - centre(cellOf(p.x))) + Math.abs(p.y - centre(cellOf(p.y)));
  const t0 = Math.ceil(off / playerSpeed(p));
  const seen = new Map<number, Node>();
  const out: Node[] = [];
  const startNode = { cell: start, t: t0, first: -1, steps: 0 };
  seen.set(start, startNode);
  out.push(startNode);
  const q = [startNode];
  const blocked = (c: number) => {
    if (s.grid[c] !== Cell.Floor) return true;
    const b = bombAt(s, c) ?? extra.find((e) => cellIndex(s, cellOf(e.x), cellOf(e.y)) === c);
    return !!b && c !== start;
  };
  while (q.length) {
    const n = q.shift()!;
    if (n.steps > 14) continue;
    const x = n.cell % s.w, y = Math.floor(n.cell / s.w);
    for (let d = 1; d <= 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      const c = cellIndex(s, nx, ny);
      if (seen.has(c) || blocked(c)) continue;
      const t = n.t + per;
      if (dangerAt(f, c, t - per - margin, t + margin)) continue;
      const node = { cell: c, t, first: n.first < 0 ? d : n.first, steps: n.steps + 1 };
      seen.set(c, node);
      out.push(node);
      q.push(node);
    }
  }
  return out;
}

export class BotBrain {
  private rng: Rng;
  private tune: Tuning;
  private wait = 0;
  private target = -1;
  private lastCell = -1;
  private stuck = 0;
  private dropBomb = false;

  constructor(public id: number, public difficulty: Difficulty, seed: number) {
    this.rng = new Rng(seed ^ (id * 2654435761));
    this.tune = TUNING[difficulty];
    this.wait = this.rng.int(this.tune.think);
  }

  /** Called every tick; decides only every `think` ticks and otherwise keeps steering. */
  input(s: GameState): Input {
    const p = s.players[this.id];
    if (!p.alive || s.phase !== "playing") return { dir: Dir.None, bomb: false };
    const here = cellIndex(s, cellOf(p.x), cellOf(p.y));
    const f = forecast(s);
    const inDanger = everDangerous(f, here, 0);
    // danger cuts the reaction delay short: fleeing is a reflex, but slower on easy
    if (--this.wait <= 0 || (inDanger && (this.target < 0 || everDangerous(f, this.target, 0)) && this.wait > 2)) {
      this.wait = this.tune.think;
      this.decide(s, p, f, here);
    }
    const bomb = this.dropBomb;
    this.dropBomb = false;
    return { dir: this.steer(s, p, f), bomb };
  }

  private decide(s: GameState, p: Player, f: Forecast, here: number): void {
    if (here === this.lastCell) this.stuck++; else this.stuck = 0;
    this.lastCell = here;

    const nodes = explore(s, p, f, this.tune.margin);
    const safeNodes = nodes.filter((n) => !everDangerous(f, n.cell, n.t - this.tune.margin));

    // 1. get out of the way of anything about to go off
    if (everDangerous(f, here, 0)) {
      const best = safeNodes.sort((a, b) => a.steps - b.steps)[0];
      this.target = best ? best.cell : -1;
      return;
    }

    // 2. bomb if it hurts something and we can still get away
    if (p.bombsOut < p.bombsMax) {
      const value = this.bombValue(s, p, here);
      if (value > 0 && this.rng.next() < this.tune.bombChance && this.escapeAfterBomb(s, p, here)) {
        this.dropBomb = true;
        const fake = this.virtualBomb(s, p, here);
        const f2 = forecast(s, [fake]);
        const escape = explore(s, p, f2, this.tune.margin, [fake]).filter((n) => !everDangerous(f2, n.cell, n.t - this.tune.margin)).sort((a, b) => a.steps - b.steps)[0];
        this.target = escape ? escape.cell : -1;
        return;
      }
    }

    // 3. pick a goal: power-ups, players, then spots next to crates
    if (this.rng.next() < this.tune.wander || this.stuck > 6) {
      const pick = safeNodes.filter((n) => n.steps > 0);
      this.target = pick.length ? this.rng.pick(pick).cell : -1;
      this.stuck = 0;
      return;
    }
    let best: { score: number; cell: number } = { score: -1e9, cell: -1 };
    for (const n of safeNodes) {
      let score = -n.steps * 2;
      if (s.powerups[n.cell]) score += 40;
      const v = this.bombValue(s, p, n.cell);
      score += v > 0 ? 10 + v * 6 : 0;
      if (this.tune.hunt > 0) {
        const nx = n.cell % s.w, ny = Math.floor(n.cell / s.w);
        for (const o of s.players) {
          if (!o.alive || o.id === p.id) continue;
          const dist = Math.abs(cellOf(o.x) - nx) + Math.abs(cellOf(o.y) - ny);
          score += this.tune.hunt * Math.max(0, 12 - dist * 2);
        }
      }
      if (n.cell === here) score -= 6;
      if (score > best.score) best = { score, cell: n.cell };
    }
    this.target = best.cell;
  }

  /** A bomb we are thinking about placing here (fuse a touch short, to stay on the safe side). */
  private virtualBomb(s: GameState, p: Player, cell: number): Bomb {
    return { id: -1, owner: p.id, x: centre(cell % s.w), y: centre(Math.floor(cell / s.w)), fuse: FUSE_TICKS - 6, range: p.range, passers: [p.id], slide: Dir.None };
  }

  /** How much a bomb at `cell` would achieve: crates destroyed, players threatened. */
  private bombValue(s: GameState, p: Player, cell: number): number {
    const cx = cell % s.w, cy = Math.floor(cell / s.w);
    const { cells } = blastCells(s, cx, cy, p.range);
    let v = 0;
    for (const c of cells) {
      if (s.grid[c] === Cell.Crate) v += 1;
      for (const o of s.players)
        if (o.alive && o.id !== p.id && cellIndex(s, cellOf(o.x), cellOf(o.y)) === c) v += 2 + this.tune.hunt * 3;
    }
    return v;
  }

  private escapeAfterBomb(s: GameState, p: Player, here: number): boolean {
    const fake = this.virtualBomb(s, p, here);
    const f2 = forecast(s, [fake]);
    const nodes = explore(s, p, f2, this.tune.margin, [fake]);
    return nodes.some((n) => n.cell !== here && !everDangerous(f2, n.cell, n.t - this.tune.margin));
  }

  /** Turn the target cell into a direction, following the shortest safe path. */
  private steer(s: GameState, p: Player, f: Forecast): Dir {
    if (this.target < 0) return Dir.None;
    const here = cellIndex(s, cellOf(p.x), cellOf(p.y));
    if (here === this.target) {
      // settle on the centre so the next bomb lands where we planned
      const dx = centre(this.target % s.w) - p.x, dy = centre(Math.floor(this.target / s.w)) - p.y;
      if (Math.abs(dx) > 30) return dx > 0 ? Dir.Right : Dir.Left;
      if (Math.abs(dy) > 30) return dy > 0 ? Dir.Down : Dir.Up;
      return Dir.None;
    }
    const nodes = explore(s, p, f, Math.max(1, this.tune.margin - 3));
    const goal = nodes.find((n) => n.cell === this.target);
    if (!goal) {
      this.wait = 0; // path closed: rethink next tick
      return Dir.None;
    }
    return goal.first as Dir;
  }
}
