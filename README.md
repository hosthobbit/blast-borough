# Blast Borough

**Send a link. Settle it in two minutes.**

A grid-based bomb battle in a colourful neighbourhood at dusk. Drop bombs, blast crates, bins and planters, grab power-ups, and catch your friends in the blast. Last one standing wins the round; first to three rounds takes the match.

- **Solo** against three bots (Easy, Normal, Hard)
- **Local multiplayer**: two players on one keyboard, plus optional bots
- **Online private rooms**: 2 to 8 players, invite link, lobby with ready states, bots fill empty spots
- **Daily challenge**: the same arena for everyone on a UTC date, with personal bests
- Phones and tablets: touch D-pad and a big bomb button, responsive layout

All characters, artwork, sounds and music are original and generated in code: no image or audio files, nothing loaded from other sites.

## Quick start

Needs Node.js 20 or newer.

```bash
npm install
npm run dev            # game client at http://localhost:5173
npm run dev:server     # multiplayer server on ws://localhost:8787 (only needed for online play)
```

Solo, local and daily modes work with just the client. Online multiplayer needs the server running.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server for the client |
| `npm run dev:server` | Multiplayer server with auto-reload (tsx) |
| `npm test` | Unit and integration tests (Vitest): rules, bots, server |
| `npm run test:e2e` | Browser tests in headless Chromium: starts its own server and client |
| `npm run typecheck` | TypeScript checks for client and server |
| `npm run build` | Typecheck, then build the client to `dist/` and the server to `dist-server/` |
| `npm run start:server` | Run the built server (`node dist-server/server/index.js`) |
| `npm run preview` | Serve the built client locally |

`npm run test:e2e` uses the system Chromium (`/usr/bin/chromium`; override with `CHROME=/path/to/chrome`). It runs with software rendering and muted audio. Pass scenario names to run a few: `node e2e/run.mjs solo online`.

## Configuration

Copy `.env.example` to `.env`. Nothing in it is secret.

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `VITE_SERVER_URL` | client (build time) | `ws(s)://<page host>:8787` | Where the multiplayer server is, e.g. `wss://blast.example.com` |
| `PORT` | server | `8787` | Port to listen on |
| `ALLOWED_ORIGINS` | server | any | Comma-separated page origins allowed to connect, e.g. `https://you.github.io` |
| `MAX_ROOMS` | server | `200` | Cap on simultaneous rooms |

## Hosting

**The client** is static files. After `npm run build`, upload `dist/` to any static host (GitHub Pages, Netlify, your own web space). It works from any path. Build it with `VITE_SERVER_URL` set so it knows where the server is:

```bash
VITE_SERVER_URL=wss://blast.example.com npm run build
```

**The server** is a small Node.js process that needs to stay running, so it needs a host that runs Node and allows WebSockets: a VPS, Fly.io, Render, Railway, etc. Shared PHP hosting won't do.

```bash
npm ci
npm run build
PORT=8787 ALLOWED_ORIGINS=https://your-game-site.example node dist-server/server/index.js
```

Put it behind HTTPS so browsers on `https://` pages can connect with `wss://`. With nginx:

```nginx
server {
  server_name blast.example.com;
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
  }
  # + your TLS certificate (e.g. certbot --nginx)
}
```

Keep it running with systemd or pm2. `GET /health` returns `{"ok":true,"rooms":N}` for monitoring. One small server handles many rooms: a room is a 30 Hz simulation plus up to 15 snapshots a second per player.

## How it's built

```
shared/      game rules, used by the client, the server and the bots
  sim.ts       the simulation: fixed 30 Hz tick, integer positions, no randomness except a seeded PRNG
  map.ts       arena generation with fair spawns
  bot.ts       bot AI: blast-time forecast (chain reactions included), safe-escape checks
  protocol.ts  online messages, validation, snapshots
client/      Phaser 3 rendering and HTML menus
  game/ArenaScene.ts  draws a game state (it knows nothing about the rules)
  game/art.ts         all artwork, drawn with Canvas 2D at start-up
  game/localMatch.ts  solo / local / daily matches
  net.ts              online play: input sending, prediction, interpolation
  audio.ts            synthesised sound effects and music (Web Audio)
server/      Node + ws: rooms, lobby, authoritative matches
tests/       Vitest: rules, bots, server
e2e/         headless browser tests
```

### Rules

- Movement is continuous but locked to lanes, with **corner assist**: press a turn a little early or late and you're guided round the corner.
- Bombs explode after 2.5 s. Blasts go in four straight lines; walls stop them; a crate (or bin, planter, post box) takes the hit, is destroyed and stops that arm; a bomb in the way is set off at once (**chain reaction**).
- You can walk off a bomb you've just dropped, but not back onto it. Bombs block everyone else.
- Power-ups hide under some crates: **Extra Bomb** (up to 8), **Bigger Blast** (range up to 8), **Trainers** (speed, up to 4), **Kick Boots** (walk into a bomb to slide it). Blasts destroy loose power-ups.
- Rounds last about two minutes. At **0:30 left, sudden death**: barriers drop from the edges inwards until the arena is closed.
- Last player standing wins the round. If everyone remaining is eliminated on the same tick, the round is a **draw**.
- Every spawn has a clear L-shaped opening and crates within reach, and tests check that each player can bomb and escape from the start on hundreds of generated maps.

### Online

The server is authoritative. Clients send one input per tick (direction + bomb press); the server validates and rate-limits them, queues them, runs the simulation and sends snapshots 15 times a second. Hidden power-ups are never sent to clients. Your own character is predicted locally with the same movement code and corrected against the server; other players are interpolated between snapshots.

If someone disconnects mid-match, a bot takes over their character and the match continues. If the host leaves, the next player becomes host. Empty rooms close straight away, and idle lobbies close after two hours. Players can't join a room mid-match; they're told to try again when it finishes.

## What's tested

- **Unit / integration (`npm test`, 33 tests):** blast blocking and destructible obstacles; chain reactions and explosion timing; bomb occupancy and walking off a new bomb; power-up limits; kick; simultaneous deaths and round results; first-to-three; sudden death timing; reproducible maps; safe spawns (and a playable opening on 60 maps × 4 players); bot forecasts, escapes, refusing suicidal bombs; full bot rounds; full online matches over real WebSockets; rematch score reset; invalid and malicious messages; host handover; bots replacing leavers; room cleanup; rate limits and message size caps.
- **Browser (`npm run test:e2e`):** a complete solo match plus rematch; local two-player keyboard controls, pause and no page scrolling; two online clients joining by invite link, readying up and completing a round, then one disconnecting; a clear error when the server can't be reached; the phone layout (landscape and portrait) with touch steering and bombing; the daily challenge; keyboard-only menus; no console errors.

## Limitations

- Not tested on real phones or tablets, only in a mobile browser emulator. Performance on older phones is unknown.
- No reconnection: a player who drops is replaced by a bot for the rest of that match.
- Players can't join a room while a match is running (they can after it ends).
- Daily challenge scores are kept on each device only. There is no global leaderboard.
- Two-player local mode needs a keyboard, so it's desktop-only. The game says so on touch devices.
- Future ideas, not built: map editor, cosmetic unlocks, revenge mode.

## Credits

Game design, code, art, sound and music: original, made for this project. Built with [Phaser 3](https://phaser.io) (MIT) and [ws](https://github.com/websockets/ws) (MIT). No third-party assets.

© Host Hobbit Ltd
