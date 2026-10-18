// A message pipe to the room server: a WebSocket (dedicated server), a WebRTC data channel
// (guest in a peer-to-peer room) or an in-page loopback (the host's own player).

export interface Transport {
  kind: "server" | "p2p-host" | "p2p-guest";
  send(text: string): void;
  close(): void;
  onmessage: (text: string) => void;
  onclose: () => void;
}

export function webSocketTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { reject(new Error("That server address isn't valid.")); return; }
    const t: Transport = {
      kind: "server",
      send: (text) => { if (ws.readyState === WebSocket.OPEN) ws.send(text); },
      close: () => ws.close(),
      onmessage: () => {},
      onclose: () => {},
    };
    const timer = setTimeout(() => { ws.close(); reject(new Error("Couldn't reach the game server. Is it running? (see README)")); }, 7000);
    ws.onopen = () => { clearTimeout(timer); resolve(t); };
    ws.onmessage = (e) => { if (typeof e.data === "string") t.onmessage(e.data); };
    ws.onclose = () => { clearTimeout(timer); reject(new Error("Couldn't reach the game server. Is it running? (see README)")); t.onclose(); };
  });
}
