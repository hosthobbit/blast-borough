// Runs matches entirely in the browser: solo vs bots, local multiplayer, and the daily challenge.
// The simulation advances in fixed ticks; rendering interpolates between them.

import { BotBrain, type Difficulty } from "../../shared/bot.js";
import { COUNTDOWN_TICKS, TICK_MS, WINS_TO_TAKE_MATCH } from "../../shared/constants.js";
import { hashSeed } from "../../shared/rng.js";
import { type GameEvent, type GameState, type Input, type MatchScore, createRound, newMatch, recordRound, step } from "../../shared/sim.js";
import type { InputSource } from "../input.js";
import type { Frame } from "./ArenaScene.js";

export interface Slot {
  kind: "human" | "bot";
  name: string;
  source?: InputSource;
  difficulty?: Difficulty;
  label?: string;           // shown above the player on screen ("YOU", "P1", "P2")
}

export interface MatchHooks {
  onEvents?(events: GameEvent[], s: GameState): void;
  onRoundDecided?(s: GameState): void;
  onMatchOver?(m: MatchScore, s: GameState): void;
  onRoundStart?(s: GameState, m: MatchScore): void;
}

export interface DailyStats { crates: number; kills: number; pickups: number; survivedTicks: number; won: boolean }

export class LocalMatch {
  state!: GameState;
  score: MatchScore;
  paused = false;
  readonly daily: boolean;
  dailyStats: DailyStats = { crates: 0, kills: 0, pickups: 0, survivedTicks: 0, won: false };
  private bots: (BotBrain | null)[] = [];
  private acc = 0;
  private prev = new Map<string, { x: number; y: number }>();
  private decided = false;
  private over = false;
  private nextRoundAt = -1;
  private elapsed = 0;
  /** speed multiplier for automated tests (?fast=N); never set in normal play */
  speed = 1;

  constructor(public slots: Slot[], private seedBase: string, private hooks: MatchHooks, opts: { daily?: boolean } = {}) {
    this.daily = !!opts.daily;
    this.score = newMatch(slots.length);
    this.startRound();
  }

  get local(): Map<number, string> {
    const m = new Map<number, string>();
    this.slots.forEach((s, i) => { if (s.kind === "human" && s.label) m.set(i, s.label); });
    return m;
  }

  private startRound(): void {
    const seed = hashSeed(`${this.seedBase}#${this.score.round}`);
    this.state = createRound({ seed, players: this.slots.length });
    this.bots = this.slots.map((s, i) => (s.kind === "bot" ? new BotBrain(i, s.difficulty ?? "normal", seed) : null));
    this.slots.forEach((s) => s.source?.reset());
    this.prev.clear();
    this.decided = false;
    this.nextRoundAt = -1;
    this.acc = 0;
    this.hooks.onRoundStart?.(this.state, this.score);
  }

  restart(): void {
    this.score = newMatch(this.slots.length);
    this.over = false;
    this.dailyStats = { crates: 0, kills: 0, pickups: 0, survivedTicks: 0, won: false };
    this.startRound();
  }

  /** Advance by real elapsed milliseconds. */
  advance(dtMs: number): void {
    if (this.paused || this.over) return;
    this.elapsed += dtMs;
    if (this.nextRoundAt >= 0 && this.elapsed >= this.nextRoundAt) this.startRound();
    this.acc += Math.min(dtMs, 250) * this.speed;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.tick();
      if (this.over || this.paused) { this.acc = 0; break; }
    }
  }

  private tick(): void {
    const s = this.state;
    if (s.phase === "ended") return;
    this.prev.clear();
    for (const p of s.players) this.prev.set(`p${p.id}`, { x: p.x, y: p.y });
    for (const b of s.bombs) this.prev.set(`b${b.id}`, { x: b.x, y: b.y });
    const inputs: Input[] = this.slots.map((slot, i) => {
      if (slot.kind === "bot") return this.bots[i]!.input(s);
      return slot.source ? slot.source.take() : { dir: 0, bomb: false };
    });
    step(s, inputs);
    if (this.daily) this.trackDaily(s);
    if (s.events.length) this.hooks.onEvents?.(s.events, s);
    if (s.endTick >= 0 && !this.decided) {
      this.decided = true;
      this.hooks.onRoundDecided?.(s);
    }
    if (this.state.phase === "ended") { // step() may have ended it (TS narrowed s.phase above)
      if (this.daily) {
        this.over = true;
        this.hooks.onMatchOver?.(this.score, s);
        return;
      }
      recordRound(this.score, s, WINS_TO_TAKE_MATCH);
      if (this.score.winner >= 0) {
        this.over = true;
        this.hooks.onMatchOver?.(this.score, s);
      } else {
        this.nextRoundAt = this.elapsed + 1400;
      }
    }
  }

  private trackDaily(s: GameState): void {
    const me = s.players[0];
    if (me.alive && s.phase === "playing") this.dailyStats.survivedTicks = s.tick - COUNTDOWN_TICKS;
    for (const e of s.events) {
      if (e.type === "crate" && e.owner === 0) this.dailyStats.crates++;
      if (e.type === "pickup" && e.player === 0) this.dailyStats.pickups++;
    }
    this.dailyStats.kills = me.kills;
    this.dailyStats.won = s.winner === 0;
  }

  frame(): Frame {
    return { state: this.state, prev: this.prev, alpha: Math.min(1, this.acc / TICK_MS), local: this.local };
  }
}

/** Daily challenge score: survive, clear crates, take people out, and win. */
export function dailyScore(d: DailyStats): number {
  const seconds = Math.floor(d.survivedTicks / 30);
  return seconds * 3 + d.crates * 4 + d.pickups * 10 + d.kills * 150 + (d.won ? 500 + Math.max(0, 120 - seconds) * 4 : 0);
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}
