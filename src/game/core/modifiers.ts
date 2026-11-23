import type { Village } from "./types";

/**
 * World rules that change a battle's strength, each switchable in New game:
 *  - MORALE (a protection for small players): an attack on a MUCH smaller player counts for less than its full strength. The support
 *    page of the original says it is calculated from the points of attacker and defender, is 100% unless the defender is much smaller,
 *    never gives a bonus, and for a small player who stays small it rises with time up to 50%. It does not publish the formula, so this is
 *    an approximation: 0.3 + defender points / attacker points, between a floor (30%, rising to 50% as the world ages) and 100%.
 *  - NIGHT BONUS: while it is night in the world's clock, defenders fight with double strength (original: usually midnight to 8 am; it does
 *    not apply to barbarian villages). The clock runs on game time, so at x60 a whole day is 24 real minutes.
 */
export const MORALE_BASE = 0.3;
export const MORALE_FLOOR_START = 0.3;
export const MORALE_FLOOR_MAX = 0.5;
export const MORALE_FLOOR_HOURS = 1000; // game hours for the floor to climb from 30% to 50%
export const NIGHT = { from: 0, to: 8, mult: 2 };
export const START_HOUR = 12; // a new world starts at noon

export function moraleFor(
  attPoints: number,
  defPoints: number,
  ageHours: number,
): number {
  if (attPoints <= 0 || defPoints >= attPoints) return 1;
  const floor = Math.min(
    MORALE_FLOOR_MAX,
    MORALE_FLOOR_START +
      ((MORALE_FLOOR_MAX - MORALE_FLOOR_START) * ageHours) / MORALE_FLOOR_HOURS,
  );
  return Math.max(floor, Math.min(1, MORALE_BASE + defPoints / attPoints));
}
export const gameHourAt = (ageHours: number) =>
  (((START_HOUR + ageHours) % 24) + 24) % 24;
export const isNightAt = (ageHours: number) => {
  const h = gameHourAt(ageHours);
  return h >= NIGHT.from && h < NIGHT.to;
};

/** All the points of one owner (a player's or a bot's villages together). */
export function pointsOf(
  villages: Record<string, Village>,
  owner: string | null,
): number {
  if (owner === null) return 0;
  let n = 0;
  for (const v of Object.values(villages)) if (v.owner === owner) n += v.points;
  return n;
}
