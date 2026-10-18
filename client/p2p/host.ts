// Hosting a peer-to-peer room: this browser runs the room (in a worker) and accepts direct
// connections from friends. The host's own player talks to the worker through a loopback.

import { ICE_SERVERS, iceGathered, signal } from "./signal.js";
import type { Transport } from "./transport.js";

interface Peer { pc: RTCPeerConnection; ch: RTCDataChannel | null; open: boolean }

export class P2PHost {
  code = "";
  private secret = "";
  private worker!: Worker;
  private peers = new Map<string, Peer>();
  private pollTimer = 0;
  private stopped = false;
  private local!: Transport;
  /** slower polling once a match is running (nobody can join mid-match anyway) */
  slowPoll = false;

  async start(): Promise<Transport> {
    const room = await signal<{ code: string; secret: string }>({ action: "host" });
    this.code = room.code;
    this.secret = room.secret;
    this.worker = new Worker(new URL("./hostWorker.ts", import.meta.url), { type: "module" });
    this.worker.postMessage({ k: "init", code: this.code });
    this.worker.onmessage = (e) => this.fromWorker(e.data);
    this.local = {
      kind: "p2p-host",
      send: (text) => this.worker.postMessage({ k: "msg", peer: "local", text }),
      close: () => this.stop(),
      onmessage: () => {},
      onclose: () => {},
    };
    this.worker.postMessage({ k: "open", peer: "local" });
    this.poll();
    window.addEventListener("pagehide", () => this.stop());
    return this.local;
  }

  private fromWorker(m: { k: "send" | "close"; peer: string; text?: string }) {
    if (m.peer === "local") {
      if (m.k === "send") this.local.onmessage(m.text!);
      return;
    }
    const p = this.peers.get(m.peer);
    if (!p) return;
    if (m.k === "send") { if (p.ch && p.ch.readyState === "open") p.ch.send(m.text!); }
    else this.drop(m.peer);
  }

  private async poll() {
    if (this.stopped) return;
    try {
      const res = await signal<{ messages: { from: string; body: string }[] }>({ action: "poll", code: this.code, me: "host", secret: this.secret });
      for (const msg of res.messages) await this.onSignal(msg.from, msg.body);
    } catch { /* transient: try again next time */ }
    if (!this.stopped) this.pollTimer = window.setTimeout(() => this.poll(), this.slowPoll ? 4000 : 1000);
  }

  private async onSignal(from: string, body: string) {
    let m: { type: string; sdp: string };
    try { m = JSON.parse(body); } catch { return; }
    if (m.type !== "offer" || typeof m.sdp !== "string" || this.peers.has(from)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer: Peer = { pc, ch: null, open: false };
    this.peers.set(from, peer);
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      peer.ch = ch;
      ch.onopen = () => { peer.open = true; this.worker.postMessage({ k: "open", peer: from }); };
      ch.onmessage = (ev) => { if (typeof ev.data === "string") this.worker.postMessage({ k: "msg", peer: from, text: ev.data }); };
      ch.onclose = () => this.drop(from);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "closed") this.drop(from);
      // an abruptly closed tab shows up as "disconnected" first: give it a moment to come back
      if (st === "disconnected") setTimeout(() => { if (pc.connectionState === "disconnected") this.drop(from); }, 5000);
    };
    // never wait forever for a friend whose network can't connect
    setTimeout(() => { if (!peer.open) this.drop(from); }, 30000);
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await iceGathered(pc);
      await signal({ action: "send", code: this.code, me: "host", secret: this.secret, to: from, body: JSON.stringify({ type: "answer", sdp: pc.localDescription!.sdp }) });
    } catch {
      this.drop(from);
    }
  }

  private drop(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    if (p.open) this.worker.postMessage({ k: "close", peer: id });
    try { p.ch?.close(); } catch { /* ignore */ }
    try { p.pc.close(); } catch { /* ignore */ }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.pollTimer);
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.worker?.terminate();
    if (this.code) signal({ action: "close", code: this.code, me: "host", secret: this.secret }).catch(() => {});
  }
}
