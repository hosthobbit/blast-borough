// Public Daily Challenge leaderboard (signal/blast-scores.php, live on hosthobbit.com).

export const SCORES_URL: string = (import.meta.env.VITE_SCORES_URL as string | undefined) || "https://hosthobbit.com/games-api/blast-scores.php";

export interface BoardEntry { name: string; score: number; won: boolean; kills: number; crates: number; seconds: number; date?: string }

export async function fetchBoard(which: { date: string } | { all: true }): Promise<BoardEntry[]> {
  const q = "all" in which ? "all=1&top=20" : `date=${which.date}&top=20`;
  let res: Response;
  try { res = await fetch(`${SCORES_URL}?${q}`); } catch { throw new Error("Couldn't reach the leaderboard. Check your connection."); }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !Array.isArray(data.scores)) throw new Error("The leaderboard isn't available right now.");
  return data.scores;
}

export interface Submission { name: string; date: string; won: boolean; kills: number; crates: number; pickups: number; seconds: number; score: number }

export async function submitDaily(s: Submission): Promise<{ rank: number; best: boolean; score: number }> {
  const body = new URLSearchParams({
    name: s.name, date: s.date, won: s.won ? "1" : "0", kills: String(s.kills), crates: String(s.crates),
    pickups: String(s.pickups), seconds: String(s.seconds), score: String(s.score),
  });
  let res: Response;
  try { res = await fetch(SCORES_URL, { method: "POST", body }); } catch { throw new Error("Couldn't reach the leaderboard. Check your connection."); }
  const data = await res.json().catch(() => null);
  if (!data || data.ok === false) throw new Error(data?.error ?? "The leaderboard isn't available right now.");
  return data;
}
