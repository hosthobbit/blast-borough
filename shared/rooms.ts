// Private rooms and authoritative matches. Whoever runs this owns the simulation: clients only
// send inputs, which are validated, rate-limited and queued one per tick.
//
// Runs anywhere: in the Node server (connections are WebSockets) and in the room host's browser
// for peer-to-peer play (connections are WebRTC data channels, relayed through a Web Worker).

import { BotBrain, type Difficulty } from "./bot.js";
import { Dir, MAX_PLAYERS, TICK_MS, WINS_TO_TAKE_MATCH } from "./constants.js";
import { CODE_ALPHABET, CODE_LENGTH, type ClientMsg, type LobbyPlayer, type ServerMsg, parseClientMsg, toSnapshot } from "./protocol.js";
import { hashSeed } from "./rng.js";
import { type GameEvent, type GameState, type Input, type MatchScore, createRound, newMatch, recordRound, step } from "./sim.js";

/** A connection to one player: a WebSocket on the server, a data channel in the browser. */
export interface Conn {
  send(text: string): void;
  isOpen(): boolean;
  close(): void;
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}

export interface ServerOptions {
  maxRooms: number;
  /** milliseconds per simulation tick; only tests change this */
  tickMs: number;
  /** ticks between snapshots */
  snapEvery: number;
  log?: (msg: string) => void;
}

const INPUT_QUEUE_MAX = 6;          // ~200 ms of buffered input at most
const RATE_PER_SEC = 50;            // inputs arrive ~30/s; allow some burst
const RATE_BURST = 40;
const ABUSE_LIMIT = 300;            // dropped messages before the connection is closed
const NEXT_ROUND_MS = 1400;

export class Member {
  readonly id = randomHex(6);
  ready = false;
  connected = true;
  queue: Input[] = [];
  lastDir: Dir = Dir.None;
  lastSeq = 0;
  ack = 0;
  tokens = RATE_BURST;
  lastRefill = Date.now();
  dropped = 0;
  constructor(public ws: Conn, public name: string) {}

  /** Token bucket: true if this message may be processed. */
  allow(): boolean {
    const now = Date.now();
    this.tokens = Math.min(RATE_BURST, this.tokens + ((now - this.lastRefill) / 1000) * RATE_PER_SEC);
    this.lastRefill = now;
    if (this.tokens < 1) { this.dropped++; return false; }
    this.tokens--;
    return true;
  }
}

interface MatchSlot { name: string; member: Member | null; brain: BotBrain | null }

class Match {
  state!: GameState;
  score: MatchScore;
  pendingEvents: GameEvent[] = [];
  nextRoundAt = 0;
  over = false;
  constructor(public slots: MatchSlot[], public seedBase: string, public difficulty: Difficulty) {
    this.score = newMatch(slots.length);
    this.newRound();
  }
  newRound() {
    const seed = hashSeed(`${this.seedBase}#${this.score.round}`);
    this.state = createRound({ seed, players: this.slots.length });
    this.slots.forEach((s, i) => {
      if (s.member === null || !s.member.connected) s.brain = new BotBrain(i, this.difficulty, seed);
      if (s.member) { s.member.queue = []; s.member.lastDir = Dir.None; }
    });
    this.nextRoundAt = 0;
  }
}

export class Room {
  members: Member[] = [];
  host: Member | null = null;
  bots = 0;
  difficulty: Difficulty = "normal";
  phase: "lobby" | "match" | "results" = "lobby";
  match: Match | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastTickAt = 0;
  private tickAcc = 0;
  private sinceSnap = 0;
  createdAt = Date.now();

  constructor(public code: string, private opts: ServerOptions, private onEmpty: (r: Room) => void) {}

  get connected() { return this.members.filter((m) => m.connected); }

  send(m: Member, msg: ServerMsg) {
    if (m.connected && m.ws.isOpen()) m.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMsg) {
    const text = JSON.stringify(msg);
    for (const m of this.connected) if (m.ws.isOpen()) m.ws.send(text);
  }

  lobbyMsg(): ServerMsg {
    const players: LobbyPlayer[] = this.members.map((m) => ({ id: m.id, name: m.name, ready: m.ready, host: m === this.host, connected: m.connected }));
    return { t: "lobby", code: this.code, players, bots: this.bots, difficulty: this.difficulty, phase: this.phase, max: MAX_PLAYERS };
  }

  sendLobby() { this.broadcast(this.lobbyMsg()); }

  add(m: Member): string | null {
    if (this.phase === "match") return "That room is in the middle of a match. Try again when it finishes.";
    if (this.connected.length + this.bots >= MAX_PLAYERS) {
      if (this.bots > 0) this.bots--; // a real player takes a bot's place
      else return "That room is full (8 players).";
    }
    this.members = this.members.filter((x) => x.connected);
    this.members.push(m);
    if (!this.host) this.host = m;
    this.send(m, { t: "welcome", code: this.code, you: m.id });
    this.sendLobby();
    return null;
  }

  remove(m: Member, reason: "left" | "disconnected") {
    if (!m.connected) return;
    m.connected = false;
    const slot = this.match?.slots.find((s) => s.member === m);
    if (this.phase === "match" && slot && this.match) {
      // the match carries on: a bot steps in for the missing player
      slot.brain = new BotBrain(this.match.slots.indexOf(slot), this.match.difficulty, this.match.state.seed);
      this.broadcast({ t: "notice", message: `${m.name} ${reason === "left" ? "left" : "lost connection"}: a bot takes over.` });
    } else {
      this.members = this.members.filter((x) => x !== m);
    }
    if (this.host === m) {
      this.host = this.connected[0] ?? null;
      if (this.host) this.broadcast({ t: "notice", message: `${this.host.name} is now the host.` });
    }
    if (this.connected.length === 0) {
      this.stop();
      this.onEmpty(this);
      return;
    }
    this.sendLobby();
  }

  handle(m: Member, msg: ClientMsg) {
    switch (msg.t) {
      case "ready":
        if (this.phase !== "lobby") return;
        m.ready = msg.ready;
        this.sendLobby();
        return;
      case "bots":
        if (m !== this.host) return this.error(m, "not_host", "Only the host can change bots.");
        if (this.phase !== "lobby") return;
        this.bots = Math.max(0, Math.min(msg.count, MAX_PLAYERS - this.connected.length));
        this.difficulty = msg.difficulty;
        this.sendLobby();
        return;
      case "start":
        if (m !== this.host) return this.error(m, "not_host", "Only the host can start the match.");
        if (this.phase === "match") return;
        if (this.phase === "lobby" && this.connected.some((x) => x !== this.host && !x.ready)) return this.error(m, "not_ready", "Everyone needs to be ready first.");
        if (this.connected.length + this.bots < 2) return this.error(m, "too_few", "You need at least two players (add a bot?).");
        this.startMatch();
        return;
      case "lobby":
        if (m !== this.host) return this.error(m, "not_host", "Only the host can do that.");
        if (this.phase !== "results") return;
        this.phase = "lobby";
        this.match = null;
        this.members = this.members.filter((x) => x.connected);
        this.members.forEach((x) => (x.ready = false));
        this.sendLobby();
        return;
      case "input": {
        if (this.phase !== "match" || !this.match) return;
        if (!this.match.slots.some((s) => s.member === m)) return;
        if (msg.seq <= m.lastSeq) return; // stale or replayed
        m.lastSeq = msg.seq;
        m.queue.push({ dir: msg.dir, bomb: msg.bomb });
        if (m.queue.length > INPUT_QUEUE_MAX) {
          // client is running ahead: keep the newest inputs, but don't lose a bomb press
          const dropped = m.queue.shift()!;
          if (dropped.bomb) m.queue[0].bomb = true;
        }
        m.ack = msg.seq - m.queue.length;
        return;
      }
      default:
        return;
    }
  }

  error(m: Member, code: string, message: string) {
    this.send(m, { t: "error", code, message });
  }

  private startMatch() {
    const humans = this.connected;
    const slots: MatchSlot[] = humans.map((member) => ({ name: member.name, member, brain: null }));
    const botNames = ["Pip", "Rook", "Mabel", "Juno", "Ziggy", "Bram", "Nell", "Odie"];
    for (let i = 0; i < this.bots && slots.length < MAX_PLAYERS; i++) slots.push({ name: `${botNames[slots.length]} (bot)`, member: null, brain: null });
    this.match = new Match(slots, `${this.code}-${Date.now()}-${randomHex(4)}`, this.difficulty);
    this.phase = "match";
    for (const member of humans) {
      member.queue = []; member.lastSeq = 0; member.ack = 0;
      const you = slots.findIndex((s) => s.member === member);
      this.send(member, { t: "match", slots: slots.map((s) => ({ name: s.name, bot: s.member === null, id: s.member?.id ?? null })), you });
    }
    this.sendLobby();
    this.sinceSnap = this.opts.snapEvery; // first snapshot right away
    this.snapshot();
    this.run();
  }

  private run() {
    this.stop();
    this.lastTickAt = Date.now();
    this.tickAcc = 0;
    const loop = () => {
      const now = Date.now();
      this.tickAcc += Math.min(500, now - this.lastTickAt);
      this.lastTickAt = now;
      let n = 0;
      while (this.tickAcc >= this.opts.tickMs && n < 40) {
        this.tickAcc -= this.opts.tickMs;
        this.tick();
        n++;
        if (!this.match || this.phase !== "match") return;
      }
      this.timer = setTimeout(loop, Math.max(1, Math.min(8, this.opts.tickMs / 2)));
    };
    this.timer = setTimeout(loop, 1);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private tick() {
    const match = this.match!;
    const s = match.state;
    if (match.nextRoundAt) {
      if (Date.now() >= match.nextRoundAt) {
        match.newRound();
        this.sinceSnap = this.opts.snapEvery;
        this.snapshot();
      }
      return;
    }
    const inputs: Input[] = match.slots.map((slot) => {
      if (slot.brain) return slot.brain.input(s);
      const m = slot.member!;
      const next = m.queue.shift();
      if (next) { m.lastDir = next.dir; return next; }
      return { dir: m.lastDir, bomb: false }; // nothing new: keep going the same way
    });
    for (const slot of match.slots) if (slot.member && !slot.brain) slot.member.ack = slot.member.lastSeq - slot.member.queue.length;
    step(s, inputs);
    match.pendingEvents.push(...s.events);
    this.sinceSnap++;
    if (this.sinceSnap >= this.opts.snapEvery || s.events.some((e) => e.type === "end")) this.snapshot();
    if (s.phase === "ended") {
      recordRound(match.score, s, WINS_TO_TAKE_MATCH);
      this.snapshot();
      if (match.score.winner >= 0) {
        match.over = true;
        this.phase = "results";
        this.broadcast({ t: "over", score: match.score });
        this.sendLobby();
        this.stop();
      } else {
        match.nextRoundAt = Date.now() + NEXT_ROUND_MS * (this.opts.tickMs / TICK_MS);
      }
    }
  }

  private snapshot() {
    const match = this.match!;
    const snap = toSnapshot(match.state);
    const ev = match.pendingEvents;
    match.pendingEvents = [];
    this.sinceSnap = 0;
    for (const slot of match.slots) {
      if (!slot.member || !slot.member.connected) continue;
      this.send(slot.member, { t: "snap", s: snap, ev, ack: slot.member.ack, score: match.score });
    }
  }
}

export class Lobby {
  rooms = new Map<string, Room>();
  constructor(private opts: ServerOptions) {}

  newCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = "";
      const bytes = randomBytes(CODE_LENGTH);
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("no free room codes");
  }

  create(fixedCode?: string): Room | null {
    if (this.rooms.size >= this.opts.maxRooms) return null;
    const code = fixedCode ?? this.newCode();
    const room = new Room(code, this.opts, (r) => { this.rooms.delete(r.code); this.opts.log?.(`room ${r.code} closed`); });
    this.rooms.set(code, room);
    this.opts.log?.(`room ${code} created`);
    return room;
  }

  /** Lobbies nobody has touched for a long time are closed. */
  sweep(maxIdleMs: number) {
    const now = Date.now();
    for (const r of this.rooms.values()) {
      if (r.phase === "lobby" && now - r.createdAt > maxIdleMs) {
        r.broadcast({ t: "error", code: "idle", message: "This room was closed after being idle for a long time." });
        for (const m of r.connected) m.ws.close();
        r.stop();
        this.rooms.delete(r.code);
      }
    }
  }
}

/**
 * Handles one player connection: create/join, rate limits, routing to the room. Shared by the
 * Node server and the browser host. `fixedCode`: the room code is decided elsewhere (P2P).
 */
export function handleConnection(lobby: Lobby, conn: Conn, opts: { fixedCode?: string } = {}) {
  let member: Member | null = null;
  let room: Room | null = null;
  const fail = (code: string, message: string) => conn.send(JSON.stringify({ t: "error", code, message }));
  return {
    message(text: string) {
      if (member && !member.allow()) {
        if (member.dropped > ABUSE_LIMIT) { fail("rate_limit", "Too many messages."); conn.close(); }
        return;
      }
      const msg = parseClientMsg(text);
      if (!msg) { fail("bad_message", "That message wasn't understood."); return; }
      if (msg.t === "ping") { conn.send(JSON.stringify({ t: "pong", time: msg.time })); return; }
      if (msg.t === "create" || msg.t === "join") {
        if (member) { fail("already_in_room", "You're already in a room."); return; }
        if (msg.t === "create") {
          room = opts.fixedCode ? lobby.rooms.get(opts.fixedCode) ?? lobby.create(opts.fixedCode) : lobby.create();
          if (!room) { fail("server_full", "The server is full right now. Try again soon."); return; }
        } else {
          room = lobby.rooms.get(msg.code) ?? null;
          if (!room) { fail("room_not_found", `No room called ${msg.code}. Check the code?`); return; }
        }
        const m = new Member(conn, msg.name);
        const problem = room.add(m);
        if (problem) { fail("cannot_join", problem); room = null; return; }
        member = m;
        return;
      }
      if (!member || !room) { fail("not_in_room", "Create or join a room first."); return; }
      if (msg.t === "leave") { room.remove(member, "left"); room = null; member = null; return; }
      room.handle(member, msg);
    },
    close() {
      if (member && room) room.remove(member, "disconnected");
      member = null;
      room = null;
    },
  };
}

export { ABUSE_LIMIT };
