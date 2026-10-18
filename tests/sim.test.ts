import { describe, expect, it } from "vitest";
import {
  COUNTDOWN_TICKS, Cell, CRATE_BURN_TICKS, Dir, FLAME_TICKS, FUSE_TICKS, MAX_BOMBS, MAX_RANGE, MAX_SPEED_UPS, PowerUp,
  ROUND_TICKS, SUB, SUDDEN_DEATH_AT,
} from "../shared/constants.js";
import { generateMap, safeZone, spawnPoints } from "../shared/map.js";
import { blastCells, cellOf, centre, createRound, newMatch, recordRound, step, type Input } from "../shared/sim.js";
import { arena, cell, idle, run } from "./helpers.js";

const press = (n: number, who: number, input: Partial<Input>) => (t: number) =>
  idle(n).map((x, i) => (i === who && t === 0 ? { ...x, ...input } : x));

describe("blasts", () => {
  it("travel in four directions, stop at walls and are absorbed by crates", () => {
    const s = arena([
      "#########",
      "#.......#",
      "#.#.#c..#",
      "#...0...#",
      "#.#...#.#",
      "#...1...#",
      "#########",
    ]);
    const { cells } = blastCells(s, 4, 3, 3);
    // up: (4,2) is a wall at 4? row 2 is "#.#.#c..#": x=4 is '#': stops at once
    expect(cells).not.toContain(cell(s, 4, 2));
    // left reaches (1,3); right reaches (7,3)
    expect(cells).toContain(cell(s, 1, 3));
    expect(cells).toContain(cell(s, 7, 3));
    // down passes (4,4) and (4,5), (4,6) is the outer wall
    expect(cells).toContain(cell(s, 4, 5));
    expect(cells).not.toContain(cell(s, 4, 6));

    const t = arena(["#######", "#0.c..#", "#.....#", "#....1#", "#######"]);
    const r = blastCells(t, 1, 1, 5).cells;
    expect(r).toContain(cell(t, 3, 1));        // the crate takes the hit...
    expect(r).not.toContain(cell(t, 4, 1));    // ...and stops the blast
  });

  it("destroy a crate, which burns for a moment and may reveal a power-up", () => {
    const s = arena(["#######", "#0.c..#", "#.....#", "#....1#", "#######"]);
    s.hidden[cell(s, 3, 1)] = PowerUp.FireUp;
    run(s, 1, press(2, 0, { bomb: true }));
    s.players[0].x = centre(5); s.players[0].y = centre(3); // well out of range
    run(s, FUSE_TICKS + 2);
    expect(s.players[0].alive).toBe(true);
    expect(s.grid[cell(s, 3, 1)]).toBe(Cell.Burning);
    expect(s.powerups[cell(s, 3, 1)]).toBe(0);
    run(s, CRATE_BURN_TICKS + 1);
    expect(s.grid[cell(s, 3, 1)]).toBe(Cell.Floor);
    expect(s.powerups[cell(s, 3, 1)]).toBe(PowerUp.FireUp);
  });

  it("set off bombs they reach: chain reactions go off on the same tick", () => {
    const s = arena(["#########", "#0......#", "#.......#", "#.......#", "#......1#", "#########"]);
    // bomb A at (1,1) placed first, bomb B at (3,1) placed 20 ticks later
    run(s, 1, press(2, 0, { bomb: true }));
    s.players[0].bombsMax = 2;
    s.players[0].x = centre(3);
    run(s, 20);
    run(s, 1, press(2, 0, { bomb: true }));
    s.players[0].x = centre(6); s.players[0].y = centre(4); // safely out of the way
    const fuseB = s.bombs[1].fuse;
    let exploded: number[] = [];
    for (let i = 0; i < FUSE_TICKS && s.bombs.length; i++) {
      step(s, idle(2));
      for (const e of s.events) if (e.type === "explode") exploded.push(s.tick);
    }
    expect(exploded.length).toBe(2);
    expect(exploded[0]).toBe(exploded[1]);    // B went off with A, not when its own fuse ran out
    expect(fuseB).toBeGreaterThan(15);
  });

  it("leave flames for a short, fixed time", () => {
    const s = arena(["#######", "#0....#", "#.....#", "#....1#", "#######"]);
    run(s, 1, press(2, 0, { bomb: true }));
    s.players[0].x = centre(4); s.players[0].y = centre(3);
    run(s, FUSE_TICKS - 1);
    expect(Object.keys(s.flames).length).toBeGreaterThan(0);
    run(s, FLAME_TICKS);
    expect(Object.keys(s.flames).length).toBe(0);
  });
});

describe("bombs and movement", () => {
  it("occupy their cell: you can walk off your own bomb but not back onto it", () => {
    const s = arena(["#######", "#0....#", "#.....#", "#....1#", "#######"]);
    run(s, 1, press(2, 0, { bomb: true }));
    const right = () => [{ dir: Dir.Right, bomb: false }, { dir: Dir.None, bomb: false }];
    const left = () => [{ dir: Dir.Left, bomb: false }, { dir: Dir.None, bomb: false }];
    run(s, 10, right);                                  // 10 ticks at 3 tiles/s: one tile
    expect(cellOf(s.players[0].x)).toBe(2);
    run(s, 20, left);
    expect(cellOf(s.players[0].x)).toBe(2);           // blocked by the bomb
    expect(s.players[0].x).toBeGreaterThanOrEqual(centre(2) - SUB * 0.2);
  });

  it("block other players from the start", () => {
    const s = arena(["#######", "#0.1..#", "#.....#", "#.....#", "#######"]);
    run(s, 1, press(2, 0, { bomb: true }));
    s.players[0].y = centre(3);                         // owner steps away
    run(s, 30, () => [{ dir: Dir.None, bomb: false }, { dir: Dir.Left, bomb: false }]);
    expect(cellOf(s.players[1].x)).toBe(2);            // stopped in front of the bomb at (1,1)
  });

  it("can't be placed twice on one cell, and respect the carry limit", () => {
    const s = arena(["#######", "#0....#", "#.....#", "#....1#", "#######"]);
    s.players[0].bombsMax = 3;
    run(s, 1, press(2, 0, { bomb: true }));
    run(s, 1, press(2, 0, { bomb: true }));
    expect(s.bombs.length).toBe(1);
    s.players[0].bombsMax = 1;
    s.players[0].x = centre(3);
    run(s, 1, press(2, 0, { bomb: true }));
    expect(s.bombs.length).toBe(1);
  });

  it("help round corners when slightly off the lane", () => {
    const s = arena(["#######", "#0....#", "#.#.#.#", "#....1#", "#######"]);
    s.players[0].x = centre(1) + 350; // a bit past the corner
    run(s, 10, () => [{ dir: Dir.Down, bomb: false }, { dir: Dir.None, bomb: false }]);
    // (2,2) is a wall, so the player is guided back onto column 1 and goes down
    expect(cellOf(s.players[0].y)).toBeGreaterThan(1);
    expect(cellOf(s.players[0].x)).toBe(1);
  });

  it("kicked bombs slide until something stops them", () => {
    const s = arena(["#########", "#0......#", "#.......#", "#......1#", "#########"]);
    s.players[0].kick = true;
    s.bombs.push({ id: 99, owner: 1, x: centre(2), y: centre(1), fuse: 200, range: 1, passers: [], slide: Dir.None });
    s.players[1].bombsOut = 1;
    run(s, 6, () => [{ dir: Dir.Right, bomb: false }, { dir: Dir.None, bomb: false }]);
    run(s, 40);
    expect(cellOf(s.bombs[0].x)).toBe(7);          // stopped by the wall at x=8
    expect(s.bombs[0].x).toBe(centre(7));
  });

  it("without kick boots, walking into a bomb does nothing", () => {
    const s = arena(["#########", "#0......#", "#.......#", "#......1#", "#########"]);
    s.bombs.push({ id: 99, owner: 1, x: centre(2), y: centre(1), fuse: 200, range: 1, passers: [], slide: Dir.None });
    run(s, 20, () => [{ dir: Dir.Right, bomb: false }, { dir: Dir.None, bomb: false }]);
    expect(s.bombs[0].x).toBe(centre(2));
    expect(s.players[0].x).toBe(centre(1));
  });
});

describe("power-ups", () => {
  it("are capped", () => {
    const s = arena(["#########", "#0......#", "#.......#", "#......1#", "#########"]);
    const p = s.players[0];
    const kinds = [PowerUp.BombUp, PowerUp.FireUp, PowerUp.SpeedUp];
    for (let i = 0; i < 12; i++)
      for (const k of kinds) {
        s.powerups[cell(s, 1, 1)] = k;
        run(s, 1);
      }
    expect(p.bombsMax).toBe(MAX_BOMBS);
    expect(p.range).toBe(MAX_RANGE);
    expect(p.speedUps).toBe(MAX_SPEED_UPS);
  });

  it("are destroyed by blasts", () => {
    const s = arena(["#######", "#0....#", "#.....#", "#....1#", "#######"]);
    s.powerups[cell(s, 3, 1)] = PowerUp.BombUp;
    run(s, 1, press(2, 0, { bomb: true }));
    s.players[0].x = centre(4); s.players[0].y = centre(3);
    run(s, FUSE_TICKS);
    expect(s.powerups[cell(s, 3, 1)]).toBe(0);
  });
});

describe("round results", () => {
  it("last player standing wins", () => {
    const s = arena(["#######", "#0.1..#", "#.....#", "#.....#", "#######"]);
    run(s, 1, press(2, 0, { bomb: true }));
    s.players[0].x = centre(5); s.players[0].y = centre(3);
    run(s, FUSE_TICKS + 2);
    expect(s.players[1].alive).toBe(false);
    expect(s.winner).toBe(0);
    expect(s.draw).toBe(false);
  });

  it("simultaneous eliminations are a draw", () => {
    const s = arena(["#######", "#0.1..#", "#.....#", "#.....#", "#######"]);
    run(s, 1, press(2, 0, { bomb: true }));
    run(s, FUSE_TICKS + 2);
    expect(s.players[0].alive).toBe(false);
    expect(s.players[1].alive).toBe(false);
    expect(s.draw).toBe(true);
    expect(s.winner).toBe(-1);
  });

  it("first to three takes the match", () => {
    const m = newMatch(2);
    const s = arena(["#####", "#0.1#", "#####"]);
    s.winner = 1; s.draw = false;
    recordRound(m, s, 3); recordRound(m, s, 3);
    expect(m.winner).toBe(-1);
    recordRound(m, s, 3);
    expect(m.winner).toBe(1);
    expect(m.wins).toEqual([0, 3]);
    s.players[1].kills = 2;
    const m2 = newMatch(2);
    recordRound(m2, s, 3); recordRound(m2, s, 3);
    expect(m2.kills).toEqual([0, 4]); // knockouts add up over the match
  });
});

describe("sudden death", () => {
  it("closes the arena from the outside and ends the round by about two minutes", () => {
    const s = createRound({ seed: 42, players: 4 });
    const out: string[] = [];
    let sdTick = -1, firstDrop = -1;
    while (s.phase !== "ended" && s.tick < COUNTDOWN_TICKS + ROUND_TICKS + 300) {
      step(s, idle(4));
      for (const e of s.events) {
        if (e.type === "suddenDeath") sdTick = s.tick;
        if (e.type === "drop" && firstDrop < 0) { firstDrop = s.tick; out.push(`${e.cell}`); }
      }
    }
    expect(sdTick).toBe(COUNTDOWN_TICKS + SUDDEN_DEATH_AT);
    // the first block falls on the outer ring (top-left corner, inside the border)
    expect(Number(out[0])).toBe(s.w + 1);
    // nobody moved, so the walls got them one by one (or together: a draw) before ~2:00
    expect(s.endTick).toBeGreaterThan(0);
    expect(s.endTick - COUNTDOWN_TICKS).toBeLessThanOrEqual(ROUND_TICKS + 30);
    expect(s.players.filter((p) => p.alive).length).toBeLessThanOrEqual(1);
    expect(s.draw || s.winner >= 0).toBe(true);
  });
});

describe("arena generation", () => {
  it("is reproducible from the seed", () => {
    expect(generateMap(7, 4)).toEqual(generateMap(7, 4));
    expect(generateMap(7, 4).grid).not.toEqual(generateMap(8, 4).grid);
  });

  it("gives every spawn a clear opening and crates nearby", () => {
    for (let seed = 1; seed <= 200; seed++)
      for (const players of [2, 4, 8]) {
        const m = generateMap(seed, players);
        const points = spawnPoints(m.w, m.h).slice(0, players);
        points.forEach((sp, i) => {
          expect(m.spawns[i]).toEqual({ x: sp.x, y: sp.y });
          for (const c of safeZone(sp, m.w, m.h)) expect(m.grid[c.y * m.w + c.x]).toBe(Cell.Floor);
          let crates = 0;
          for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++)
            if (m.grid[y * m.w + x] === Cell.Crate && Math.abs(x - sp.x) + Math.abs(y - sp.y) <= 3) crates++;
          expect(crates).toBeGreaterThanOrEqual(3);
        });
      }
  });

  it("lets every player drop a first bomb and survive by stepping round a corner", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const s = createRound({ seed, players: 4 });
      run(s, COUNTDOWN_TICKS);
      for (const p of s.players) {
        const sp = spawnPoints(s.w, s.h)[p.id];
        // drop a bomb one step along the first arm, then go back and round the corner
        const plan: Dir[] = [];
        const along = sp.ax > 0 ? Dir.Right : Dir.Left;
        const back = sp.ax > 0 ? Dir.Left : Dir.Right;
        const down = sp.ay > 0 ? Dir.Down : Dir.Up;
        for (let i = 0; i < 12; i++) plan.push(along);
        const test = structuredClone(s);
        const q = test.players[p.id];
        for (const o of test.players) if (o !== q) { o.x = q.x; o.y = q.y; o.alive = o.id !== q.id && false; }
        q.alive = true;
        test.players.forEach((o) => { if (o !== q) o.alive = false; });
        test.endTick = 0; // keep running with one player
        for (const d of plan) step(test, test.players.map((o) => (o === q ? { dir: d, bomb: false } : { dir: Dir.None, bomb: false })));
        step(test, test.players.map((o) => (o === q ? { dir: Dir.None, bomb: true } : { dir: Dir.None, bomb: false })));
        for (let i = 0; i < 14; i++) step(test, test.players.map((o) => (o === q ? { dir: back, bomb: false } : { dir: Dir.None, bomb: false })));
        for (let i = 0; i < 40; i++) step(test, test.players.map((o) => (o === q ? { dir: down, bomb: false } : { dir: Dir.None, bomb: false })));
        for (let i = 0; i < FUSE_TICKS; i++) step(test, test.players.map(() => ({ dir: Dir.None, bomb: false })));
        expect(q.alive, `seed ${seed} player ${p.id}`).toBe(true);
      }
    }
  });
});
