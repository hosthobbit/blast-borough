// The room "server" for peer-to-peer play, running in a Web Worker in the host's browser.
// Workers keep their timers running when the tab is in the background, so the match doesn't
// stall if the host switches tabs. The page relays messages to and from each player.

import { TICK_MS } from "../../shared/constants.js";
import { Lobby, handleConnection } from "../../shared/rooms.js";

type In = { k: "init"; code: string } | { k: "open"; peer: string } | { k: "msg"; peer: string; text: string } | { k: "close"; peer: string };

const lobby = new Lobby({ maxRooms: 1, tickMs: TICK_MS, snapEvery: 2 });
const conns = new Map<string, ReturnType<typeof handleConnection>>();
let code = "";
const post = (m: object) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  switch (m.k) {
    case "init":
      code = m.code;
      break;
    case "open": {
      const id = m.peer;
      const conn = {
        send: (text: string) => post({ k: "send", peer: id, text }),
        isOpen: () => conns.has(id),
        close: () => post({ k: "close", peer: id }),
      };
      conns.set(id, handleConnection(lobby, conn, { fixedCode: code }));
      break;
    }
    case "msg":
      conns.get(m.peer)?.message(m.text);
      break;
    case "close": {
      const h = conns.get(m.peer);
      conns.delete(m.peer);
      h?.close();
      break;
    }
  }
};
