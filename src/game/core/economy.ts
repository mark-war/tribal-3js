import { BUILDINGS, RESOURCE_BUILDING } from "../config/buildings";
import { UNITS, UNIT_IDS } from "../config/units";
import type {
  BuildingId,
  Command,
  Cost,
  UnitId,
  Units,
  Village,
} from "./types";

/** Global game speed multiplier. 1 = real Tribal Wars pace. */
/** Game speed: 1 = real time. A live binding, so changing it takes effect everywhere at once. */
export let SPEED = 60;
export const setSpeed = (n: number) => {
  SPEED = n;
};
/** The world's age in game hours. Bots develop by this clock, so they grow while you play AND while you are away, at any game speed. */
let ageBase = 0;
let baseAt = Date.now();
export const worldAgeHours = (now: number = Date.now()) =>
  ageBase + ((now - baseAt) * SPEED) / 3_600_000;
export const setWorldClock = (ageHours: number, at: number) => {
  ageBase = ageHours;
  baseAt = at;
};
const HOUR = 3_600_000;

export const RES = ["wood", "clay", "iron"] as const;
export const emptyCost = (): Cost => ({ wood: 0, clay: 0, iron: 0 });

export const prodPerHour = (lvl: number) =>
  (lvl <= 0 ? 5 : 30 * Math.pow(1.163, lvl - 1)) * SPEED;
export const capacityAt = (warehouseLevel: number) =>
  Math.round(1000 * Math.pow(1.229, warehouseLevel - 1));
export const popCapAt = (farmLevel: number) =>
  Math.round(240 * Math.pow(1.172, farmLevel - 1));
export const popCap = (v: Village) => popCapAt(v.buildings.farm);
/**
 * Population a village is responsible for: its own troops at home, in training, on the road, and its troops
 * stationed as SUPPORT in other villages (they eat the home farm, not the host's).
 */
export function popUsed(
  v: Village,
  commands: Command[] = [],
  villages: Record<string, Village> = {},
) {
  let n = 0;
  for (const u of UNIT_IDS) n += v.units[u] * UNITS[u].pop;
  for (const j of v.recruitQueue) n += j.count * UNITS[j.unit].pop;
  for (const c of commands)
    if ((c.kind === "return" ? c.toId : c.fromId) === v.id)
      for (const u of UNIT_IDS) n += (c.units[u] ?? 0) * UNITS[u].pop;
  for (const w of Object.values(villages)) {
    const st = w.id !== v.id ? w.stationed?.[v.id] : undefined;
    if (st) for (const u of UNIT_IDS) n += (st[u] ?? 0) * UNITS[u].pop;
  }
  return n;
}
export const popFree = (
  v: Village,
  commands: Command[] = [],
  villages: Record<string, Village> = {},
) => popCap(v) - popUsed(v, commands, villages);

/** Everyone who defends a village: its own troops plus the support standing there. */
export function garrison(v: Village): Units {
  const g = { ...v.units };
  for (const st of Object.values(v.stationed ?? {}))
    for (const u of UNIT_IDS) g[u] += st[u] ?? 0;
  return g;
}

// ---- Market ----
export const MERCHANT_CAPACITY = 1000; // resources per merchant
export const MERCHANT_MIN_PER_FIELD = 6; // merchant pace
const busyMerchants = (v: Village, commands: Command[]) =>
  commands.reduce(
    (s, c) =>
      s +
      ((c.merchants ?? 0) > 0 &&
      (c.kind === "return" ? c.toId : c.fromId) === v.id
        ? c.merchants!
        : 0),
    0,
  );
export const merchantsFree = (v: Village, commands: Command[]) =>
  Math.max(0, v.buildings.market - busyMerchants(v, commands));
export const tradeMs = (a: [number, number], b: [number, number]) =>
  (Math.hypot(a[0] - b[0], a[1] - b[1]) * MERCHANT_MIN_PER_FIELD * 60_000) /
  SPEED;

export const capacity = (v: Village) => capacityAt(v.buildings.warehouse);

export function buildCost(id: BuildingId, toLevel: number): Cost {
  const d = BUILDINGS[id];
  const f = Math.pow(d.costFactor, toLevel - 1);
  return {
    wood: Math.round(d.baseCost.wood * f),
    clay: Math.round(d.baseCost.clay * f),
    iron: Math.round(d.baseCost.iron * f),
  };
}
/**
 * Construction time, as in the original game: base × 1.18 × factor^e × 1.05^(−Headquarters level), where e = −13 for levels 1–2
 * and level − 1 − 14/(level − 1) after that. (Levels 1–2 are very quick, then each level takes clearly longer.)
 */
export function buildTimeMs(id: BuildingId, toLevel: number, hqLevel: number) {
  const d = BUILDINGS[id];
  const e =
    toLevel <= 2 ? -13 : Math.max(-13, toLevel - 1 - 14 / (toLevel - 1));
  const sec =
    d.baseTimeSec * 1.18 * Math.pow(d.timeFactor, e) * Math.pow(1.05, -hqLevel);
  return (sec * 1000) / SPEED;
}
/** Training time per unit, as in the original game: 2/3 × the unit's base time × 1.06^(−level of the building that trains it). */
export const recruitTimeMs = (u: UnitId, level: number) =>
  ((2 / 3) * UNITS[u].timeSec * 1000 * Math.pow(1.06, -level)) / SPEED;

export const canAfford = (have: Cost, cost: Cost) =>
  RES.every((r) => have[r] >= cost[r]);
export const pay = (v: Village, cost: Cost) =>
  RES.forEach((r) => (v.resources[r] -= cost[r]));

function accrue(v: Village, to: number) {
  const dt = (to - v.updatedAt) / HOUR;
  if (dt <= 0) return;
  const cap = capacity(v);
  for (const r of RES) {
    const lvl = v.buildings[RESOURCE_BUILDING[r]];
    v.resources[r] = Math.min(cap, v.resources[r] + prodPerHour(lvl) * dt);
  }
  if (v.loyalty < 100) v.loyalty = Math.min(100, v.loyalty + dt * SPEED); // +1/hour at 1x
  v.updatedAt = to;
}

/**
 * LAZY SETTLEMENT — the key scalability trick (same idea as the original game).
 * Villages are not simulated per tick; we fast-forward them to `now` only when
 * touched, replaying finished queue items in order so production stays exact.
 */
export function settle(src: Village, now: number): Village {
  const v = structuredClone(src);
  const events = [
    ...v.buildQueue.map((j) => ({
      t: j.finishesAt,
      run: () => {
        v.buildings[j.building] = j.level;
      },
    })),
    ...v.recruitQueue.map((j) => ({
      t: j.finishesAt,
      run: () => {
        v.units[j.unit] += j.count;
      },
    })),
  ]
    .filter((e) => e.t <= now)
    .sort((a, b) => a.t - b.t);
  for (const e of events) {
    accrue(v, e.t);
    e.run();
  }
  v.buildQueue = v.buildQueue.filter((j) => j.finishesAt > now);
  v.recruitQueue = v.recruitQueue.filter((j) => j.finishesAt > now);
  accrue(v, now);
  v.points = Object.values(v.buildings).reduce((a, b) => a + b, 0) * 10;
  return v;
}

/** Requirements gate the FIRST construction only; upgrading something you already have is never blocked. */
export const buildReqMet = (v: Village, id: BuildingId) =>
  v.buildings[id] > 0 ||
  (BUILDINGS[id].requires ?? []).every(
    (r) => v.buildings[r.building] >= r.level,
  );

export function tryBuild(
  src: Village,
  id: BuildingId,
  now: number,
): Village | null {
  const v = settle(src, now);
  if (!buildReqMet(v, id)) return null;
  const pending = v.buildQueue.filter((j) => j.building === id).length;
  const level = v.buildings[id] + pending + 1;
  if (level > BUILDINGS[id].maxLevel || v.buildQueue.length >= 3) return null;
  const cost = buildCost(id, level);
  if (!canAfford(v.resources, cost)) return null;
  pay(v, cost);
  const start = v.buildQueue.at(-1)?.finishesAt ?? now;
  v.buildQueue.push({
    building: id,
    level,
    finishesAt: start + buildTimeMs(id, level, v.buildings.main),
  });
  return v;
}

export const meetsReq = (v: Village, u: UnitId) =>
  (UNITS[u].requires ?? []).every((r) => v.buildings[r.building] >= r.level);

export function tryRecruit(
  src: Village,
  unit: UnitId,
  count: number,
  now: number,
  commands: Command[] = [],
  villages: Record<string, Village> = {},
): Village | null {
  const v = settle(src, now);
  if (!meetsReq(v, unit)) return null;
  if (count < 1 || count * UNITS[unit].pop > popFree(v, commands, villages))
    return null; // farm full
  const cost: Cost = {
    wood: UNITS[unit].cost.wood * count,
    clay: UNITS[unit].cost.clay * count,
    iron: UNITS[unit].cost.iron * count,
  };
  if (!canAfford(v.resources, cost)) return null;
  pay(v, cost);
  const start = v.recruitQueue.at(-1)?.finishesAt ?? now;
  v.recruitQueue.push({
    unit,
    count,
    finishesAt:
      start + recruitTimeMs(unit, v.buildings[UNITS[unit].trainedAt]) * count,
  });
  return v;
}

/** There can only be ONE Paladin: count the ones standing, training, or marching. */
export function paladinCount(
  villages: Record<string, Village>,
  commands: Command[],
) {
  let n = 0;
  for (const v of Object.values(villages)) {
    n += v.units.paladin ?? 0;
    for (const st of Object.values(v.stationed ?? {})) n += st.paladin ?? 0;
    for (const j of v.recruitQueue) if (j.unit === "paladin") n += j.count;
  }
  for (const c of commands) n += c.units.paladin ?? 0;
  return n;
}

/** Marching time for a group: distance × the slowest unit's pace. */
export function travelMs(
  a: [number, number],
  b: [number, number],
  units: Units,
) {
  const paces = UNIT_IDS.filter((u) => units[u] > 0).map(
    (u) => UNITS[u].minutesPerField,
  );
  if (!paces.length) return 0;
  return (
    (Math.hypot(a[0] - b[0], a[1] - b[1]) * Math.max(...paces) * 60_000) / SPEED
  );
}
/** A march can be called back during the first 10 game-minutes after it departs (like the original). */
/** Cancelling a construction or a training order gives back this share of what it cost. */
export const CANCEL_REFUND = 0.9;
export const recallWindowMs = () => (10 * 60_000) / SPEED;

/** Hiding Place: how much of EACH resource raiders cannot touch. */
export const hidingProtect = (level: number) =>
  level <= 0 ? 0 : Math.round(150 * Math.pow(1.35, level - 1));

/** Where a village's population goes (shown in the Army tab so the farm limit is never a mystery). */
export function popBreakdown(
  v: Village,
  commands: Command[] = [],
  villages: Record<string, Village> = {},
) {
  const sum = (u: Units) =>
    UNIT_IDS.reduce((s, k) => s + (u[k] ?? 0) * UNITS[k].pop, 0);
  const home = sum(v.units);
  const training = v.recruitQueue.reduce(
    (s, j) => s + j.count * UNITS[j.unit].pop,
    0,
  );
  const marching = commands.reduce(
    (s, c) =>
      s +
      ((c.kind === "return" ? c.toId : c.fromId) === v.id ? sum(c.units) : 0),
    0,
  );
  const stationedOut = Object.values(villages).reduce(
    (s, w) =>
      s + (w.id !== v.id && w.stationed?.[v.id] ? sum(w.stationed[v.id]) : 0),
    0,
  );
  const hostedHere = Object.values(v.stationed ?? {}).reduce(
    (s, u) => s + sum(u),
    0,
  ); // not counted: they eat their home farm
  return { home, training, marching, stationedOut, hostedHere };
}
