// Talks to the small introductions script (games-api/blast-signal.php) that lets two
// browsers find each other. Only connection details pass through it, never gameplay.

export const SIGNAL_URL: string = (import.meta.env.VITE_SIGNAL_URL as string | undefined) || "https://hosthobbit.com/games-api/blast-signal.php";

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export async function signal<T = Record<string, unknown>>(body: object): Promise<T> {
  let res: Response;
  try {
    // text/plain keeps this a "simple" request (no CORS preflight round trip)
    res = await fetch(SIGNAL_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Couldn't reach the room service. Check your internet connection.");
  }
  let data: Record<string, unknown>;
  try { data = await res.json(); } catch { throw new Error("The room service sent something odd back."); }
  if (!res.ok || data.ok === false) {
    const e = String(data.error ?? res.status);
    if (e === "room_not_found") throw new Error("No room with that code. Check it, or ask your friend for a fresh link.");
    if (e === "slow down") throw new Error("Too many attempts. Wait a minute and try again.");
    throw new Error(`Room service error: ${e}`);
  }
  return data as T;
}

/** Wait until the connection has gathered its network addresses (no trickle ICE: one message each way). */
export function iceGathered(pc: RTCPeerConnection, maxMs = 3000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener("icegatheringstatechange", check); clearTimeout(timer); resolve(); };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    const timer = setTimeout(done, maxMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}
