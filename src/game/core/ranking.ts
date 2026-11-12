import { BOTS, PLAYER, botVillages, rivalInfo } from "./world";
import type { Village } from "./types";

/** What a player has done. Yours is recorded exactly; a bot's is an estimate of its off-screen life PLUS every real event with you. */
export interface Stats {
  kills: number;
  lost: number;
  looted: number;
  sent: number;
}
export const emptyStats = (): Stats => ({
  kills: 0,
  lost: 0,
  looted: 0,
  sent: 0,
});
export const addStats = (a: Stats | undefined, d: Partial<Stats>): Stats => {
  const s = a ?? emptyStats();
  return {
    kills: s.kills + (d.kills ?? 0),
    lost: s.lost + (d.lost ?? 0),
    looted: s.looted + (d.looted ?? 0),
    sent: s.sent + (d.sent ?? 0),
  };
};

export interface Row {
  name: string;
  you: boolean;
  nemesis: boolean;
  color: string;
  doctrine?: string;
  villages: number;
  points: number;
  kills: number;
  lost: number;
  looted: number;
  sent: number;
  home?: [number, number];
  eliminated?: boolean;
}

/** The world's leaderboard: you and all 100 bots. Every number is REAL: it comes from battles, loot and caravans that actually happened. */
export function buildRanking(
  world: Record<string, Village>,
  stats: Record<string, Stats>,
  now: number,
): Row[] {
  const rows: Row[] = [];
  const mine = Object.values(world).filter((v) => v.owner === PLAYER);
  const ys = stats[PLAYER] ?? emptyStats();
  rows.push({
    name: `${PLAYER} (you)`,
    you: true,
    nemesis: false,
    color: "#3b82f6",
    villages: mine.length,
    points: mine.reduce((s, v) => s + v.points, 0),
    kills: ys.kills,
    lost: ys.lost,
    looted: ys.looted,
    sent: ys.sent,
    home: mine[0] ? [mine[0].x, mine[0].y] : undefined,
  });
  for (const b of BOTS) {
    const vs = botVillages(b, world, now);
    const st = stats[b.name] ?? emptyStats();
    rows.push({
      name: b.name,
      you: false,
      nemesis: !!rivalInfo(b.name)?.nemesis,
      color: b.color,
      doctrine: b.doctrine,
      home: b.home,
      eliminated: vs.length === 0,
      villages: vs.length,
      points: vs.reduce((s, v) => s + v.points, 0),
      kills: st.kills,
      lost: st.lost,
      looted: st.looted,
      sent: st.sent,
    });
  }
  return rows;
}
