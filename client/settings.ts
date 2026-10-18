// Player settings, saved in localStorage. Reads and writes are wrapped: private windows and
// blocked storage must never break the game.

export interface Settings {
  music: number;          // 0..1
  sfx: number;            // 0..1
  reducedMotion: boolean;
  screenShake: boolean;
  nickname: string;
}

const KEY = "blastborough.settings.v1";

function defaults(): Settings {
  const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return { music: 0.6, sfx: 0.8, reducedMotion: reduce, screenShake: !reduce, nickname: "" };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults(), ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return defaults();
}

export const settings: Settings = load();

export function saveSettings(): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

export function storageGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function storageSet(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
