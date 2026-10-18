// Blast Borough multiplayer server: WebSocket rooms with an authoritative simulation.
//   PORT=8787 ALLOWED_ORIGINS=https://example.com MAX_ROOMS=200 node dist-server/server/index.js

import { createServer as createHttpServer, type Server } from "node:http";
import { WebSocketServer, type RawData } from "ws";
import { MAX_MESSAGE_BYTES } from "../shared/protocol.js";
import { TICK_MS } from "../shared/constants.js";
import { Lobby, type ServerOptions, handleConnection } from "../shared/rooms.js";

export interface RunningServer { port: number; close(): Promise<void>; lobby: Lobby; http: Server }

export function startServer(opts: Partial<ServerOptions> & { port?: number; allowedOrigins?: string[] } = {}): Promise<RunningServer> {
  const options: ServerOptions = {
    maxRooms: opts.maxRooms ?? 200,
    tickMs: opts.tickMs ?? TICK_MS,
    snapEvery: opts.snapEvery ?? 2,
    log: opts.log,
  };
  const lobby = new Lobby(options);
  const allowed = (opts.allowedOrigins ?? []).filter(Boolean);

  const http = createHttpServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ ok: true, rooms: lobby.rooms.size }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Blast Borough server. Connect with WebSocket.\n");
  });

  const wss = new WebSocketServer({
    server: http,
    maxPayload: MAX_MESSAGE_BYTES * 2,
    verifyClient: (info: { origin: string }) => allowed.length === 0 || allowed.includes(info.origin),
  });

  wss.on("connection", (ws) => {
    const conn = { send: (t: string) => ws.send(t), isOpen: () => ws.readyState === ws.OPEN, close: () => ws.close() };
    const handler = handleConnection(lobby, conn);
    let alive = true;
    ws.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, 15000);
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      handler.message(Array.isArray(data) ? Buffer.concat(data).toString("utf8") : data.toString());
    });
    ws.on("close", () => { clearInterval(heartbeat); handler.close(); });
    ws.on("error", () => { /* close follows */ });
  });

  const sweeper = setInterval(() => lobby.sweep(2 * 60 * 60 * 1000), 60_000);

  return new Promise((resolve) => {
    http.listen(opts.port ?? 8787, () => {
      const addr = http.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 8787;
      resolve({
        port, lobby, http,
        close: () => new Promise<void>((done) => {
          clearInterval(sweeper);
          for (const r of lobby.rooms.values()) r.stop();
          for (const c of wss.clients) c.terminate();
          wss.close();
          http.close(() => done());
        }),
      });
    });
  });
}

// run directly: node dist-server/server/index.js (or `npm run dev:server`)
const isMain = process.argv[1] && /server[\\/]index\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  startServer({ port, allowedOrigins, maxRooms: Number(process.env.MAX_ROOMS || 200), log: (m) => console.log(new Date().toISOString(), m) }).then((s) => {
    console.log(`Blast Borough server listening on :${s.port}${allowedOrigins.length ? ` (origins: ${allowedOrigins.join(", ")})` : ""}`);
  });
}
