// core/rally.ts
// A rally: one of your villages (the host) opens it against a target with a timer, a cap on villages and a cap on troops.
// Your other villages send troops to the host before the timer runs out; when it does, everything that arrived leaves the
// host as ONE army and fights ONE battle. Survivors and loot walk back to the villages they came from, shared by troops sent.
import { UNIT_IDS } from "../config/units";
import { emptyUnits } from "./combat";
import { SPEED } from "./economy";
import type { BuildingId, Cost, Units, Village } from "./types";

/** Real-time durations (ignores game SPEED). */
export const RALLY_TIMERS_MS = {
  "30s": 30_000,
  "1m": 60_000,
  "2m": 120_000,
  "5m": 300_000,
  "10m": 600_000,
} as const;

export type RallyTimerKey = keyof typeof RALLY_TIMERS_MS;

export interface RallyJoin {
  villageId: string;
  units: Units;
}
export interface Rally {
  id: string;
  hostId: string;
  targetId: string;
  targetXY: [number, number];
  createdAt: number;
  startsAt: number; // when the combined army leaves
  maxParticipants: number; // villages, the host included
  maxTroops: number; // units (all counted one by one)
  joins: RallyJoin[]; // troops already waiting in the host village (the host first)
  pending: RallyJoin[]; // troops still marching to the host
  catTarget?: BuildingId;
}

export const rallyTimerMs = (key: RallyTimerKey | number) => {
  if (typeof key === "string" && key in RALLY_TIMERS_MS) {
    return RALLY_TIMERS_MS[key as RallyTimerKey];
  }
  // fallback for old numeric calls
  return Math.max(30_000, Number(key) || 30_000);
};

export const troopCount = (u: Units) =>
  UNIT_IDS.reduce((n, k) => n + (u[k] ?? 0), 0);
export const sumUnits = (list: Units[]): Units => {
  const o = emptyUnits();
  for (const u of list) for (const k of UNIT_IDS) o[k] += u[k] ?? 0;
  return o;
};
export const rallyTroops = (r: Rally) =>
  [...r.joins, ...r.pending].reduce((n, j) => n + troopCount(j.units), 0);
export const rallyParticipants = (r: Rally) =>
  new Set([...r.joins, ...r.pending].map((j) => j.villageId)).size;

/** Why `units` from `villageId` cannot join the rally right now, or null if they can. `travelMs` is how long they would march. */
export function joinProblem(
  r: Rally,
  villageId: string,
  units: Units,
  travelMs: number,
  now: number,
): string | null {
  if (now >= r.startsAt) return "That rally has already left.";
  if ((units.noble ?? 0) > 0) return "Nobles cannot join a rally.";
  const n = troopCount(units);
  if (n < 1) return "Choose some troops to send.";
  if ([...r.joins, ...r.pending].some((j) => j.villageId === villageId))
    return "That village has already joined this rally.";
  if (rallyParticipants(r) >= r.maxParticipants)
    return `The rally is full (${r.maxParticipants} villages).`;
  if (rallyTroops(r) + n > r.maxTroops)
    return `Too many troops: the rally takes ${r.maxTroops} and has ${rallyTroops(r)} already, so at most ${Math.max(0, r.maxTroops - rallyTroops(r))} more.`;
  if (now + travelMs > r.startsAt) {
    const left = Math.max(0, Math.round((r.startsAt - now) / 1000));
    return `Your troops would arrive after the rally leaves (they need ${Math.ceil(travelMs / 1000)}s, the rally leaves in ${left}s).`;
  }
  return null;
}

/**
 * Pulls what the rally has out of the host village: for each participant, the units that are really still standing there
 * (troops standing in the host can die defending it, so the rally leaves with what survived). Returns the host without
 * them, and who gave what.
 */
export function collectRally(host: Village, r: Rally) {
  const stationed = { ...host.stationed };
  const taken: RallyJoin[] = [];
  for (const j of r.joins) {
    const stack = stationed[j.villageId] ?? emptyUnits();
    const take = emptyUnits();
    const rest = emptyUnits();
    for (const u of UNIT_IDS) {
      take[u] = Math.min(stack[u] ?? 0, j.units[u] ?? 0);
      rest[u] = (stack[u] ?? 0) - take[u];
    }
    if (UNIT_IDS.some((u) => rest[u] > 0)) stationed[j.villageId] = rest;
    else delete stationed[j.villageId];
    if (troopCount(take) > 0)
      taken.push({ villageId: j.villageId, units: take });
  }
  return { host: { ...host, stationed }, taken };
}

/** Shares the survivors of the combined army among the villages that sent it, unit type by unit type, in proportion to what each sent. */
export function splitSurvivors(
  survivors: Units,
  sent: Units,
  joins: RallyJoin[],
): Units[] {
  const out = joins.map(() => emptyUnits());
  for (const u of UNIT_IDS) {
    let left = survivors[u] ?? 0;
    if (left <= 0 || (sent[u] ?? 0) <= 0) continue;
    joins.forEach((j, i) => {
      const share = Math.min(
        left,
        Math.floor(((survivors[u] ?? 0) * (j.units[u] ?? 0)) / sent[u]),
      );
      out[i][u] += share;
      left -= share;
    });
    const senders = joins
      .map((j, i) => (j.units[u] > 0 ? i : -1))
      .filter((i) => i >= 0);
    for (let k = 0; left > 0 && senders.length; k++, left--)
      out[senders[k % senders.length]][u]++; // the rounding remainder
  }
  return out;
}

/** Shares the loot among the villages in proportion to the troops each sent. */
export function splitLoot(loot: Cost, joins: RallyJoin[]): Cost[] {
  const total = joins.reduce((n, j) => n + troopCount(j.units), 0) || 1;
  const out = joins.map((j) => {
    const f = troopCount(j.units) / total;
    return {
      wood: Math.floor(loot.wood * f),
      clay: Math.floor(loot.clay * f),
      iron: Math.floor(loot.iron * f),
    };
  });
  for (const r of ["wood", "clay", "iron"] as const) {
    const given = out.reduce((n, c) => n + c[r], 0);
    if (out.length) out[0][r] += loot[r] - given; // the remainder goes to the first (the host)
  }
  return out;
}
