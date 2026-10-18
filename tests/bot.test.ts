import { describe, expect, it } from "vitest";
import { COUNTDOWN_TICKS, Dir, FLAME_TICKS } from "../shared/constants.js";
import { BotBrain, type Difficulty, detonationTimes, forecast } from "../shared/bot.js";
import { centre, createRound, step } from "../shared/sim.js";
import { arena, cell, idle } from "./helpers.js";

describe("bot forecast", () => {
  it("includes chain reactions in blast timing", () => {
    const s = arena(["#########", "#0......#", "#.......#", "#......1#", "#########"]);
    s.bombs.push({ id: 1, owner: 1, x: centre(2), y: centre(1), fuse: 10, range: 2, passers: [], slide: Dir.None });
    s.bombs.push({ id: 2, owner: 1, x: centre(4), y: centre(1), fuse: 60, range: 3, passers: [], slide: Dir.None });
    const det = detonationTimes(s);
    expect(det.get(s.bombs[1])).toBe(10); // set off by the first bomb
    const f = forecast(s);
    // (7,1) is only reached by the second bomb, but at the first bomb's time
    expect(f.get(cell(s, 7, 1))).toEqual([[10, 10 + FLAME_TICKS]]);
  });
});

describe("bot decisions", () => {
  it("steps out of a blast before it goes off", () => {
    const s = arena(["#########", "#0......#", "#.#.#.#.#", "#......1#", "#########"]);
    // a bomb two cells to the bot's right, about to blow, its blast covers the bot's cell
    s.bombs.push({ id: 1, owner: 1, x: centre(3), y: centre(1), fuse: 30, range: 3, passers: [], slide: Dir.None });
    const bot = new BotBrain(0, "normal", 5);
    for (let i = 0; i < 40; i++) step(s, [bot.input(s), { dir: Dir.None, bomb: false }]);
    expect(s.players[0].alive).toBe(true);
  });

  it("never bombs itself into a dead end", () => {
    // corridor with no side exits: a bomb here would leave no safe cell in reach
    const s = arena(["#######", "#0c####", "#######", "#....1#", "#######"]);
    for (const level of ["easy", "normal", "hard"] as Difficulty[]) {
      const t = structuredClone(s);
      const bot = new BotBrain(0, level, 3);
      for (let i = 0; i < 90; i++) {
        const input = bot.input(t);
        expect(input.bomb).toBe(false);
        step(t, [input, { dir: Dir.None, bomb: false }]);
      }
    }
  });

  it("bombs a crate when it has an escape, and survives it", () => {
    const s = arena(["#######", "#0c...#", "#.#.#.#", "#.....#", "#....1#", "#######"]);
    const bot = new BotBrain(0, "hard", 9);
    let placed = false;
    for (let i = 0; i < 150; i++) {
      const input = bot.input(s);
      placed ||= input.bomb;
      step(s, [input, { dir: Dir.None, bomb: false }]);
    }
    expect(placed).toBe(true);
    expect(s.players[0].alive).toBe(true);
    expect(s.grid[cell(s, 2, 1)]).not.toBe(2); // the crate is gone
  });
});

describe("bot matches", () => {
  function playMatch(seed: number, level: Difficulty) {
    const s = createRound({ seed, players: 4 });
    const bots = s.players.map((p) => new BotBrain(p.id, level, seed));
    const deaths: { id: number; self: boolean; at: number }[] = [];
    let bombs = 0, crates = 0;
    while (s.phase !== "ended") {
      step(s, bots.map((b) => b.input(s)));
      for (const e of s.events) {
        if (e.type === "death") deaths.push({ id: e.player, self: e.killer === e.player, at: s.tick - COUNTDOWN_TICKS });
        if (e.type === "bomb") bombs++;
        if (e.type === "crate") crates++;
      }
    }
    return { s, deaths, bombs, crates };
  }

  it("play full rounds: bombing crates, not blowing themselves up straight away", () => {
    const results = [];
    for (let seed = 1; seed <= 12; seed++) results.push(playMatch(seed, "normal"));
    const early = results.flatMap((r) => r.deaths.filter((d) => d.self && d.at < 20 * 30));
    const crates = results.reduce((a, r) => a + r.crates, 0) / results.length;
    // stats for the log, so tuning is visible
    console.log("normal bots:", { avgCrates: crates, earlySelfKills: early.length, avgBombs: results.reduce((a, r) => a + r.bombs, 0) / results.length });
    expect(crates).toBeGreaterThan(15);
    expect(early.length).toBeLessThanOrEqual(3); // across 48 bot-rounds
    for (const r of results) expect(r.s.phase).toBe("ended");
  });

  it("are deterministic for a given seed", () => {
    const a = playMatch(77, "hard"), b = playMatch(77, "hard");
    expect(a.deaths).toEqual(b.deaths);
    expect(a.s.tick).toBe(b.s.tick);
  });

  it("idle tick inputs don't break anything", () => {
    const s = createRound({ seed: 3, players: 2 });
    for (let i = 0; i < 200; i++) step(s, idle(2));
    expect(s.phase).toBe("playing");
  });
});
