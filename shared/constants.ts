// Game rules in one place. All timings are in simulation ticks (TICK_RATE per second) and all
// positions in integer sub-tile units (SUB per tile), so every client, the server and the bots
// compute exactly the same thing.

export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
export const SUB = 1000;
export const HALF = SUB / 2;

export const COUNTDOWN_TICKS = 3 * TICK_RATE;
export const ROUND_TICKS = 120 * TICK_RATE;           // the arena is fully closed by about 2:00
export const SUDDEN_DEATH_AT = 90 * TICK_RATE;        // last 30 s: blocks drop from the outside in
export const ROUND_HARD_CAP = 125 * TICK_RATE;        // safety net: anyone still standing draws
export const END_DELAY_TICKS = Math.round(1.6 * TICK_RATE);

export const FUSE_TICKS = Math.round(2.5 * TICK_RATE);
export const FLAME_TICKS = Math.round(0.55 * TICK_RATE);
export const CRATE_BURN_TICKS = FLAME_TICKS;
export const KICK_SPEED = 260;                        // sub-units per tick for a sliding bomb

export const BASE_SPEED = 100;                        // 3 tiles per second
export const SPEED_STEP = 16;
export const MAX_SPEED_UPS = 4;
export const START_BOMBS = 1;
export const MAX_BOMBS = 8;
export const START_RANGE = 2;
export const MAX_RANGE = 8;

/** How far off a lane centre (in sub-units) a player can be and still be helped round a corner. */
export const CORNER_ASSIST = 420;

export const CRATE_DENSITY = 0.64;
export const POWERUP_CHANCE = 0.32;

export const WINS_TO_TAKE_MATCH = 3;
export const MAX_PLAYERS = 8;

export enum Dir { None = 0, Up = 1, Down = 2, Left = 3, Right = 4 }
export const DX = [0, 0, 0, -1, 1];
export const DY = [0, -1, 1, 0, 0];

export enum Cell { Floor = 0, Wall = 1, Crate = 2, Burning = 3 }

export enum PowerUp { BombUp = 1, FireUp = 2, SpeedUp = 3, Kick = 4 }

export const POWERUP_INFO: Record<PowerUp, { name: string; text: string }> = {
  [PowerUp.BombUp]: { name: "Extra Bomb", text: "Carry one more bomb at a time (up to 8)." },
  [PowerUp.FireUp]: { name: "Bigger Blast", text: "Your blasts reach one tile further (up to 8)." },
  [PowerUp.SpeedUp]: { name: "Trainers", text: "Run a little faster (up to 4 pairs)." },
  [PowerUp.Kick]: { name: "Kick Boots", text: "Walk into a bomb to send it sliding." },
};
