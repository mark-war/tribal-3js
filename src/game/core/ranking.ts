import { BOTS, PLAYER, botVillages, rivalInfo } from "./world";
import type { Village } from "./types";

/** What a player has done. Yours is recorded exactly; a bot's is real events (its marches and battles) plus an optional simulated estimate. */
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

/**
 * Optional estimate of what a bot does off-screen. It moves once per whole game hour (not every second), and a bot
 * only "sends resources" once it owns at least two villages to send them between.
 */
export const botBaseline = (
  growth: number,
  ageHours: number,
  villageCount = 2, // the new rivals.ts calls it with two arguments
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
  rivals: Record<string, { frozenAge?: number }> = {},
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
    const base = botBaseline(
      b.growth,
      Math.min(ageHours, rivals[b.id]?.frozenAge ?? Infinity),
      vs.length,
    );
    const real = stats[b.name] ?? emptyStats(); // a bot that is out of the game stops earning
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
      kills: base.kills + real.kills,
      lost: base.lost + real.lost,
      looted: base.looted + real.looted,
      sent: base.sent + real.sent,
    });
  }
  return rows;
}
