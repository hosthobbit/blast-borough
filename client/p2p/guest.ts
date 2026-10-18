// Joining a peer-to-peer room: connect straight to the host's browser over WebRTC.

import { ICE_SERVERS, iceGathered, signal } from "./signal.js";
import type { Transport } from "./transport.js";

const NO_ROUTE = "Couldn't connect to the host's browser. Some networks (often mobile data or strict work/school Wi-Fi) block direct connections: try another network, or have someone else host.";

export async function joinHost(code: string): Promise<Transport> {
  const me = await signal<{ peer: string; secret: string }>({ action: "join", code });
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const ch = pc.createDataChannel("game", { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await iceGathered(pc);
  await signal({ action: "send", code, me: me.peer, secret: me.secret, to: "host", body: JSON.stringify({ type: "offer", sdp: pc.localDescription!.sdp }) });

  // wait for the host's answer
  const deadline = Date.now() + 25000;
  let answer: string | null = null;
  while (!answer && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    const res = await signal<{ messages: { from: string; body: string }[] }>({ action: "poll", code, me: me.peer, secret: me.secret });
    for (const m of res.messages) {
      try { const b = JSON.parse(m.body); if (b.type === "answer") answer = b.sdp; } catch { /* ignore */ }
    }
  }
  if (!answer) { pc.close(); throw new Error("The host didn't answer. Is their game still open on the room screen?"); }
  await pc.setRemoteDescription({ type: "answer", sdp: answer });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(NO_ROUTE)), 15000);
    ch.onopen = () => { clearTimeout(timer); resolve(); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") { clearTimeout(timer); reject(new Error(NO_ROUTE)); } };
  }).catch((e) => { pc.close(); throw e; });

  const t: Transport = {
    kind: "p2p-guest",
    send: (text) => { if (ch.readyState === "open") ch.send(text); },
    close: () => { try { ch.close(); pc.close(); } catch { /* ignore */ } },
    onmessage: () => {},
    onclose: () => {},
  };
  ch.onmessage = (e) => { if (typeof e.data === "string") t.onmessage(e.data); };
  // leaving the page: say goodbye properly so the host notices at once
  window.addEventListener("pagehide", () => t.close(), { once: true });
  ch.onclose = () => t.onclose();
  pc.onconnectionstatechange = () => { if (pc.connectionState === "failed" || pc.connectionState === "disconnected") setTimeout(() => { if (pc.connectionState !== "connected") t.onclose(); }, 4000); };
  return t;
}
