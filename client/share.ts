// Sharing and the Host Hobbit credit. Sharing is always optional and never blocks play
// (Facebook's rules forbid requiring or rewarding shares). Once someone has shared, we stop
// suggesting it.

import { storageGet, storageSet } from "./settings.js";

export const GAME_URL = "https://hosthobbit.github.io/blast-borough/";
export const HOST_URL = "https://hosthobbit.com/?utm_source=blast-borough&utm_medium=game";
export const HOST_FACEBOOK = "https://www.facebook.com/hosthobbit";

const SHARED_KEY = "bb.shared";
const NUDGE_KEY = "bb.shareNudges";

export const hasShared = () => storageGet(SHARED_KEY, false);
const markShared = () => storageSet(SHARED_KEY, true);

const enc = encodeURIComponent;

/** The share buttons, ready to drop into a panel. `text` is the message people post. */
export function shareRow(text: string, opts: { label?: string } = {}): string {
  const url = GAME_URL;
  const links = [
    ["facebook", "Facebook", `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}&quote=${enc(text)}`],
    ["whatsapp", "WhatsApp", `https://wa.me/?text=${enc(`${text} ${url}`)}`],
    ["x", "X", `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`],
  ];
  return `<div class="share" data-share-text="${text.replace(/"/g, "&quot;")}">
    ${opts.label ? `<span class="share-label">${opts.label}</span>` : ""}
    ${"share" in navigator ? `<button type="button" class="share-btn native" data-share-native>Share…</button>` : ""}
    ${links.map(([k, name, href]) => `<a class="share-btn ${k}" href="${href}" target="_blank" rel="noopener" data-share-link>${name}</a>`).join("")}
    <button type="button" class="share-btn copy" data-share-copy>Copy link</button>
  </div>`;
}

/** Wire up any share rows inside `root`. */
export function wireShare(root: HTMLElement, toast: (t: string) => void): void {
  root.querySelectorAll<HTMLElement>(".share").forEach((row) => {
    const text = row.dataset.shareText ?? "";
    row.querySelectorAll("[data-share-link]").forEach((a) => a.addEventListener("click", () => { markShared(); }));
    row.querySelector("[data-share-native]")?.addEventListener("click", async () => {
      try {
        await navigator.share({ title: "Blast Borough", text, url: GAME_URL });
        markShared();
        toast("Thanks for sharing!");
      } catch { /* cancelled */ }
    });
    row.querySelector("[data-share-copy]")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(GAME_URL); markShared(); toast("Link copied: paste it anywhere!"); }
      catch { prompt("Copy the game link:", GAME_URL); markShared(); }
    });
  });
}

/** "Developed by Host Hobbit" with a link to the site. */
export function credit(): string {
  return `<div class="credit">Developed by <a href="${HOST_URL}" target="_blank" rel="noopener">Host Hobbit</a> · <a href="${HOST_FACEBOOK}" target="_blank" rel="noopener">Follow us on Facebook</a></div>`;
}

/**
 * Whether to show the friendly "share it" card on the title screen: only after someone has
 * finished a match, only until they've shared, and at most three times.
 */
export function shouldNudge(): boolean {
  if (hasShared()) return false;
  if (!storageGet("bb.playedMatch", false)) return false;
  return storageGet(NUDGE_KEY, 0) < 3;
}

export function nudged(): void {
  storageSet(NUDGE_KEY, storageGet(NUDGE_KEY, 0) + 1);
}

export function notePlayedMatch(): void {
  storageSet("bb.playedMatch", true);
}
