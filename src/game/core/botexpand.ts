// core/botexpand.ts
// Two things that kept the bots from expanding once they had a few villages:
//  1. the barbarian search only ever looked at the 8 nearest barbarian villages to a bot's strongest village, and remembered
//     them; once those 8 were taken (by anybody) the bot saw NO barbarian village any more, however many were left further out;
//  2. the bot attacked from its strongest village even when that one had no Academy, so it could only raid, never conquer.
import { RES } from "./economy";
import { NOBLES_PER_RUN, botCanNoble, botNobleCost } from "./botwar";
import { nearestBarbarians } from "./world";
import type { Village } from "./types";

/** How far from its strike village a bot looks for barbarian villages: it grows with the size of its empire (40 fields for a small bot). */
export const barbReach = (villageCount: number) =>
  100 + 6 * Math.sqrt(Math.max(0, villageCount));

const CACHE = new Map<string, { at: number; n: number; list: Village[] }>();
const TTL_MS = 120_000; // searching the map is slow (about 7 ms), so a result is kept for 2 minutes

/** The `n` natural barbarian villages nearest to a point (taken or not), nearest first. */
function around(from: [number, number], now: number, n: number): Village[] {
  const key = `${from[0]}|${from[1]}`;
  const c = CACHE.get(key);
  if (c && now - c.at < TTL_MS && c.n >= n) return c.list.slice(0, n);
  const list = nearestBarbarians(from, now, n);
  CACHE.set(key, { at: now, n, list });
  if (CACHE.size > 3000) CACHE.clear();
  return list;
}

/**
 * Up to `want` barbarian villages within `reach` fields of `from` that nobody owns, nearest first. When the nearest ones are
 * already taken it looks further out (16, 32, 64, 128 villages), so a growing empire keeps finding new targets.
 */
export function freeBarbarians(
  from: [number, number],
  world: Record<string, Village>,
  now: number,
  reach: number,
  want = 3,
): Village[] {
  let n = 16;
  for (;;) {
    const list = around(from, now, n);
    const free: Village[] = [];
    for (const b0 of list) {
      const b = world[b0.id] ?? b0; // the live copy: someone may have conquered it
      if (b.owner !== null) continue;
      if (Math.hypot(b.x - from[0], b.y - from[1]) > reach) continue;
      free.push(b);
      if (free.length >= want) return free;
    }
    const last = list[list.length - 1];
    const exhausted = list.length < n; // the map has no more
    const beyondReach =
      !!last && Math.hypot(last.x - from[0], last.y - from[1]) > reach; // sorted by distance: nothing more is in reach
    if (exhausted || beyondReach || n >= 128) return free;
    n *= 2;
  }
}

/**
 * The village a bot attacks from: its strongest strike village, UNLESS another village can really send nobles (Academy and the
 * nobles paid for) and is not much weaker, because only that one can conquer.
 */
export function pickSource(
  mine: Village[],
  strikePower: (v: Village) => number,
): Village {
  const strongest = mine.reduce((b, v) =>
    strikePower(v) > strikePower(b) ? v : b,
  );
  const canNobleAt = (v: Village) =>
    botCanNoble(v) &&
    RES.every((r) => v.resources[r] >= (NOBLES_PER_RUN - 1) * botNobleCost(r));
  const noblers = mine.filter(canNobleAt);
  if (!noblers.length) return strongest;
  const nobler = noblers.reduce((b, v) =>
    strikePower(v) > strikePower(b) ? v : b,
  );
  return strikePower(nobler) >= 0.6 * strikePower(strongest)
    ? nobler
    : strongest;
}
