// Online protocol. Clients only ever send intentions (inputs, ready, chat-free lobby actions);
// the server runs the simulation and sends back snapshots. Everything from a client is
// validated here before the server looks at it.

import { Dir, MAX_PLAYERS } from "./constants.js";
import type { Difficulty } from "./bot.js";
import { type Bomb, type Flame, type GameEvent, type GameState, type MatchScore, type Player, spiralOrder } from "./sim.js";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 1024;
export const CODE_LENGTH = 5;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion

export type ClientMsg =
  | { t: "create"; name: string; v: number }
  | { t: "join"; code: string; name: string; v: number }
  | { t: "ready"; ready: boolean }
  | { t: "bots"; count: number; difficulty: Difficulty }
  | { t: "start" }
  | { t: "lobby" }
  | { t: "input"; seq: number; dir: Dir; bomb: boolean }
  | { t: "leave" }
  | { t: "ping"; time: number };

export interface LobbyPlayer { id: string; name: string; ready: boolean; host: boolean; connected: boolean }

export type ServerMsg =
  | { t: "welcome"; code: string; you: string }
  | { t: "lobby"; code: string; players: LobbyPlayer[]; bots: number; difficulty: Difficulty; phase: "lobby" | "match" | "results"; max: number }
  | { t: "match"; slots: { name: string; bot: boolean; id: string | null }[]; you: number }
  | { t: "snap"; s: Snapshot; ev: GameEvent[]; ack: number; score: MatchScore }
  | { t: "over"; score: MatchScore }
  | { t: "error"; code: string; message: string }
  | { t: "notice"; message: string }
  | { t: "pong"; time: number };

// ---------------------------------------------------------------------------------------------
// validation

export function sanitiseName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return name.length >= 1 ? name : null;
}

export function validCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const DIFFICULTIES = ["easy", "normal", "hard"];

/** Parse and validate one client message. Returns null for anything malformed. */
export function parseClientMsg(text: string): ClientMsg | null {
  if (text.length > MAX_MESSAGE_BYTES) return null;
  let m: Record<string, unknown>;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    m = v;
  } catch {
    return null;
  }
  switch (m.t) {
    case "create": {
      const name = sanitiseName(m.name);
      return name && m.v === PROTOCOL_VERSION ? { t: "create", name, v: PROTOCOL_VERSION } : null;
    }
    case "join": {
      const name = sanitiseName(m.name), code = validCode(m.code);
      return name && code && m.v === PROTOCOL_VERSION ? { t: "join", name, code, v: PROTOCOL_VERSION } : null;
    }
    case "ready": return typeof m.ready === "boolean" ? { t: "ready", ready: m.ready } : null;
    case "bots":
      return isInt(m.count, 0, MAX_PLAYERS - 1) && typeof m.difficulty === "string" && DIFFICULTIES.includes(m.difficulty)
        ? { t: "bots", count: m.count, difficulty: m.difficulty as Difficulty } : null;
    case "start": return { t: "start" };
    case "lobby": return { t: "lobby" };
    case "input":
      return isInt(m.seq, 0, 2 ** 31) && isInt(m.dir, 0, 4) && typeof m.bomb === "boolean" ? { t: "input", seq: m.seq, dir: m.dir as Dir, bomb: m.bomb } : null;
    case "leave": return { t: "leave" };
    case "ping": return typeof m.time === "number" && Number.isFinite(m.time) ? { t: "ping", time: m.time } : null;
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------
// snapshots: what clients may see of the game state. Hidden power-ups are never sent.

export interface Snapshot {
  w: number; h: number; tick: number; phase: GameState["phase"]; seed: number;
  grid: string;                 // one char per cell (Cell value)
  pu: string;                   // one char per cell (power-up kind, 0 none)
  bombs: Bomb[];
  flames: [number, Flame][];
  players: Player[];
  dropIndex: number; endTick: number; winner: number; draw: boolean;
}

export function toSnapshot(s: GameState): Snapshot {
  return {
    w: s.w, h: s.h, tick: s.tick, phase: s.phase, seed: s.seed,
    grid: s.grid.join(""), pu: s.powerups.join(""),
    bombs: s.bombs.map((b) => ({ ...b, passers: [...b.passers] })),
    flames: Object.entries(s.flames).map(([c, f]) => [Number(c), { ...f }]),
    players: s.players.map((p) => ({ ...p })),
    dropIndex: s.dropIndex, endTick: s.endTick, winner: s.winner, draw: s.draw,
  };
}

/** Rebuild a renderable GameState on the client. */
export function fromSnapshot(n: Snapshot): GameState {
  const cells = n.w * n.h;
  return {
    w: n.w, h: n.h, tick: n.tick, phase: n.phase, seed: n.seed,
    grid: n.grid.split("").map(Number), burn: new Array(cells).fill(0), hidden: new Array(cells).fill(0),
    powerups: n.pu.split("").map(Number), bombs: n.bombs, flames: Object.fromEntries(n.flames), players: n.players,
    nextBombId: 0, rngState: 0, dropOrder: spiralOrder(n.w, n.h), dropIndex: n.dropIndex,
    endTick: n.endTick, winner: n.winner, draw: n.draw, events: [],
  };
}
