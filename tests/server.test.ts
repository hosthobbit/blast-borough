import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, parseClientMsg, type ServerMsg } from "../shared/protocol.js";
import { type RunningServer, startServer } from "../server/index.js";

let server: RunningServer;

beforeAll(async () => {
  // a fast clock: whole matches finish in a few seconds
  server = await startServer({ port: 0, tickMs: 0.4, snapEvery: 2 });
});
afterAll(async () => { await server.close(); });

class Client {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  open: Promise<void>;
  closed = false;
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    this.ws.on("message", (d) => this.msgs.push(JSON.parse(d.toString())));
    this.ws.on("close", () => { this.closed = true; });
    this.open = new Promise((r) => this.ws.on("open", () => r()));
  }
  send(m: object) { this.ws.send(JSON.stringify(m)); }
  raw(text: string) { this.ws.send(text); }
  async wait<T extends ServerMsg["t"]>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 20000): Promise<Extract<ServerMsg, { t: T }>> {
    const start = Date.now();
    let seen = 0;
    while (Date.now() - start < ms) {
      for (; seen < this.msgs.length; seen++) {
        const m = this.msgs[seen];
        if (m.t === t && pred(m as Extract<ServerMsg, { t: T }>)) { this.msgs.splice(0, seen + 1); return m as Extract<ServerMsg, { t: T }>; }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${t}`);
  }
  close() { this.ws.close(); }
}

async function room(): Promise<{ host: Client; guest: Client; code: string }> {
  const host = new Client();
  await host.open;
  host.send({ t: "create", name: "Host", v: PROTOCOL_VERSION });
  const { code } = await host.wait("welcome");
  const guest = new Client();
  await guest.open;
  guest.send({ t: "join", code, name: "Guest", v: PROTOCOL_VERSION });
  await guest.wait("welcome");
  await host.wait("lobby", (m) => m.players.length === 2);
  return { host, guest, code };
}

describe("message validation", () => {
  it("rejects malformed and out-of-range messages", () => {
    expect(parseClientMsg("not json")).toBeNull();
    expect(parseClientMsg("[]")).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "input", seq: 1, dir: 9, bomb: false }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "input", seq: -1, dir: 1, bomb: false }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "input", seq: 1, dir: 1, bomb: "yes" }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "join", code: "ab", name: "x", v: PROTOCOL_VERSION }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "create", name: "   ", v: PROTOCOL_VERSION }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "bots", count: 12, difficulty: "normal" }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "bots", count: 2, difficulty: "impossible" }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "teleport", x: 3 }))).toBeNull();
    expect(parseClientMsg("x".repeat(5000))).toBeNull();
    const ok = parseClientMsg(JSON.stringify({ t: "create", name: " <b>Sam</b>\u0007 ", v: PROTOCOL_VERSION }));
    expect(ok).toEqual({ t: "create", name: "bSam/b", v: PROTOCOL_VERSION });
  });
});

describe("rooms", () => {
  it("plays a full online match: two clients plus bots, first to three", async () => {
    const { host, guest } = await room();
    host.send({ t: "bots", count: 2, difficulty: "hard" });
    await guest.wait("lobby", (m) => m.bots === 2);
    host.send({ t: "start" });
    const err = await host.wait("error");
    expect(err.code).toBe("not_ready"); // the guest isn't ready yet
    guest.send({ t: "ready", ready: true });
    await host.wait("lobby", (m) => m.players.every((p) => p.host || p.ready));
    host.send({ t: "start" });
    const hm = await host.wait("match");
    const gm = await guest.wait("match");
    expect(hm.slots).toHaveLength(4);
    expect(hm.you).not.toBe(gm.you);
    // both humans just walk about (at a real client's 30 inputs/s); the bots fight it out
    let seq = 0;
    const timer = setInterval(() => {
      seq++;
      host.send({ t: "input", seq, dir: (seq >> 4) % 5, bomb: false });
      guest.send({ t: "input", seq, dir: ((seq >> 4) + 2) % 5, bomb: false });
    }, 33);
    const over = await host.wait("over", () => true, 60000);
    clearInterval(timer);
    const overG = await guest.wait("over");
    expect(over.score.winner).toBeGreaterThanOrEqual(0);
    expect(Math.max(...over.score.wins)).toBe(3);
    expect(overG.score).toEqual(over.score);
    // rematch resets the score
    host.send({ t: "start" });
    await host.wait("match");
    const snap = await host.wait("snap");
    expect(snap.score.wins.every((w) => w === 0)).toBe(true);
    host.close(); guest.close();
  }, 90000);

  it("never sends hidden power-ups to clients", async () => {
    const { host, guest } = await room();
    guest.send({ t: "ready", ready: true });
    host.send({ t: "start" });
    const snap = await host.wait("snap");
    expect(JSON.stringify(snap)).not.toContain("hidden");
    host.close(); guest.close();
  });

  it("rejects invalid actions", async () => {
    const { host, guest, code } = await room();
    guest.send({ t: "start" });
    expect((await guest.wait("error")).code).toBe("not_host");
    guest.send({ t: "bots", count: 3, difficulty: "easy" });
    expect((await guest.wait("error")).code).toBe("not_host");
    guest.raw("{nonsense");
    expect((await guest.wait("error")).code).toBe("bad_message");
    // inputs before a match are ignored without fuss
    guest.send({ t: "input", seq: 1, dir: 1, bomb: true });
    const stranger = new Client();
    await stranger.open;
    stranger.send({ t: "join", code: "ZZZZZ", name: "Nope", v: PROTOCOL_VERSION });
    expect((await stranger.wait("error")).code).toBe("room_not_found");
    stranger.send({ t: "ready", ready: true });
    expect((await stranger.wait("error")).code).toBe("not_in_room");
    // can't join a room mid-match
    guest.send({ t: "ready", ready: true });
    host.send({ t: "start" });
    await host.wait("match");
    stranger.send({ t: "join", code, name: "Late", v: PROTOCOL_VERSION });
    expect((await stranger.wait("error")).code).toBe("cannot_join");
    // replayed input sequence numbers are ignored (no crash, no effect)
    host.send({ t: "input", seq: 5, dir: 2, bomb: false });
    host.send({ t: "input", seq: 5, dir: 2, bomb: true });
    host.send({ t: "input", seq: 3, dir: 2, bomb: true });
    await host.wait("snap");
    host.close(); guest.close(); stranger.close();
  });

  it("hands over the host and replaces leavers with bots", async () => {
    const { host, guest } = await room();
    host.close();
    const l = await guest.wait("lobby", (m) => m.players.length === 1);
    expect(l.players[0].host).toBe(true);
    // new host starts with a bot; a third player joins first and then drops mid-match
    const third = new Client();
    await third.open;
    third.send({ t: "join", code: l.code, name: "Third", v: PROTOCOL_VERSION });
    await third.wait("welcome");
    third.send({ t: "ready", ready: true });
    await guest.wait("lobby", (m) => m.players.length === 2 && m.players.every((p) => p.host || p.ready));
    guest.send({ t: "start" });
    await guest.wait("match");
    await guest.wait("snap");
    third.close();
    const notice = await guest.wait("notice");
    expect(notice.message).toMatch(/bot takes over/);
    const over = await guest.wait("over", () => true, 60000);
    expect(over.score.winner).toBeGreaterThanOrEqual(0);
    guest.close();
  }, 90000);

  it("closes empty rooms", async () => {
    const c = new Client();
    await c.open;
    c.send({ t: "create", name: "Solo", v: PROTOCOL_VERSION });
    const { code } = await c.wait("welcome");
    expect(server.lobby.rooms.has(code)).toBe(true);
    c.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(server.lobby.rooms.has(code)).toBe(false);
  });

  it("rate-limits floods and caps message size", async () => {
    const { host, guest } = await room();
    for (let i = 0; i < 600; i++) guest.send({ t: "ready", ready: i % 2 === 0 });
    await new Promise((r) => setTimeout(r, 300));
    expect(guest.closed).toBe(true);
    host.raw(JSON.stringify({ t: "ping", time: 1, pad: "x".repeat(4000) }));
    await new Promise((r) => setTimeout(r, 200));
    expect(host.closed).toBe(true);
  });
});
