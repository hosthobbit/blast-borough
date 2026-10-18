import { COUNTDOWN_TICKS, Cell, Dir } from "../shared/constants.js";
import { type GameState, type Input, centre, createRound, step } from "../shared/sim.js";

/**
 * A hand-built arena for rule tests. `rows` uses: '#' wall, 'c' crate, '.' floor, digits = player
 * spawn (also floor). Phase is already "playing".
 */
export function arena(rows: string[]): GameState {
  const players = Math.max(2, ...rows.join("").split("").filter((ch) => /\d/.test(ch)).map((d) => Number(d) + 1));
  const s = createRound({ seed: 1, players: Math.min(8, players) });
  s.w = rows[0].length;
  s.h = rows.length;
  s.grid = [];
  const pos: Record<number, { x: number; y: number }> = {};
  rows.forEach((row, y) =>
    row.split("").forEach((ch, x) => {
      s.grid.push(ch === "#" ? Cell.Wall : ch === "c" ? Cell.Crate : Cell.Floor);
      if (/\d/.test(ch)) pos[Number(ch)] = { x, y };
    }),
  );
  s.burn = s.grid.map(() => 0);
  s.hidden = s.grid.map(() => 0);
  s.powerups = s.grid.map(() => 0);
  s.players = s.players.slice(0, players);
  s.players.forEach((p) => {
    const at = pos[p.id];
    if (at) { p.x = centre(at.x); p.y = centre(at.y); } else { p.alive = false; }
  });
  s.dropOrder = [];
  s.tick = COUNTDOWN_TICKS;
  s.phase = "playing";
  return s;
}

export const idle = (n: number): Input[] => Array.from({ length: n }, () => ({ dir: Dir.None, bomb: false }));

export function run(s: GameState, ticks: number, inputs?: (t: number) => Input[]): void {
  for (let i = 0; i < ticks; i++) step(s, inputs ? inputs(i) : idle(s.players.length));
}

export const cell = (s: GameState, x: number, y: number) => y * s.w + x;
