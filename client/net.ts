// Online play. The server is authoritative: we send our inputs, it sends snapshots. To keep
// our own character responsive we predict its movement locally (same movement code as the
// server) and replay unacknowledged inputs whenever a snapshot arrives. Other players are
// shown slightly in the past, interpolated between snapshots, so they move smoothly.

import { Dir, TICK_MS } from "../shared/constants.js";
import { type ClientMsg, type LobbyPlayer, PROTOCOL_VERSION, type ServerMsg, type Snapshot, fromSnapshot } from "../shared/protocol.js";
import { type GameEvent, type GameState, type MatchScore, movePlayer } from "../shared/sim.js";
import type { Frame } from "./game/ArenaScene.js";
import type { InputSource } from "./input.js";

interface Hooks {
  lobby(): void;
  match(): void;
  events(ev: GameEvent[], s: GameState): void;
  decided(s: GameState): void;
  roundStart(): void;
  over(score: MatchScore, s: GameState): void;
  error(message: string): void;
  notice(message: string): void;
}

export class OnlineSession {
  static serverUrl(): string {
    const env = import.meta.env.VITE_SERVER_URL as string | undefined;
    if (env) return env;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.hostname || "localhost"}:8787`;
  }

  private ws: WebSocket;
  private status: "connecting" | "open" | "closed" = "connecting";
  you = "";
  code = "";
  lobbyInfo: Extract<ServerMsg, { t: "lobby" }> | null = null;
  slots: { name: string; bot: boolean; id: string | null }[] = [];
  youSlot = -1;
  score: MatchScore = { wins: [], kills: [], round: 1, winner: -1 };
  private latest: GameState | null = null;
  private previous: Map<string, { x: number; y: number }> = new Map();
  private lastSnapAt = 0;
  private snapGap = TICK_MS * 2;
  private input: InputSource | null = null;
  private seq = 0;
  private pending: { seq: number; dir: Dir }[] = [];
  private predicted: { x: number; y: number; facing: Dir; moving: boolean } | null = null;
  private acc = 0;
  private decidedFor = -1;
  private lastSeed = -1;
  private rtt = 0;
  private pingTimer: number;
  private closedByUs = false;

  constructor(first: { t: "create"; name: string } | { t: "join"; name: string; code: string }, private hooks: Hooks) {
    try {
      this.ws = new WebSocket(OnlineSession.serverUrl());
    } catch {
      this.ws = null as unknown as WebSocket;
      setTimeout(() => hooks.error("That server address isn't valid. Check VITE_SERVER_URL."), 0);
      this.pingTimer = 0;
      return;
    }
    const timeout = window.setTimeout(() => {
      if (this.status === "connecting") { this.closedByUs = true; this.ws.close(); hooks.error("Couldn't reach the game server. Is it running? (see README)"); }
    }, 7000);
    this.ws.onopen = () => {
      clearTimeout(timeout);
      this.status = "open";
      this.send({ ...first, v: PROTOCOL_VERSION } as ClientMsg);
    };
    this.ws.onmessage = (e) => this.onMessage(e.data);
    this.ws.onclose = () => {
      clearTimeout(timeout);
      const was = this.status;
      this.status = "closed";
      if (this.closedByUs) return;
      hooks.error(was === "connecting" ? "Couldn't reach the game server. Is it running? (see README)" : "Lost connection to the server.");
    };
    this.ws.onerror = () => { /* onclose follows with the details */ };
    this.pingTimer = window.setInterval(() => this.send({ t: "ping", time: performance.now() }), 2000);
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  leave(): void {
    this.closedByUs = true;
    this.send({ t: "leave" });
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  isHost(): boolean {
    return !!this.lobbyInfo?.players.find((p: LobbyPlayer) => p.id === this.you)?.host;
  }

  connClass(): string { return this.status === "open" ? (this.rtt > 250 ? "wait" : "ok") : this.status === "connecting" ? "wait" : "bad"; }
  connText(): string {
    if (this.status === "connecting") return "Connecting…";
    if (this.status === "closed") return "Disconnected";
    return this.rtt ? `Connected · ${Math.round(this.rtt)} ms` : "Connected";
  }

  setInput(src: InputSource): void {
    this.input = src;
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let m: ServerMsg;
    try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case "welcome": this.you = m.you; this.code = m.code; break;
      case "lobby": {
        this.lobbyInfo = m;
        if (m.phase === "lobby") this.hooks.lobby();
        break;
      }
      case "match":
        this.slots = m.slots;
        this.youSlot = m.you;
        this.latest = null;
        this.pending = [];
        this.predicted = null;
        this.decidedFor = -1;
        this.lastSeed = -1;
        this.hooks.match();
        break;
      case "snap": this.onSnap(m.s, m.ev, m.ack, m.score); break;
      case "over": this.score = m.score; if (this.latest) this.hooks.over(m.score, this.latest); break;
      case "error": this.hooks.error(m.message); break;
      case "notice": this.hooks.notice(m.message); break;
      case "pong": this.rtt = performance.now() - m.time; break;
    }
  }

  private onSnap(snap: Snapshot, ev: GameEvent[], ack: number, score: MatchScore): void {
    const s = fromSnapshot(snap);
    this.score = score;
    if (s.seed !== this.lastSeed) {
      // a new round
      this.lastSeed = s.seed;
      this.previous.clear();
      this.predicted = null;
      this.pending = [];
      this.hooks.roundStart();
    } else if (this.latest) {
      this.previous = new Map();
      for (const p of this.latest.players) this.previous.set(`p${p.id}`, { x: p.x, y: p.y });
      for (const b of this.latest.bombs) this.previous.set(`b${b.id}`, { x: b.x, y: b.y });
    }
    const now = performance.now();
    if (this.lastSnapAt) this.snapGap = this.snapGap * 0.8 + Math.min(200, now - this.lastSnapAt) * 0.2;
    this.lastSnapAt = now;
    this.latest = s;
    // reconcile our own player: server position + replay of inputs it hasn't seen yet
    this.pending = this.pending.filter((p) => p.seq > ack);
    const me = s.players[this.youSlot];
    if (me && me.alive) {
      const ghost = { ...me };
      for (const p of this.pending) movePlayer(s, ghost, p.dir);
      if (!this.predicted) this.predicted = { x: ghost.x, y: ghost.y, facing: ghost.facing, moving: ghost.moving };
      else {
        // small differences are blended away; big ones snap
        const dx = ghost.x - this.predicted.x, dy = ghost.y - this.predicted.y;
        if (Math.abs(dx) + Math.abs(dy) > 600) { this.predicted.x = ghost.x; this.predicted.y = ghost.y; }
        else { this.predicted.x += dx * 0.5; this.predicted.y += dy * 0.5; }
        this.predicted.facing = ghost.facing;
      }
    }
    if (ev.length) this.hooks.events(ev, s);
    if (s.endTick >= 0 && this.decidedFor !== s.seed) {
      this.decidedFor = s.seed;
      this.hooks.decided(s);
    }
  }

  /** Called every frame: send our input once per simulation tick and advance the prediction. */
  advance(dtMs: number): void {
    this.acc += Math.min(dtMs, 250);
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      if (!this.input || !this.latest) continue;
      const input = this.input.take();
      const seq = ++this.seq;
      this.send({ t: "input", seq, dir: input.dir, bomb: input.bomb });
      const me = this.latest.players[this.youSlot];
      if (this.latest.phase === "playing" && me?.alive && this.predicted) {
        this.pending.push({ seq, dir: input.dir });
        if (this.pending.length > 60) this.pending.shift();
        const ghost = { ...me, x: this.predicted.x, y: this.predicted.y };
        movePlayer(this.latest, ghost, input.dir);
        this.predicted = { x: ghost.x, y: ghost.y, facing: ghost.facing, moving: ghost.moving };
      }
    }
  }

  /** The state to draw: latest snapshot, with our own player at its predicted position. */
  view(): GameState | null {
    if (!this.latest) return null;
    if (!this.predicted) return this.latest;
    const s = { ...this.latest, players: this.latest.players.map((p) => ({ ...p })) };
    const me = s.players[this.youSlot];
    if (me && me.alive) { me.x = this.predicted.x; me.y = this.predicted.y; me.facing = this.predicted.facing; me.moving = this.predicted.moving; }
    return s;
  }

  frame(): Frame | null {
    const s = this.view();
    if (!s) return null;
    const alpha = Math.min(1, (performance.now() - this.lastSnapAt) / Math.max(30, this.snapGap));
    const prev = new Map(this.previous);
    prev.delete(`p${this.youSlot}`); // ours is predicted, not interpolated
    return { state: s, prev, alpha, local: new Map([[this.youSlot, "YOU"]]) };
  }

  debug() {
    return { status: this.status, you: this.you, code: this.code, slot: this.youSlot, tick: this.latest?.tick ?? -1, phase: this.latest?.phase, score: this.score, rtt: this.rtt, pending: this.pending.length };
  }
}
