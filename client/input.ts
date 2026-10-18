// Keyboard and touch input, turned into the simulation's Input (a direction + a bomb press).
// The most recently pressed direction wins while several are held, which feels right for
// grid games. Browser scrolling is only suppressed while a match is actually running.

import { Dir } from "../shared/constants.js";
import type { Input } from "../shared/sim.js";

export interface KeyMap { up: string[]; down: string[]; left: string[]; right: string[]; bomb: string[] }

export const KEYS_P1_SOLO: KeyMap = {
  up: ["KeyW", "ArrowUp"], down: ["KeyS", "ArrowDown"], left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"], bomb: ["Space", "Enter", "KeyJ"],
};
export const KEYS_P1_LOCAL: KeyMap = { up: ["KeyW"], down: ["KeyS"], left: ["KeyA"], right: ["KeyD"], bomb: ["Space"] };
export const KEYS_P2_LOCAL: KeyMap = { up: ["ArrowUp"], down: ["ArrowDown"], left: ["ArrowLeft"], right: ["ArrowRight"], bomb: ["Enter", "NumpadEnter"] };

export class InputSource {
  private held: Dir[] = [];
  private bombQueued = false;
  touchDir: Dir = Dir.None;

  /** Read and clear: one bomb press is used once. */
  take(): Input {
    const dir = this.touchDir !== Dir.None ? this.touchDir : this.held[this.held.length - 1] ?? Dir.None;
    const bomb = this.bombQueued;
    this.bombQueued = false;
    return { dir, bomb };
  }

  peekDir(): Dir {
    return this.touchDir !== Dir.None ? this.touchDir : this.held[this.held.length - 1] ?? Dir.None;
  }

  press(d: Dir) { this.held = this.held.filter((x) => x !== d); this.held.push(d); }
  release(d: Dir) { this.held = this.held.filter((x) => x !== d); }
  bomb() { this.bombQueued = true; }
  reset() { this.held = []; this.bombQueued = false; this.touchDir = Dir.None; }
}

interface Binding { source: InputSource; map: KeyMap }

class Keyboard {
  private bindings: Binding[] = [];
  active = false; // true while a match wants the keys (blocks page scrolling)

  constructor() {
    window.addEventListener("keydown", (e) => this.key(e, true), { passive: false });
    window.addEventListener("keyup", (e) => this.key(e, false));
    window.addEventListener("blur", () => this.bindings.forEach((b) => b.source.reset()));
  }

  bind(list: Binding[]) {
    this.bindings = list;
    list.forEach((b) => b.source.reset());
  }

  private key(e: KeyboardEvent, down: boolean) {
    if (!this.active) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    let used = false;
    for (const { source, map } of this.bindings) {
      const d = map.up.includes(e.code) ? Dir.Up : map.down.includes(e.code) ? Dir.Down : map.left.includes(e.code) ? Dir.Left : map.right.includes(e.code) ? Dir.Right : Dir.None;
      if (d !== Dir.None) { if (down) source.press(d); else source.release(d); used = true; }
      if (map.bomb.includes(e.code)) { if (down && !e.repeat) source.bomb(); used = true; }
    }
    if (used) e.preventDefault();
  }
}

export const keyboard = new Keyboard();

/**
 * Touch D-pad: one finger anywhere on the pad steers, and sliding between directions works
 * without lifting. The bomb button fires on touch start for responsiveness.
 */
export function attachTouchControls(pad: HTMLElement, bombBtn: HTMLElement, getSource: () => InputSource | null): void {
  let padPointer = -1;
  const setFrom = (e: PointerEvent) => {
    const src = getSource();
    if (!src) return;
    const r = pad.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const dead = r.width * 0.12;
    let d = Dir.None;
    if (Math.hypot(dx, dy) > dead) d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? Dir.Right : Dir.Left) : dy > 0 ? Dir.Down : Dir.Up;
    if (d !== src.touchDir) {
      src.touchDir = d;
      pad.dataset.dir = ["", "up", "down", "left", "right"][d];
      if (d !== Dir.None && navigator.vibrate) navigator.vibrate(6);
    }
  };
  pad.addEventListener("pointerdown", (e) => { padPointer = e.pointerId; pad.setPointerCapture(e.pointerId); setFrom(e); e.preventDefault(); });
  pad.addEventListener("pointermove", (e) => { if (e.pointerId === padPointer) setFrom(e); });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== padPointer) return;
    padPointer = -1;
    const src = getSource();
    if (src) src.touchDir = Dir.None;
    pad.dataset.dir = "";
  };
  pad.addEventListener("pointerup", end);
  pad.addEventListener("pointercancel", end);
  bombBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    getSource()?.bomb();
    bombBtn.classList.add("pressed");
    if (navigator.vibrate) navigator.vibrate(12);
  });
  const up = () => bombBtn.classList.remove("pressed");
  bombBtn.addEventListener("pointerup", up);
  bombBtn.addEventListener("pointercancel", up);
  bombBtn.addEventListener("pointerleave", up);
}
