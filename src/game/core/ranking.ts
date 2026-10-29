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

/**
 * false = a bot's numbers are only what really happened: its marches and battles (they are counted when the armies land).
 * true  = on top of that, a made-up estimate of off-screen farming and trading is added (see botBaseline).
 */
const SIMULATED_ACTIVITY = false;

/** Bots farm barbarians and trade among themselves while you are not looking: a deterministic estimate that grows with the world's age and their growth rate. */
export const botBaseline = (
  growth: number,
  ageHours: number,
  villageCount: number,
): Stats => {
  if (!SIMULATED_ACTIVITY) return emptyStats();
  const a = Math.pow(Math.floor(Math.max(0, ageHours)), 1.12) * growth;
  return {
    kills: Math.floor(a * 6),
    lost: Math.floor(a * 2.5),
    looted: Math.floor(a * 900),
    sent: villageCount >= 2 ? Math.floor(a * 700) : 0,
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

/** The world's leaderboard: you and all 100 bots. */
export function buildRanking(
  world: Record<string, Village>,
  stats: Record<string, Stats>,
  ageHours: number,
  now: number,
  rivals: Record<string, { bornAge?: number; banked?: Stats }> = {},
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
    // Lifetime record = the lives it has already lived (banked when it was wiped out) + the current life, which only counts while it owns a village.
    const rs = rivals[b.id];
    const alive = vs.length > 0;
    const now1 = alive
      ? botBaseline(b.growth, ageHours - (rs?.bornAge ?? 0), vs.length)
      : emptyStats();
    const real = stats[b.name] ?? emptyStats();
    const old = rs?.banked ?? emptyStats();
    rows.push({
      name: b.name,
      you: false,
      nemesis: !!rivalInfo(b.name)?.nemesis,
      color: b.color,
      doctrine: b.doctrine,
      home: b.home,
      eliminated: !alive,
      villages: vs.length,
      points: vs.reduce((s, v) => s + v.points, 0),
      kills: now1.kills + old.kills + real.kills,
      lost: now1.lost + old.lost + real.lost,
      looted: now1.looted + old.looted + real.looted,
      sent: now1.sent + old.sent + real.sent,
    });
  }
  return rows;
}
