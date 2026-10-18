// Arena generation: classic pillar grid, seeded crates, hidden power-ups, fair spawns.

import { CRATE_DENSITY, Cell, POWERUP_CHANCE, PowerUp } from "./constants.js";
import { Rng } from "./rng.js";

export interface MapLayout {
  w: number;
  h: number;
  grid: Cell[];
  hidden: number[];
  spawns: { x: number; y: number }[];
}

/** 15x13 for up to four players, 19x13 for five to eight (room for edge spawns). */
export function mapSize(players: number): { w: number; h: number } {
  return players <= 4 ? { w: 15, h: 13 } : { w: 19, h: 13 };
}

/** Spawn cells, most-spread first: four corners, then the middle of each edge. */
export function spawnPoints(w: number, h: number): { x: number; y: number; ax: number; ay: number }[] {
  // ax/ay: the two directions the spawn's clear "L" opens towards
  const midX = Math.floor(w / 2) % 2 === 1 ? Math.floor(w / 2) : Math.floor(w / 2) + 1;
  const midY = Math.floor(h / 2) % 2 === 1 ? Math.floor(h / 2) : Math.floor(h / 2) + 1;
  return [
    { x: 1, y: 1, ax: 1, ay: 1 },
    { x: w - 2, y: h - 2, ax: -1, ay: -1 },
    { x: w - 2, y: 1, ax: -1, ay: 1 },
    { x: 1, y: h - 2, ax: 1, ay: -1 },
    { x: midX, y: 1, ax: 1, ay: 1 },
    { x: midX, y: h - 2, ax: -1, ay: -1 },
    { x: 1, y: midY, ax: 1, ay: 1 },
    { x: w - 2, y: midY, ax: -1, ay: -1 },
  ];
}

export function isPillar(x: number, y: number, w: number, h: number): boolean {
  if (x === 0 || y === 0 || x === w - 1 || y === h - 1) return true;
  return x % 2 === 0 && y % 2 === 0;
}

/**
 * Cells kept clear around a spawn: the spawn plus two cells along each of its two open
 * directions. That always leaves a corner to duck round after dropping a first bomb.
 */
export function safeZone(sp: { x: number; y: number; ax: number; ay: number }, w: number, h: number): { x: number; y: number }[] {
  const out = [{ x: sp.x, y: sp.y }];
  for (let i = 1; i <= 2; i++) {
    out.push({ x: sp.x + sp.ax * i, y: sp.y });
    out.push({ x: sp.x, y: sp.y + sp.ay * i });
  }
  return out.filter((c) => !isPillar(c.x, c.y, w, h));
}

export function generateMap(seed: number, players: number): MapLayout {
  const { w, h } = mapSize(players);
  const rng = new Rng(seed);
  const grid: Cell[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid.push(isPillar(x, y, w, h) ? Cell.Wall : Cell.Floor);

  const spawns = spawnPoints(w, h).slice(0, players);
  const keepClear = new Set<number>();
  for (const sp of spawns) for (const c of safeZone(sp, w, h)) keepClear.add(c.y * w + c.x);

  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== Cell.Floor || keepClear.has(i)) continue;
    if (rng.next() < CRATE_DENSITY) grid[i] = Cell.Crate;
  }

  // every spawn gets crates within reach of its first bombs: at least three within 3 steps
  for (const sp of spawns) {
    const near: number[] = [];
    let crates = 0;
    for (let y = sp.y - 3; y <= sp.y + 3; y++)
      for (let x = sp.x - 3; x <= sp.x + 3; x++) {
        if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) continue;
        if (Math.abs(x - sp.x) + Math.abs(y - sp.y) > 3) continue;
        const i = y * w + x;
        if (grid[i] === Cell.Crate) crates++;
        else if (grid[i] === Cell.Floor && !keepClear.has(i)) near.push(i);
      }
    rng.shuffle(near);
    while (crates < 3 && near.length) { grid[near.pop()!] = Cell.Crate; crates++; }
  }

  // power-ups hide under a share of the crates; roughly balanced so nobody gets a dead map
  const hidden = grid.map(() => 0);
  const crateCells = grid.map((g, i) => (g === Cell.Crate ? i : -1)).filter((i) => i >= 0);
  rng.shuffle(crateCells);
  const count = Math.round(crateCells.length * POWERUP_CHANCE);
  const bag: PowerUp[] = [];
  for (let i = 0; i < count; i++) {
    const r = i % 10;
    bag.push(r < 4 ? PowerUp.BombUp : r < 8 ? PowerUp.FireUp : r < 9 ? PowerUp.SpeedUp : PowerUp.Kick);
  }
  rng.shuffle(bag);
  for (let i = 0; i < count; i++) hidden[crateCells[i]] = bag[i];

  return { w, h, grid, hidden, spawns: spawns.map(({ x, y }) => ({ x, y })) };
}
