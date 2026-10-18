// Draws a GameState. Knows nothing about rules: it is handed the current state, the previous
// tick's positions for smooth interpolation, and the events of each step for effects and sound.

import Phaser from "phaser";
import { Cell, Dir, FUSE_TICKS, PowerUp, SUB } from "../../shared/constants.js";
import type { GameEvent, GameState } from "../../shared/sim.js";
import { sfx } from "../audio.js";
import { settings } from "../settings.js";
import {
  CHARACTERS, LIFT, T, drawBackdrop, drawBarrier, drawBomb, drawBreakable, drawCharacter, drawDot, drawFlame, drawFloor,
  drawPillar, drawPowerUp, drawShard,
} from "./art.js";

export const SIDE = 30;

/** Mostly wooden crates, with bins, planters and post boxes as occasional street furniture. */
function breakableKind(cx: number, cy: number, seed: number): number {
  const h = ((cx * 73856093) ^ (cy * 19349663) ^ seed) >>> 0;
  const r = h % 20;
  return r < 13 ? 0 : r < 16 ? 1 : r < 18 ? 3 : 2;
}
/** Height of the street scene above the arena; smaller on short (phone) screens. */
export let TOP = 118;
export const BOTTOM = 26;

export interface Frame {
  state: GameState;
  /** positions at the previous tick, for interpolation (players and bombs) */
  prev: Map<string, { x: number; y: number }>;
  alpha: number;
  /** ids of players controlled on this device, with labels ("P1", "YOU") */
  local: Map<number, string>;
}

interface PlayerView { box: Phaser.GameObjects.Container; body: Phaser.GameObjects.Image; shadow: Phaser.GameObjects.Ellipse; tag?: Phaser.GameObjects.Text; dead: boolean; lastLook: number; }

export class ArenaScene extends Phaser.Scene {
  private w = 0;
  private h = 0;
  private built = false;
  private floorLayer!: Phaser.GameObjects.Container;
  private cellSprites = new Map<number, Phaser.GameObjects.Image>();
  private cellKind = new Map<number, number>();
  private bombSprites = new Map<number, { bomb: Phaser.GameObjects.Image; ring: Phaser.GameObjects.Ellipse; spark: Phaser.GameObjects.Image }>();
  private flameSprites = new Map<number, Phaser.GameObjects.Image>();
  private powerSprites = new Map<number, Phaser.GameObjects.Image>();
  private players = new Map<number, PlayerView>();
  private ambient: { update: (t: number) => void }[] = [];
  private suddenTint?: Phaser.GameObjects.Rectangle;
  private frameSource?: () => Frame | null;
  private lastLayoutSeed = -1;

  constructor() {
    super("arena");
  }

  create(): void {
    this.makeTextures();
    this.cameras.main.setBackgroundColor("#1b1430");
  }

  /** The driver hands the scene a function returning what to draw each frame. */
  setSource(source: (() => Frame | null) | undefined): void {
    this.frameSource = source;
  }

  private makeTextures(): void {
    const add = (key: string, c: HTMLCanvasElement) => { if (!this.textures.exists(key)) this.textures.addCanvas(key, c); };
    for (let v = 0; v < 2; v++) add(`floor${v}`, drawFloor(v));
    add("pillar", drawPillar(false));
    add("edge", drawPillar(true));
    for (let k = 0; k < 4; k++) add(`break${k}`, drawBreakable(k));
    add("barrier", drawBarrier());
    add("bomb", drawBomb());
    for (const p of ["c", "h", "v", "u", "d", "l", "r"]) add(`flame_${p}`, drawFlame(p));
    for (const k of [PowerUp.BombUp, PowerUp.FireUp, PowerUp.SpeedUp, PowerUp.Kick]) add(`pu${k}`, drawPowerUp(k));
    CHARACTERS.forEach((ch, i) => {
      for (const look of [-1, 0, 1, 2]) for (const f of [0, 1]) add(`ch${i}_${look}_${f}`, drawCharacter(ch, look, f));
    });
    add("spark", drawDot("rgba(255,230,140,1)", 6));
    add("smoke", drawDot("rgba(200,190,210,0.8)", 14));
    add("glow", drawDot("rgba(255,200,120,0.9)", 24));
    add("shardWood", drawShard("#c98d4a"));
    add("shardGreen", drawShard("#3e9a62"));
    add("shardRed", drawShard("#c42b2b"));
    add("shardLeaf", drawShard("#2e8a52"));
  }

  // ---------------------------------------------------------------- arena build

  private build(s: GameState): void {
    this.children.removeAll(true);
    this.cellSprites.clear(); this.cellKind.clear(); this.bombSprites.clear(); this.flameSprites.clear(); this.powerSprites.clear(); this.players.clear();
    this.ambient = [];
    this.w = s.w; this.h = s.h;
    TOP = window.innerHeight < 560 ? 70 : 118;
    const W = s.w * T + SIDE * 2, H = s.h * T + TOP + BOTTOM;
    this.scale.setGameSize(W, H);

    // backdrop: sky, houses, shops and lamps above the arena
    const key = `backdrop_${W}x${H}_${TOP}`;
    let bd = (this as unknown as { _bd?: ReturnType<typeof drawBackdrop> })._bd;
    if (!this.textures.exists(key)) {
      bd = drawBackdrop(W, H, TOP - LIFT, 4242 + W);
      this.textures.addCanvas(key, bd.canvas);
      (this as unknown as { _bd?: ReturnType<typeof drawBackdrop> })._bd = bd;
      this.registry.set(key, bd);
    } else bd = this.registry.get(key);
    this.add.image(0, 0, key).setOrigin(0).setDepth(-10);
    this.addAmbience(bd!);

    // floor
    this.floorLayer = this.add.container(0, 0).setDepth(-5);
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) this.floorLayer.add(this.add.image(SIDE + x * T, TOP + y * T, `floor${(x + y) % 2}`).setOrigin(0));
    // soft shadow along the top border so the arena sits into the street
    this.add.rectangle(SIDE, TOP + T, s.w * T, 10, 0x000000, 0.18).setOrigin(0).setDepth(-4);

    for (let c = 0; c < s.grid.length; c++) this.syncCell(s, c, false);
    this.suddenTint = this.add.rectangle(0, 0, W, H, 0xff2a2a, 0).setOrigin(0).setDepth(9000).setBlendMode(Phaser.BlendModes.ADD);
    this.built = true;
  }

  private addAmbience(bd: ReturnType<typeof drawBackdrop>): void {
    const reduced = settings.reducedMotion;
    // neon shop signs, gently flickering
    for (const n of bd.neons) {
      const txt = this.add.text(n.x, n.y, n.text, { fontFamily: "Trebuchet MS, Arial Rounded MT Bold, sans-serif", fontSize: "13px", fontStyle: "bold", color: n.colour })
        .setOrigin(0.5).setDepth(-9).setShadow(0, 0, n.colour, 8, true, true);
      const seed = Math.random() * 10;
      this.ambient.push({ update: (t) => { if (!reduced) txt.setAlpha(Math.sin(t * 0.0021 + seed) > 0.96 ? 0.35 : 0.92 + 0.08 * Math.sin(t * 0.01 + seed)); } });
    }
    for (const l of bd.lamps) {
      const glow = this.add.image(l.x, l.y + 4, "glow").setDepth(-8).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.8).setScale(1.2);
      this.ambient.push({ update: (t) => { if (!reduced) glow.setAlpha(0.72 + 0.08 * Math.sin(t * 0.003 + l.x)); } });
    }
    // windows: now and then a light goes on or off
    const g = this.add.graphics().setDepth(-9);
    const lit = bd.windows.map(() => true);
    let next = 0;
    this.ambient.push({
      update: (t) => {
        if (reduced || t < next) return;
        next = t + 2500 + Math.random() * 3000;
        const i = Math.floor(Math.random() * bd.windows.length);
        lit[i] = !lit[i];
        g.clear();
        bd.windows.forEach((win, k) => { if (!lit[k]) { g.fillStyle(0x2a2140, 1); g.fillRect(win.x, win.y, win.w, win.h); } });
      },
    });
  }

  private cellXY(c: number) {
    return { x: SIDE + (c % this.w) * T, y: TOP + Math.floor(c / this.w) * T };
  }

  /** Make the sprite for a cell match the grid. */
  private syncCell(s: GameState, c: number, animate: boolean): void {
    const g = s.grid[c];
    const cx = c % s.w, cy = Math.floor(c / s.w);
    const edge = cx === 0 || cy === 0 || cx === s.w - 1 || cy === s.h - 1;
    const kind = g === Cell.Wall ? (this.cellKind.get(c) === 9 ? 9 : 1) : g === Cell.Crate ? 2 : g === Cell.Burning ? 3 : 0;
    const prevKind = this.cellKind.get(c) ?? 0;
    if (prevKind === kind || (kind === 1 && prevKind === 9)) return;
    const { x, y } = this.cellXY(c);
    const old = this.cellSprites.get(c);
    if (kind === 3) {
      // crate hit: it flashes and shrinks away; debris flies
      if (old) {
        this.tweens.add({ targets: old, alpha: 0, scaleX: 0.6, scaleY: 0.6, duration: 260, onComplete: () => old.destroy() });
        this.cellSprites.delete(c);
        const variant = breakableKind(cx, cy, s.seed);
        this.debris(x + T / 2, y + T / 2, ["shardWood", "shardGreen", "shardRed", "shardLeaf"][variant]);
      }
      this.cellKind.set(c, 3);
      return;
    }
    old?.destroy();
    this.cellSprites.delete(c);
    this.cellKind.set(c, kind);
    if (kind === 0) return;
    let key: string;
    if (kind === 1) {
      const dropped = animate && !edge && (cx % 2 === 1 || cy % 2 === 1);
      key = dropped ? "barrier" : edge ? "edge" : "pillar";
      if (dropped) this.cellKind.set(c, 9);
    } else key = `break${breakableKind(cx, cy, s.seed)}`;
    const img = this.add.image(x, y - LIFT, key).setOrigin(0, 0).setDepth(y + T);
    if (kind === 2) img.setOrigin(0, 0);
    this.cellSprites.set(c, img);
    if (animate && kind === 1) {
      // sudden-death block falls in
      img.y -= 260;
      this.tweens.add({ targets: img, y: y - LIFT, duration: settings.reducedMotion ? 120 : 360, ease: "Bounce.easeOut" });
      if (!settings.reducedMotion) this.time.delayedCall(260, () => this.dust(x + T / 2, y + T));
    }
  }

  // ---------------------------------------------------------------- per frame

  update(time: number): void {
    const frame = this.frameSource?.();
    if (!frame) return;
    const s = frame.state;
    if (!this.built || s.w !== this.w || s.h !== this.h || s.seed !== this.lastLayoutSeed) {
      this.build(s);
      this.lastLayoutSeed = s.seed;
    }
    for (const a of this.ambient) a.update(time);
    for (let c = 0; c < s.grid.length; c++) {
      const k = this.cellKind.get(c) ?? 0;
      const g = s.grid[c];
      const want = g === Cell.Wall ? 1 : g === Cell.Crate ? 2 : g === Cell.Burning ? 3 : 0;
      if (want !== k && !(want === 1 && k === 9)) this.syncCell(s, c, true);
    }
    this.drawPowerUps(s, time);
    this.drawBombs(frame, time);
    this.drawFlames(s, time);
    this.drawPlayers(frame, time);
    const sudden = s.dropIndex > 0 && s.phase !== "ended";
    if (this.suddenTint) this.suddenTint.setAlpha(sudden && !settings.reducedMotion ? 0.05 + 0.03 * Math.sin(time * 0.006) : sudden ? 0.05 : 0);
  }

  private lerp(frame: Frame, key: string, x: number, y: number) {
    const p = frame.prev.get(key);
    if (!p) return { x, y };
    // big jumps are teleports (respawn, snapshot correction): don't smear them
    if (Math.abs(p.x - x) > SUB * 1.5 || Math.abs(p.y - y) > SUB * 1.5) return { x, y };
    return { x: p.x + (x - p.x) * frame.alpha, y: p.y + (y - p.y) * frame.alpha };
  }

  private px(x: number) { return SIDE + (x / SUB) * T; }
  private py(y: number) { return TOP + (y / SUB) * T; }

  private drawPowerUps(s: GameState, time: number): void {
    const seen = new Set<number>();
    for (let c = 0; c < s.powerups.length; c++) {
      const kind = s.powerups[c];
      if (!kind) continue;
      seen.add(c);
      let img = this.powerSprites.get(c);
      if (!img || img.texture.key !== `pu${kind}`) {
        img?.destroy();
        const { x, y } = this.cellXY(c);
        img = this.add.image(x + T / 2, y + T / 2, `pu${kind}`).setDepth(y + T - 2).setScale(0.2);
        this.tweens.add({ targets: img, scale: 0.88, duration: 260, ease: "Back.easeOut" });
        this.powerSprites.set(c, img);
      }
      if (!settings.reducedMotion) img.y = this.cellXY(c).y + T / 2 - 3 + Math.sin(time * 0.005 + c) * 2.5;
    }
    for (const [c, img] of this.powerSprites) if (!seen.has(c)) { img.destroy(); this.powerSprites.delete(c); }
  }

  private drawBombs(frame: Frame, time: number): void {
    const s = frame.state;
    const seen = new Set<number>();
    for (const b of s.bombs) {
      seen.add(b.id);
      let v = this.bombSprites.get(b.id);
      if (!v) {
        const ring = this.add.ellipse(0, 0, T * 0.78, T * 0.36, Phaser.Display.Color.HexStringToColor(CHARACTERS[b.owner].colour).color, 0.55);
        const bomb = this.add.image(0, 0, "bomb");
        const spark = this.add.image(0, 0, "spark").setBlendMode(Phaser.BlendModes.ADD);
        v = { bomb, ring, spark };
        this.bombSprites.set(b.id, v);
        bomb.setScale(0.4);
        this.tweens.add({ targets: bomb, scale: 1, duration: 160, ease: "Back.easeOut" });
      }
      const pos = this.lerp(frame, `b${b.id}`, b.x, b.y);
      const x = this.px(pos.x), y = this.py(pos.y);
      // fuse: pulse quickens and the bomb reddens as it burns down
      const left = b.fuse / FUSE_TICKS;
      const rate = 0.006 + (1 - left) * 0.03;
      const pulse = settings.reducedMotion ? 0 : Math.sin(time * rate) * (0.05 + (1 - left) * 0.07);
      if (v.bomb.scale >= 0.99) v.bomb.setScale(1 + pulse);
      const heat = Math.max(0, 1 - left * 1.6);
      v.bomb.setTint(Phaser.Display.Color.GetColor(255, Math.round(255 - heat * 150), Math.round(255 - heat * 170)));
      v.bomb.setPosition(x, y - 6).setDepth(y + T / 2 - 1);
      v.ring.setPosition(x, y + 12).setDepth(y + T / 2 - 2);
      const flick = 0.7 + Math.random() * 0.6;
      v.spark.setPosition(x + 11, y - 6 - 20).setDepth(y + T / 2).setScale(settings.reducedMotion ? 0.9 : flick).setAlpha(0.9);
    }
    for (const [id, v] of this.bombSprites) if (!seen.has(id)) { v.bomb.destroy(); v.ring.destroy(); v.spark.destroy(); this.bombSprites.delete(id); }
  }

  private drawFlames(s: GameState, time: number): void {
    const seen = new Set<number>();
    for (const key of Object.keys(s.flames)) {
      const c = Number(key);
      const f = s.flames[c];
      seen.add(c);
      let img = this.flameSprites.get(c);
      const tex = `flame_${f.part}`;
      if (!img) {
        const { x, y } = this.cellXY(c);
        img = this.add.image(x + T / 2, y + T / 2, tex).setDepth(y + T + 1).setBlendMode(Phaser.BlendModes.NORMAL);
        this.flameSprites.set(c, img);
      } else if (img.texture.key !== tex) img.setTexture(tex);
      const fade = Math.min(1, f.ticks / 6);
      const wob = settings.reducedMotion ? 1 : 0.94 + Math.sin(time * 0.05 + c) * 0.06;
      img.setAlpha(fade).setScale(f.part === "h" ? 1 : wob, f.part === "v" ? 1 : wob);
    }
    for (const [c, img] of this.flameSprites) if (!seen.has(c)) { img.destroy(); this.flameSprites.delete(c); }
  }

  private drawPlayers(frame: Frame, time: number): void {
    const s = frame.state;
    for (const p of s.players) {
      let v = this.players.get(p.id);
      if (!v) {
        const shadow = this.add.ellipse(0, 0, T * 0.66, T * 0.24, 0x000000, 0.32);
        const body = this.add.image(0, 0, `ch${p.id}_0_0`).setOrigin(0.5, 1);
        const box = this.add.container(0, 0, [shadow, body]);
        shadow.setPosition(0, -2);
        v = { box, body, shadow, dead: false, lastLook: 0 };
        const label = frame.local.get(p.id);
        if (label) {
          v.tag = this.add.text(0, -66, label, { fontFamily: "Trebuchet MS, sans-serif", fontSize: "12px", fontStyle: "bold", color: "#fff", backgroundColor: CHARACTERS[p.id].dark, padding: { x: 4, y: 1 } }).setOrigin(0.5, 1);
          box.add(v.tag);
        }
        this.players.set(p.id, v);
      }
      if (!p.alive) {
        if (!v.dead) {
          v.dead = true;
          // knocked out: a spin and fade, with a little puff
          this.tweens.add({ targets: v.body, angle: settings.reducedMotion ? 0 : 360, scale: 0.4, alpha: 0, duration: 650, ease: "Cubic.easeIn" });
          this.tweens.add({ targets: [v.shadow, v.tag].filter(Boolean), alpha: 0, duration: 400 });
          this.dust(v.box.x, v.box.y - 20);
        }
        continue;
      }
      if (v.dead) { // a new round re-uses ids
        v.dead = false; v.body.setAlpha(1).setScale(1).setAngle(0); v.shadow.setAlpha(0.32); v.tag?.setAlpha(1);
      }
      const pos = this.lerp(frame, `p${p.id}`, p.x, p.y);
      const x = this.px(pos.x), y = this.py(pos.y) + T * 0.32;
      v.box.setPosition(x, y).setDepth(y + 2);
      const look = p.facing === Dir.Left ? -1 : p.facing === Dir.Right ? 1 : p.facing === Dir.Up ? 2 : 0;
      const walking = p.moving && !settings.reducedMotion;
      const f = walking ? Math.floor(time / 130) % 2 : 0;
      v.body.setTexture(`ch${p.id}_${look}_${f}`);
      v.body.setScale(0.92, walking ? 0.92 + (f ? -0.03 : 0.02) : 0.92 + (settings.reducedMotion ? 0 : Math.sin(time * 0.004 + p.id) * 0.012));
    }
  }

  // ---------------------------------------------------------------- events: effects and sound

  /** Players controlled on this device, for "close one!" feedback. */
  localPlayers = new Set<number>();
  private lastCloseCall = new Map<number, number>();

  handleEvents(events: GameEvent[], s: GameState): void {
    for (const e of events) {
      if (e.type === "explode") this.closeCalls(e.cells, s);
      switch (e.type) {
        case "bomb": sfx.place(); break;
        case "explode": {
          sfx.explode(e.cells.length / 6);
          const { x, y } = this.cellXY(e.y * s.w + e.x);
          this.sparks(x + T / 2, y + T / 2, settings.reducedMotion ? 4 : 10);
          if (settings.screenShake && !settings.reducedMotion) this.cameras.main.shake(110, 0.0035);
          break;
        }
        case "crate": sfx.crate(); break;
        case "pickup": {
          sfx.pickup();
          const { x, y } = this.cellXY(e.cell);
          const txt = this.add.text(x + T / 2, y, ["", "+1 BOMB", "+1 BLAST", "SPEED!", "KICK!"][e.kind], { fontFamily: "Trebuchet MS, sans-serif", fontSize: "13px", fontStyle: "bold", color: "#fff6e0", stroke: "#1a1026", strokeThickness: 3 }).setOrigin(0.5).setDepth(9500);
          this.tweens.add({ targets: txt, y: y - 26, alpha: 0, duration: 900, onComplete: () => txt.destroy() });
          break;
        }
        case "kick": sfx.kick(); break;
        case "death": sfx.death(); break;
        case "drop": sfx.drop(); break;
        case "reveal": break;
      }
    }
  }

  /** A blast passed right next to one of our players and missed: say so. */
  private closeCalls(cells: number[], s: GameState): void {
    const hit = new Set(cells);
    for (const id of this.localPlayers) {
      const p = s.players[id];
      if (!p?.alive) continue;
      const cx = Math.floor(p.x / SUB), cy = Math.floor(p.y / SUB), c = cy * s.w + cx;
      if (hit.has(c) || s.flames[c]) continue;
      const near = [c - 1, c + 1, c - s.w, c + s.w].some((n) => hit.has(n));
      const last = this.lastCloseCall.get(id) ?? 0;
      if (!near || this.time.now - last < 2500) continue;
      this.lastCloseCall.set(id, this.time.now);
      const x = this.px(p.x), y = this.py(p.y) - T * 0.9;
      const txt = this.add.text(x, y, "Close one!", { fontFamily: "Trebuchet MS, sans-serif", fontSize: "14px", fontStyle: "bold", color: "#ffe066", stroke: "#1a1026", strokeThickness: 4 }).setOrigin(0.5).setDepth(9700);
      this.tweens.add({ targets: txt, y: y - 22, alpha: 0, duration: 1000, ease: "Quad.easeOut", onComplete: () => txt.destroy() });
    }
  }

  private sparks(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const sp = this.add.image(x, y, "spark").setBlendMode(Phaser.BlendModes.ADD).setDepth(9600).setScale(0.6 + Math.random() * 0.6);
      const a = Math.random() * Math.PI * 2, d = 18 + Math.random() * 40;
      this.tweens.add({ targets: sp, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, alpha: 0, scale: 0.1, duration: 300 + Math.random() * 250, onComplete: () => sp.destroy() });
    }
  }

  private debris(x: number, y: number, key: string): void {
    const n = settings.reducedMotion ? 2 : 6;
    for (let i = 0; i < n; i++) {
      const sh = this.add.image(x, y, key).setDepth(9550).setAngle(Math.random() * 360);
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, d = 18 + Math.random() * 26;
      this.tweens.add({ targets: sh, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d * 0.6 + 14, angle: sh.angle + 200, alpha: 0, duration: 520, ease: "Quad.easeOut", onComplete: () => sh.destroy() });
    }
  }

  private dust(x: number, y: number): void {
    const n = settings.reducedMotion ? 2 : 5;
    for (let i = 0; i < n; i++) {
      const p = this.add.image(x + (Math.random() - 0.5) * 30, y, "smoke").setDepth(9400).setAlpha(0.6).setScale(0.6);
      this.tweens.add({ targets: p, y: y - 12 - Math.random() * 16, scale: 1.3, alpha: 0, duration: 600, onComplete: () => p.destroy() });
    }
  }
}
