// All artwork is drawn here with the Canvas 2D API at start-up: original, resolution-independent,
// and no image files to load. Each function returns a canvas that Phaser turns into a texture.

import { PowerUp } from "../../shared/constants.js";

export const T = 48;          // pixels per arena cell
export const LIFT = 14;       // how far solid blocks rise above the floor (the slight top-down angle)

export interface Character {
  name: string;
  colour: string;
  dark: string;
  light: string;
  symbol: "circle" | "square" | "triangle" | "diamond" | "star" | "hex" | "plus" | "heart";
  hat: "beanie" | "cap" | "bun" | "visor" | "mohawk" | "hardhat" | "headphones" | "bowler";
}

/** Eight original residents of the borough. Colour, hat and chest symbol all differ. */
export const CHARACTERS: Character[] = [
  { name: "Pip", colour: "#ff8a2a", dark: "#b4530c", light: "#ffc48a", symbol: "circle", hat: "beanie" },
  { name: "Rook", colour: "#3d8bff", dark: "#1d4fa8", light: "#9cc3ff", symbol: "square", hat: "cap" },
  { name: "Mabel", colour: "#ff5fb3", dark: "#b02d72", light: "#ffb3dc", symbol: "triangle", hat: "bun" },
  { name: "Juno", colour: "#38c76a", dark: "#1b7d3d", light: "#9ff0b8", symbol: "diamond", hat: "visor" },
  { name: "Ziggy", colour: "#a66bff", dark: "#6232b8", light: "#d6bdff", symbol: "star", hat: "mohawk" },
  { name: "Bram", colour: "#ffd23d", dark: "#b08d0c", light: "#fff0a6", symbol: "hex", hat: "hardhat" },
  { name: "Nell", colour: "#22c9c9", dark: "#0d7f86", light: "#a3f3f0", symbol: "plus", hat: "headphones" },
  { name: "Odie", colour: "#ff4b4b", dark: "#a81e24", light: "#ffaaa6", symbol: "heart", hat: "bowler" },
];

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = Math.ceil(w);
  c.height = Math.ceil(h);
  const g = c.getContext("2d")!;
  return [c, g];
}

function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Seeded noise for texture details, so the art is identical every load. */
function noise(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function drawSymbol(g: CanvasRenderingContext2D, sym: Character["symbol"], x: number, y: number, r: number) {
  g.beginPath();
  switch (sym) {
    case "circle": g.arc(x, y, r, 0, Math.PI * 2); break;
    case "square": g.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7); break;
    case "triangle": g.moveTo(x, y - r); g.lineTo(x + r, y + r * 0.8); g.lineTo(x - r, y + r * 0.8); g.closePath(); break;
    case "diamond": g.moveTo(x, y - r * 1.1); g.lineTo(x + r, y); g.lineTo(x, y + r * 1.1); g.lineTo(x - r, y); g.closePath(); break;
    case "star":
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r * 1.1;
        if (i) g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      g.closePath();
      break;
    case "hex":
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        if (i) g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); else g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      g.closePath();
      break;
    case "plus":
      g.rect(x - r * 0.35, y - r, r * 0.7, r * 2);
      g.rect(x - r, y - r * 0.35, r * 2, r * 0.7);
      break;
    case "heart":
      g.moveTo(x, y + r * 0.9);
      g.bezierCurveTo(x - r * 1.4, y - r * 0.1, x - r * 0.6, y - r * 1.2, x, y - r * 0.45);
      g.bezierCurveTo(x + r * 0.6, y - r * 1.2, x + r * 1.4, y - r * 0.1, x, y + r * 0.9);
      g.closePath();
      break;
  }
}

/** A chunky resident. frame 0/1 = walk bob, look = -1 left, 0 front, 1 right, 2 back. */
export function drawCharacter(ch: Character, look: number, frame: number): HTMLCanvasElement {
  const W = 56, H = 64;
  const [c, g] = canvas(W, H);
  const bob = frame === 1 ? 2 : 0;
  const cx = W / 2;
  // shadow is drawn separately by the scene
  g.lineWidth = 3;
  g.strokeStyle = "#1a1026";
  g.lineJoin = "round";
  // feet
  g.fillStyle = "#2a2233";
  const step = frame === 1 ? 3 : -3;
  rrect(g, cx - 15, 54 - (frame === 1 ? 1 : 0), 12, 8, 4); g.fill(); g.stroke();
  rrect(g, cx + 3, 54 - (frame === 1 ? 0 : 1), 12, 8, 4); g.fill(); g.stroke();
  // body
  const bodyY = 30 + bob;
  const grad = g.createLinearGradient(0, bodyY, 0, bodyY + 26);
  grad.addColorStop(0, ch.colour);
  grad.addColorStop(1, ch.dark);
  g.fillStyle = grad;
  rrect(g, cx - 17, bodyY, 34, 26, 12); g.fill(); g.stroke();
  // arms
  g.fillStyle = ch.colour;
  const armSwing = frame === 1 ? step : -step;
  rrect(g, cx - 23, bodyY + 4 + armSwing * 0.4, 9, 15, 4.5); g.fill(); g.stroke();
  rrect(g, cx + 14, bodyY + 4 - armSwing * 0.4, 9, 15, 4.5); g.fill(); g.stroke();
  // chest symbol (not colour-only identification)
  if (look !== 2) {
    g.fillStyle = "#fff8ec";
    drawSymbol(g, ch.symbol, cx + look * 4, bodyY + 13, 6);
    g.fill();
    g.lineWidth = 1.6;
    g.stroke();
    g.lineWidth = 3;
  }
  // head
  const headY = 18 + bob;
  const hg = g.createRadialGradient(cx - 5, headY - 6, 3, cx, headY, 19);
  hg.addColorStop(0, "#ffe6cf");
  hg.addColorStop(1, "#f0b48c");
  g.fillStyle = hg;
  g.beginPath(); g.ellipse(cx, headY, 17, 15, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  // face
  if (look !== 2) {
    const ex = look * 5;
    g.fillStyle = "#1a1026";
    g.beginPath(); g.ellipse(cx - 6 + ex, headY + 1, 2.8, 3.8, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(cx + 6 + ex, headY + 1, 2.8, 3.8, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#fff";
    g.beginPath(); g.arc(cx - 5 + ex, headY - 0.5, 1, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(cx + 7 + ex, headY - 0.5, 1, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(255,110,110,0.45)";
    g.beginPath(); g.arc(cx - 11 + ex, headY + 6, 3, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(cx + 11 + ex, headY + 6, 3, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#1a1026"; g.lineWidth = 2;
    g.beginPath(); g.arc(cx + ex, headY + 6, 3.5, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
    g.lineWidth = 3;
  }
  drawHat(g, ch, cx, headY, look);
  return c;
}

function drawHat(g: CanvasRenderingContext2D, ch: Character, cx: number, hy: number, look: number) {
  g.strokeStyle = "#1a1026";
  g.lineWidth = 3;
  const dark = ch.dark, col = ch.colour, light = ch.light;
  switch (ch.hat) {
    case "beanie":
      g.fillStyle = col;
      g.beginPath(); g.ellipse(cx, hy - 7, 17, 12, 0, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = light; rrect(g, cx - 18, hy - 9, 36, 6, 3); g.fill(); g.stroke();
      g.fillStyle = "#fff8ec"; g.beginPath(); g.arc(cx, hy - 20, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
      break;
    case "cap":
      g.fillStyle = col;
      g.beginPath(); g.ellipse(cx, hy - 6, 17, 12, 0, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
      if (look !== 2) {
        g.fillStyle = dark;
        g.beginPath(); g.ellipse(cx + look * 10, hy - 6, 13, 4, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      break;
    case "bun":
      g.fillStyle = "#6b3a2a";
      g.beginPath(); g.ellipse(cx, hy - 6, 18, 11, 0, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.arc(cx, hy - 19, 7, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = col; rrect(g, cx - 7, hy - 15, 14, 4, 2); g.fill();
      break;
    case "visor":
      g.fillStyle = "#6b4a2a";
      g.beginPath(); g.ellipse(cx, hy - 7, 16, 10, 0, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = col; rrect(g, cx - 18, hy - 10, 36, 6, 3); g.fill(); g.stroke();
      if (look !== 2) { g.fillStyle = dark; g.beginPath(); g.ellipse(cx + look * 9, hy - 6, 12, 3.5, 0, 0, Math.PI * 2); g.fill(); g.stroke(); }
      break;
    case "mohawk":
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(cx - 8, hy - 10);
      for (let i = 0; i < 5; i++) { g.lineTo(cx - 8 + i * 4 + 2, hy - 26 + (i % 2) * 4); g.lineTo(cx - 8 + i * 4 + 4, hy - 12); }
      g.closePath(); g.fill(); g.stroke();
      break;
    case "hardhat":
      g.fillStyle = col;
      g.beginPath(); g.ellipse(cx, hy - 7, 16, 13, 0, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
      rrect(g, cx - 20, hy - 9, 40, 5, 2.5); g.fill(); g.stroke();
      g.fillStyle = light; rrect(g, cx - 2, hy - 19, 4, 10, 2); g.fill();
      break;
    case "headphones":
      g.fillStyle = "#3a2f4a";
      g.beginPath(); g.ellipse(cx, hy - 5, 17, 12, 0, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = "#1a1026"; g.lineWidth = 4;
      g.beginPath(); g.arc(cx, hy - 2, 19, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
      g.lineWidth = 3;
      g.fillStyle = col;
      rrect(g, cx - 22, hy - 6, 8, 13, 4); g.fill(); g.stroke();
      rrect(g, cx + 14, hy - 6, 8, 13, 4); g.fill(); g.stroke();
      break;
    case "bowler":
      g.fillStyle = "#2b2333";
      g.beginPath(); g.ellipse(cx, hy - 10, 20, 4.5, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.beginPath(); g.ellipse(cx, hy - 13, 12, 10, 0, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = col; rrect(g, cx - 12, hy - 15, 24, 4, 1.5); g.fill();
      break;
  }
}

export function drawFloor(variant: number): HTMLCanvasElement {
  const [c, g] = canvas(T, T);
  const rnd = noise(100 + variant);
  // paving slabs with a warm dusk tint, slightly varied
  g.fillStyle = variant % 2 ? "#7a7591" : "#726d89";
  g.fillRect(0, 0, T, T);
  g.fillStyle = "rgba(0,0,0,0.18)";
  g.fillRect(0, T - 2, T, 2);
  g.fillRect(T - 2, 0, 2, T);
  g.fillStyle = "rgba(255,255,255,0.05)";
  g.fillRect(0, 0, T, 2);
  g.fillRect(0, 0, 2, T);
  for (let i = 0; i < 7; i++) {
    g.fillStyle = `rgba(${rnd() > 0.5 ? "255,220,200" : "20,10,30"},${0.04 + rnd() * 0.05})`;
    g.fillRect(rnd() * T, rnd() * T, 2 + rnd() * 4, 2 + rnd() * 3);
  }
  return c;
}

/** Solid pillar: a brick block with a lit top face and a darker front face. */
export function drawPillar(edge: boolean): HTMLCanvasElement {
  const [c, g] = canvas(T, T + LIFT);
  const rnd = noise(edge ? 7 : 3);
  // front face
  g.fillStyle = edge ? "#3b2d4a" : "#465072";
  g.fillRect(0, T - LIFT, T, LIFT * 2);
  g.fillStyle = "rgba(0,0,0,0.22)";
  for (let y = T - LIFT + 6; y < T + LIFT; y += 9) g.fillRect(0, y, T, 1);
  // top face
  const top = g.createLinearGradient(0, 0, 0, T);
  if (edge) { top.addColorStop(0, "#6d5a8a"); top.addColorStop(1, "#56456f"); }
  else { top.addColorStop(0, "#9aa6c7"); top.addColorStop(1, "#7a86a8"); }
  g.fillStyle = top;
  g.fillRect(0, 0, T, T - LIFT + 2);
  if (edge) {
    // garden wall coping
    g.strokeStyle = "rgba(30,20,45,0.5)";
    g.lineWidth = 1.5;
    for (let row = 0; row < 3; row++) {
      const y = 3 + row * 11;
      g.beginPath(); g.moveTo(0, y + 10); g.lineTo(T, y + 10); g.stroke();
      for (let x = (row % 2) * 12; x < T; x += 24) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 10); g.stroke(); }
    }
  } else {
    // a solid slate pillar: bevelled stone with a rivet, clearly not breakable
    g.strokeStyle = "rgba(25,30,55,0.55)";
    g.lineWidth = 2;
    rrect(g, 4, 3, T - 8, T - LIFT - 6, 5); g.stroke();
    g.fillStyle = "rgba(255,255,255,0.18)";
    rrect(g, 7, 6, T - 14, 6, 3); g.fill();
    g.fillStyle = "#56607f";
    g.beginPath(); g.arc(T / 2, (T - LIFT) / 2 + 1, 4, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = "rgba(255,230,200,0.18)";
  g.fillRect(0, 0, T, 3);
  for (let i = 0; i < 5; i++) { g.fillStyle = `rgba(0,0,0,${0.06 + rnd() * 0.08})`; g.fillRect(rnd() * T, rnd() * (T - LIFT), 3, 2); }
  return c;
}

/** Breakable obstacles: crate, wheelie bin, post box, bench-planter. */
export function drawBreakable(kind: number): HTMLCanvasElement {
  const [c, g] = canvas(T, T + LIFT);
  g.lineWidth = 2.5;
  g.strokeStyle = "#24152c";
  if (kind === 0) {
    // wooden crate
    g.fillStyle = "#8a5a2b"; rrect(g, 4, T - LIFT - 2, T - 8, LIFT + 12, 3); g.fill(); g.stroke();
    g.fillStyle = "#c98d4a"; rrect(g, 4, 4, T - 8, T - LIFT - 2, 3); g.fill(); g.stroke();
    g.strokeStyle = "#7a4c22"; g.lineWidth = 3;
    g.beginPath(); g.moveTo(8, 8); g.lineTo(T - 8, T - LIFT - 4); g.moveTo(T - 8, 8); g.lineTo(8, T - LIFT - 4); g.stroke();
    g.strokeStyle = "#24152c"; g.lineWidth = 2.5; rrect(g, 4, 4, T - 8, T - LIFT - 2, 3); g.stroke();
    g.fillStyle = "rgba(255,230,180,0.25)"; g.fillRect(6, 6, T - 12, 3);
  } else if (kind === 1) {
    // wheelie bin
    g.fillStyle = "#2f7a4d"; rrect(g, 9, 10, T - 18, T - 4, 5); g.fill(); g.stroke();
    g.fillStyle = "#3e9a62"; rrect(g, 7, 4, T - 14, 12, 4); g.fill(); g.stroke();
    g.fillStyle = "rgba(255,255,255,0.15)"; g.fillRect(12, 20, 3, T - 20);
    g.fillStyle = "#1c1424"; g.beginPath(); g.arc(14, T + 6, 4, 0, Math.PI * 2); g.arc(T - 14, T + 6, 4, 0, Math.PI * 2); g.fill();
  } else if (kind === 2) {
    // post box
    g.fillStyle = "#c42b2b"; rrect(g, 11, 8, T - 22, T + 2, 9); g.fill(); g.stroke();
    g.fillStyle = "#8c1b1b"; rrect(g, 8, T - 4, T - 16, 10, 3); g.fill(); g.stroke();
    g.fillStyle = "#1a1026"; rrect(g, 16, 20, T - 32, 4, 2); g.fill();
    g.fillStyle = "#ffd77a"; g.font = "bold 9px sans-serif"; g.textAlign = "center"; g.fillText("POST", T / 2, 36);
    g.fillStyle = "rgba(255,255,255,0.2)"; g.fillRect(15, 12, 3, 20);
  } else {
    // planter with a shrub
    g.fillStyle = "#7d6a5a"; rrect(g, 5, T - LIFT, T - 10, LIFT + 10, 3); g.fill(); g.stroke();
    g.fillStyle = "#9c8672"; rrect(g, 5, T - LIFT - 6, T - 10, 8, 3); g.fill(); g.stroke();
    g.fillStyle = "#2e8a52";
    for (const [x, y, r] of [[16, 20, 11], [30, 18, 12], [23, 10, 10], [24, 24, 12]]) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = "#1a4d2e"; g.lineWidth = 2;
    g.beginPath(); g.arc(24, 18, 17, Math.PI * 0.9, Math.PI * 2.1); g.stroke();
    g.fillStyle = "#ff8fb0"; for (const [x, y] of [[18, 14], [30, 12], [26, 24]]) { g.beginPath(); g.arc(x, y, 2.4, 0, Math.PI * 2); g.fill(); }
  }
  return c;
}

/** Sudden-death block: a concrete barrier with hazard stripes. */
export function drawBarrier(): HTMLCanvasElement {
  const [c, g] = canvas(T, T + LIFT);
  g.fillStyle = "#4a4552"; g.fillRect(0, T - LIFT, T, LIFT * 2);
  g.fillStyle = "#8d8796"; g.fillRect(0, 0, T, T - LIFT + 2);
  g.save();
  g.beginPath(); g.rect(0, T - LIFT, T, LIFT * 2); g.clip();
  g.fillStyle = "#ffcc33";
  for (let x = -T; x < T * 2; x += 14) { g.beginPath(); g.moveTo(x, T + LIFT); g.lineTo(x + 7, T + LIFT); g.lineTo(x + 7 + LIFT * 2, T - LIFT); g.lineTo(x + LIFT * 2, T - LIFT); g.fill(); }
  g.restore();
  g.fillStyle = "rgba(255,255,255,0.15)"; g.fillRect(0, 0, T, 3);
  return c;
}

export function drawBomb(): HTMLCanvasElement {
  const [c, g] = canvas(T, T);
  const cx = T / 2, cy = T / 2 + 4;
  const grad = g.createRadialGradient(cx - 6, cy - 7, 2, cx, cy, 17);
  grad.addColorStop(0, "#5c5470");
  grad.addColorStop(0.6, "#25202f");
  grad.addColorStop(1, "#110d17");
  g.fillStyle = grad;
  g.beginPath(); g.arc(cx, cy, 16, 0, Math.PI * 2); g.fill();
  g.lineWidth = 2.5; g.strokeStyle = "#07050a"; g.stroke();
  g.fillStyle = "#3d3650"; rrect(g, cx - 5, cy - 21, 10, 7, 2); g.fill(); g.stroke();
  g.strokeStyle = "#c9a36a"; g.lineWidth = 3; g.lineCap = "round";
  g.beginPath(); g.moveTo(cx, cy - 21); g.quadraticCurveTo(cx + 6, cy - 29, cx + 11, cy - 26); g.stroke();
  g.fillStyle = "rgba(255,255,255,0.55)"; g.beginPath(); g.ellipse(cx - 6, cy - 7, 4, 2.5, -0.6, 0, Math.PI * 2); g.fill();
  return c;
}

/** Blast pieces: centre, horizontal, vertical and four end caps, white-hot core, orange edge. */
export function drawFlame(part: string): HTMLCanvasElement {
  const [c, g] = canvas(T, T);
  const m = T / 2;
  const layer = (w: number, colour: string) => {
    g.fillStyle = colour;
    g.beginPath();
    const r = w / 2;
    switch (part) {
      case "c": g.arc(m, m, r + 4, 0, Math.PI * 2); g.rect(0, m - r, T, w); g.rect(m - r, 0, w, T); break;
      case "h": g.rect(0, m - r, T, w); break;
      case "v": g.rect(m - r, 0, w, T); break;
      case "l": g.rect(m, m - r, m, w); g.arc(m, m, r, 0, Math.PI * 2); break;
      case "r": g.rect(0, m - r, m, w); g.arc(m, m, r, 0, Math.PI * 2); break;
      case "u": g.rect(m - r, m, w, m); g.arc(m, m, r, 0, Math.PI * 2); break;
      case "d": g.rect(m - r, 0, w, m); g.arc(m, m, r, 0, Math.PI * 2); break;
    }
    g.fill();
  };
  layer(T * 0.86, "rgba(255,70,30,0.85)");
  layer(T * 0.66, "#ff9a1f");
  layer(T * 0.44, "#ffe066");
  layer(T * 0.22, "#fffbe8");
  return c;
}

export function drawPowerUp(kind: PowerUp): HTMLCanvasElement {
  const [c, g] = canvas(T, T);
  const colours: Record<PowerUp, [string, string]> = {
    [PowerUp.BombUp]: ["#3a3a8c", "#6c6cf0"],
    [PowerUp.FireUp]: ["#a8301c", "#ff7a3d"],
    [PowerUp.SpeedUp]: ["#1d7a5a", "#3fe0a6"],
    [PowerUp.Kick]: ["#7a5a1d", "#ffc23d"],
  };
  const [dark, light] = colours[kind];
  const grad = g.createLinearGradient(0, 4, 0, T - 4);
  grad.addColorStop(0, light);
  grad.addColorStop(1, dark);
  g.fillStyle = grad;
  rrect(g, 5, 5, T - 10, T - 10, 9); g.fill();
  g.lineWidth = 3; g.strokeStyle = "#fff6e0"; g.stroke();
  g.fillStyle = "#fff6e0"; g.strokeStyle = "#1a1026"; g.lineWidth = 2;
  const m = T / 2;
  if (kind === PowerUp.BombUp) {
    g.fillStyle = "#1a1026"; g.beginPath(); g.arc(m - 3, m + 3, 9, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#ffe066"; g.lineWidth = 2.5; g.beginPath(); g.moveTo(m + 2, m - 5); g.quadraticCurveTo(m + 6, m - 11, m + 9, m - 9); g.stroke();
    g.fillStyle = "#fff6e0"; g.font = "bold 16px sans-serif"; g.textAlign = "center"; g.fillText("+", m + 11, m + 13);
  } else if (kind === PowerUp.FireUp) {
    g.fillStyle = "#ffe066";
    g.beginPath(); g.moveTo(m, m - 13); g.bezierCurveTo(m + 13, m - 2, m + 10, m + 12, m, m + 12); g.bezierCurveTo(m - 10, m + 12, m - 13, m - 2, m - 3, m - 6); g.bezierCurveTo(m - 3, m, m + 1, m + 2, m, m - 13); g.fill();
    g.fillStyle = "#fff6e0"; g.beginPath(); g.ellipse(m, m + 5, 4, 6, 0, 0, Math.PI * 2); g.fill();
  } else if (kind === PowerUp.SpeedUp) {
    // trainer
    g.fillStyle = "#fff6e0"; g.strokeStyle = "#1a1026";
    g.beginPath(); g.moveTo(m - 13, m + 8); g.lineTo(m - 11, m - 6); g.lineTo(m - 2, m - 6); g.lineTo(m + 2, m); g.lineTo(m + 13, m + 3); g.lineTo(m + 13, m + 8); g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = "#ff5f5f"; g.lineWidth = 2; g.beginPath(); g.moveTo(m - 9, m + 2); g.lineTo(m + 9, m + 4); g.stroke();
    g.strokeStyle = "#fff6e0"; g.lineWidth = 2; for (const y of [-8, -3, 2]) { g.beginPath(); g.moveTo(m - 22, m + y); g.lineTo(m - 15, m + y); g.stroke(); }
  } else {
    // boot kicking a ball
    g.fillStyle = "#fff6e0"; g.strokeStyle = "#1a1026";
    g.beginPath(); g.moveTo(m - 12, m - 12); g.lineTo(m - 4, m - 12); g.lineTo(m - 4, m + 2); g.lineTo(m + 6, m + 4); g.lineTo(m + 6, m + 10); g.lineTo(m - 12, m + 10); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = "#1a1026"; g.beginPath(); g.arc(m + 12, m - 2, 5, 0, Math.PI * 2); g.fill();
  }
  return c;
}

/** Small soft particle for sparks, smoke and dust. */
export function drawDot(colour: string, r: number): HTMLCanvasElement {
  const [c, g] = canvas(r * 2, r * 2);
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, colour);
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, r * 2, r * 2);
  return c;
}

export function drawShard(colour: string): HTMLCanvasElement {
  const [c, g] = canvas(10, 8);
  g.fillStyle = colour;
  g.beginPath(); g.moveTo(0, 2); g.lineTo(9, 0); g.lineTo(7, 7); g.lineTo(2, 8); g.closePath(); g.fill();
  return c;
}

/**
 * The neighbourhood around the arena: a dusk sky, a row of houses and shops along the top
 * (windows lit, neon signs), and pavements down the sides. Window and neon glow are separate
 * layers so the scene can animate them gently.
 */
export function drawBackdrop(width: number, height: number, top: number, seed: number) {
  const [c, g] = canvas(width, height);
  const rnd = noise(seed);
  const sky = g.createLinearGradient(0, 0, 0, top + 40);
  sky.addColorStop(0, "#2b1d5c");
  sky.addColorStop(0.55, "#7a3d7a");
  sky.addColorStop(1, "#f08a5d");
  g.fillStyle = sky;
  g.fillRect(0, 0, width, top + 40);
  // stars
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(255,240,220,${0.3 + rnd() * 0.5})`;
    g.fillRect(rnd() * width, rnd() * top * 0.45, 1.5, 1.5);
  }
  // street below
  g.fillStyle = "#2d2a3d";
  g.fillRect(0, top - 6, width, height - top + 6);
  g.fillStyle = "#3a3650";
  g.fillRect(0, top - 6, width, 8);

  const windows: { x: number; y: number; w: number; h: number }[] = [];
  const neons: { x: number; y: number; text: string; colour: string }[] = [];
  const signs = [["PIZZA", "#ff4fa0"], ["ARCADE", "#4dd9ff"], ["LAUNDRY", "#9dff5a"], ["CAFÉ", "#ffcf4d"], ["24/7", "#ff6a4d"], ["BAKERY", "#ff9de0"], ["TAXI", "#ffe14d"]];
  let x = -10;
  let k = 0;
  const palette = ["#f2a65a", "#e9c46a", "#8ab17d", "#e76f51", "#7d8cc4", "#d4a5a5", "#a3c4bc", "#c97b84"];
  while (x < width) {
    const bw = 70 + Math.floor(rnd() * 60);
    const bh = 50 + Math.floor(rnd() * (top - 60));
    const by = top - bh;
    const col = palette[Math.floor(rnd() * palette.length)];
    // house body, darkened for dusk
    g.fillStyle = col;
    g.fillRect(x, by, bw, bh);
    g.fillStyle = "rgba(30,15,60,0.45)";
    g.fillRect(x, by, bw, bh);
    // roof
    g.fillStyle = "#3a2440";
    if (rnd() < 0.6) { g.beginPath(); g.moveTo(x - 4, by); g.lineTo(x + bw / 2, by - 22 - rnd() * 10); g.lineTo(x + bw + 4, by); g.fill(); }
    else { g.fillRect(x - 3, by - 6, bw + 6, 7); }
    // windows
    for (let wy = by + 10; wy < top - 26; wy += 22)
      for (let wx = x + 8; wx < x + bw - 16; wx += 20) {
        const lit = rnd() < 0.62;
        g.fillStyle = lit ? "#ffd27a" : "#2a2140";
        g.fillRect(wx, wy, 11, 13);
        if (lit) windows.push({ x: wx, y: wy, w: 11, h: 13 });
        g.fillStyle = "rgba(40,20,60,0.6)";
        g.fillRect(wx + 5, wy, 1, 13);
      }
    // shopfront with neon on some buildings
    if (k % 2 === 0) {
      const [text, colour] = signs[Math.floor(rnd() * signs.length)];
      neons.push({ x: x + bw / 2, y: top - 30, text, colour });
      g.fillStyle = "rgba(255,200,120,0.25)";
      g.fillRect(x + 6, top - 20, bw - 12, 14);
    }
    x += bw + 2;
    k++;
  }
  // pavement kerb and street lamps
  g.fillStyle = "#4b4560";
  g.fillRect(0, top - 2, width, 4);
  const lamps: { x: number; y: number }[] = [];
  for (let lx = 40; lx < width; lx += 180) {
    g.fillStyle = "#1e1a2a";
    g.fillRect(lx, top - 58, 4, 56);
    g.fillRect(lx - 6, top - 60, 16, 4);
    lamps.push({ x: lx + 2, y: top - 56 });
  }
  return { canvas: c, windows, neons, lamps };
}
