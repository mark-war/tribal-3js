import { UNITS, UNIT_IDS } from "../config/units";
import { capacityAt, emptyCost, worldAgeHours } from "./economy";
import { emptyUnits } from "./combat";
import type { Units, Village } from "./types";

export const PLAYER = "Chek";

export const CHUNK = 16;
export const WORLD_SEED = 1337;

/** Deterministic hash -> [0,1). Same world on client and server, nothing stored. */
function rnd(x: number, y: number, salt = 0) {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647 + WORLD_SEED) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------- Rival players: 100 AI-controlled bots ----------------
export interface Clan {
  id: string;
  name: string;
  color: string;
  doctrine: "horde" | "cavalry" | "turtle" | "balanced" | "siege";
  growth: number;
  home: [number, number];
}
export type Bot = Clan;
export const BOT_COUNT = 100;
const FIRST = [
  "Grim",
  "Iron",
  "Ash",
  "Storm",
  "Red",
  "Black",
  "Gold",
  "Wolf",
  "Raven",
  "Stone",
];
const LAST = [
  "Harrow",
  "Fang",
  "Hollow",
  "Veil",
  "March",
  "Thorn",
  "Mane",
  "Crest",
  "Ward",
  "Bane",
];
const DOCTRINES: Clan["doctrine"][] = [
  "horde",
  "cavalry",
  "turtle",
  "balanced",
  "siege",
];
/** Every bot has a fixed home, spread evenly over the map by the golden angle (the nearest is ~36 fields from your start). */
export const BOTS: Clan[] = (() => {
  const taken = new Set<string>(["5|5"]);
  return Array.from({ length: BOT_COUNT }, (_, i) => {
    const theta = i * 2.399963229728653;
    const r = 28 + 112 * Math.sqrt((i + 0.5) / BOT_COUNT);
    let x = Math.round(5 + r * Math.cos(theta));
    const y = Math.round(5 + r * Math.sin(theta));
    while (taken.has(`${x}|${y}`)) x++;
    taken.add(`${x}|${y}`);
    return {
      id: `bot${i}`,
      name: `${FIRST[i % 10]} ${LAST[Math.floor(i / 10)]}`,
      color: `hsl(${(i * 37) % 360}, 65%, 55%)`,
      doctrine: DOCTRINES[Math.floor(rnd(i, 7, 21) * 5)],
      growth: 0.7 + 0.8 * rnd(i, 8, 22),
      home: [x, y] as [number, number],
    };
  });
})();
export const CLANS = BOTS; // older code calls them clans
const BOT_AT = new Map(BOTS.map((b) => [`${b.home[0]}|${b.home[1]}`, b]));
const BOT_BY_NAME = new Map(BOTS.map((b) => [b.name, b]));
/** Your nemesis is the bot that lives closest to where you start. */
const NEMESIS_ID = BOTS.reduce((best, b) =>
  Math.hypot(b.home[0] - 5, b.home[1] - 5) <
  Math.hypot(best.home[0] - 5, best.home[1] - 5)
    ? b
    : best,
).id;
export const rivalInfo = (owner: string | null) => {
  const b = owner ? BOT_BY_NAME.get(owner) : undefined;
  return b ? { ...b, nemesis: b.id === NEMESIS_ID } : null;
};

/** How developed a bot is (0..1): it follows the world's age and its own growth rate, like a player slowly building up. */
const DEV_T = 100; // game hours for an average bot to reach about 63%
export const botDev = (bot: Clan, ageHours: number = worldAgeHours()) =>
  1 - Math.exp(-(ageHours * bot.growth) / DEV_T);

/** The garrison a clan of this doctrine keeps at strength S. */
export function doctrineUnits(clan: Clan, S: number): Units {
  const f = (share: number) => Math.floor(S * share);
  const u = emptyUnits();
  const d = clan.doctrine;
  if (d === "horde")
    Object.assign(u, {
      axe: f(0.45),
      spear: f(0.15),
      sword: f(0.15),
      light: f(0.12),
      scout: f(0.06),
    });
  else if (d === "cavalry")
    Object.assign(u, {
      light: f(0.3),
      mounted: f(0.12),
      spear: f(0.25),
      sword: f(0.1),
      heavy: f(0.04),
      scout: f(0.06),
    });
  else if (d === "turtle")
    Object.assign(u, {
      spear: f(0.3),
      sword: f(0.3),
      archer: f(0.2),
      heavy: f(0.04),
      scout: f(0.08),
    });
  else if (d === "siege")
    Object.assign(u, {
      axe: f(0.3),
      spear: f(0.2),
      sword: f(0.2),
      ram: f(0.08),
      catapult: f(0.04),
      scout: f(0.06),
    });
  else
    Object.assign(u, {
      spear: f(0.25),
      sword: f(0.2),
      axe: f(0.2),
      archer: f(0.1),
      light: f(0.08),
      scout: f(0.06),
    });
  return u;
}

/** How developed a bot of this id is, given the age of its CURRENT life (a restarted bot starts again at 0). Your nemesis is a little quicker. */
export const botDevFor = (bot: Clan, lifeAgeHours: number) =>
  Math.min(1, botDev(bot, lifeAgeHours) * (bot.id === NEMESIS_ID ? 1.1 : 1));

/**
 * The plan of a bot: what a competent player of its style has at development `dev` (0..1), and the garrison that goes with it.
 * It needs what a player needs: no Academy before Headquarters 20, Smithy 20 and Market 10, no unit without its building.
 */
export function botPlan(bot: Clan, dev: number) {
  const nem = bot.id === NEMESIS_ID;
  const L = (cap: number, p: number, min = 1) =>
    Math.max(min, Math.min(cap, Math.round(cap * Math.pow(dev, p))));
  const d = bot.doctrine;
  const main = L(20, 1.0),
    smithy = L(20, 1.4, 0),
    market = L(20, 1.5, 0),
    warehouse = L(30, 0.9);
  const buildings = {
    main,
    barracks: L(20, 1.0),
    farm: L(30, 0.9),
    smithy,
    rally: 1,
    statue: 0,
    hiding: L(10, 1.2, 0),
    market,
    stable: d === "turtle" || d === "siege" ? 0 : L(20, 1.3, 0),
    workshop: d === "siege" ? L(15, 1.4, 0) : 0,
    timber: L(30, 0.8),
    clay: L(30, 0.8),
    iron: L(30, 0.8),
    warehouse,
    wall: L(d === "turtle" ? 20 : 15, 1.1, 0),
    academy: main >= 20 && smithy >= 20 && market >= 10 ? 1 : 0,
  };
  const S = Math.floor((8 + 160 * Math.pow(dev, 1.1)) * (nem ? 1.15 : 1));
  const units = doctrineUnits(bot, S);
  for (const k of UNIT_IDS)
    if (
      !(UNITS[k].requires ?? []).every(
        (r) => (buildings as Record<string, number>)[r.building] >= r.level,
      )
    )
      units[k] = 0; // no building, no unit
  return { buildings, units };
}

/** A village that already has everything the plan says it has at development `dev`. */
function buildBotVillage(
  x: number,
  y: number,
  bot: Clan,
  now: number,
  dev: number,
): Village {
  const { buildings, units } = botPlan(bot, dev);
  const stock = Math.floor(
    capacityAt(buildings.warehouse) * (0.25 + 0.5 * dev),
  );
  return {
    id: `${x}|${y}`,
    name: `${bot.name}'s ${dev > 0.8 ? "Citadel" : dev > 0.4 ? "Fort" : "Village"}`,
    x,
    y,
    owner: bot.name,
    points: Object.values(buildings).reduce((a, b) => a + b, 0) * 10,
    loyalty: 100,
    resources: { wood: stock, clay: stock, iron: stock },
    updatedAt: now,
    buildings,
    buildQueue: [],
    recruitQueue: [],
    units: { ...units },
    goal: { ...units },
    stationed: {},
  };
}
/** A bot's original home as it is NOW: a newcomer at first, then bigger as the world ages. */
const rivalVillage = (x: number, y: number, bot: Clan, now: number) =>
  buildBotVillage(x, y, bot, now, botDevFor(bot, worldAgeHours()));
/** The start of a new life: a bot that was wiped out begins again on a barbarian village as a newcomer. */
export const newcomerVillage = (x: number, y: number, bot: Clan, now: number) =>
  buildBotVillage(x, y, bot, now, 0);

export function villageAt(x: number, y: number, now: number): Village | null {
  if (x === 5 && y === 5) return null; // the player's starting village lives there
  const bot = BOT_AT.get(`${x}|${y}`);
  if (bot) return rivalVillage(x, y, bot, now); // a bot's home
  if (rnd(x, y) > 0.1) return null;
  // Barbarian villages GROW with the world, as in the original: the same village is a little bigger and stronger every day.
  const grow = Math.min(1, worldAgeHours() / 400); // fully grown after 400 game hours
  const strength = Math.floor(rnd(x, y, 1) * 30 * (0.35 + 0.9 * grow));
  const u = emptyUnits();
  const kind = Math.floor(rnd(x, y, 4) * 3); // 0 spear-heavy (weak to infantry) · 1 sword-heavy (weak to cavalry) · 2 mixed with archers
  if (kind === 0) {
    u.spear = strength;
    u.sword = Math.floor(strength / 4);
  } else if (kind === 1) {
    u.sword = strength;
    u.spear = Math.floor(strength / 4);
  } else {
    u.spear = Math.floor(strength / 2);
    u.sword = Math.floor(strength / 3);
    u.archer = Math.floor(strength / 3);
  }
  const up = (lo: number, hi: number) =>
    lo + Math.round((hi - lo) * grow * (0.6 + 0.4 * rnd(x, y, 5)));
  const buildings = {
    main: up(1, 10),
    barracks: 0,
    academy: 0,
    farm: up(1, 8),
    stable: 0,
    smithy: 0,
    rally: 0,
    workshop: 0,
    statue: 0,
    market: 0,
    hiding: 0,
    timber: up(1, 10),
    clay: up(1, 10),
    iron: up(1, 10),
    warehouse: up(1, 8),
    wall: Math.floor(rnd(x, y, 3) * 5) + Math.round(4 * grow),
  };
  return {
    id: `${x}|${y}`,
    name: "Barbarian Village",
    x,
    y,
    owner: null,
    points: Object.values(buildings).reduce((n, b) => n + b, 0) * 10,
    loyalty: 100,
    resources: {
      wood: 800 + Math.floor(5000 * grow),
      clay: 800 + Math.floor(5000 * grow),
      iron: 800 + Math.floor(5000 * grow),
    },
    updatedAt: now,
    buildings,
    buildQueue: [],
    recruitQueue: [],
    units: u,
    stationed: {},
  };
}

/** Chunked access: the map only ever materialises what the camera can see. */
export function chunkVillages(cx: number, cy: number, now: number): Village[] {
  const out: Village[] = [];
  for (let x = cx * CHUNK; x < (cx + 1) * CHUNK; x++)
    for (let y = cy * CHUNK; y < (cy + 1) * CHUNK; y++) {
      const v = villageAt(x, y, now);
      if (v) out.push(v);
    }
  return out;
}

export function newPlayerVillage(
  id: string,
  owner: string,
  x: number,
  y: number,
  now: number,
): Village {
  return {
    id,
    name: `${owner}'s Village`,
    x,
    y,
    owner,
    points: 60,
    loyalty: 100,
    resources: { ...emptyCost(), wood: 500, clay: 500, iron: 500 },
    updatedAt: now,
    buildings: {
      main: 1,
      barracks: 1,
      academy: 0,
      farm: 1,
      stable: 0,
      smithy: 0,
      rally: 1,
      workshop: 0,
      statue: 0,
      market: 0,
      hiding: 0,
      timber: 1,
      clay: 1,
      iron: 1,
      warehouse: 1,
      wall: 0,
    },
    buildQueue: [],
    recruitQueue: [],
    units: { ...emptyUnits(), spear: 10, axe: 20 },
    stationed: {},
  };
}
export const dist = (a: [number, number], b: [number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---- Save migration helpers: fill in anything a newer version added, keep everything the player has. ----
export const normalizeUnits = (u?: Partial<Units>): Units => ({
  ...emptyUnits(),
  ...(u ?? {}),
});
export function normalizeVillage(v: any): Village {
  return {
    ...v,
    loyalty: v.loyalty ?? 100,
    stationed: v.stationed ?? {},
    buildings: {
      main: 1,
      barracks: 0,
      academy: 0,
      farm: 1,
      stable: 0,
      smithy: 0,
      rally: v.owner ? 1 : 0,
      workshop: 0,
      statue: 0,
      market: 0,
      hiding: 0,
      timber: 1,
      clay: 1,
      iron: 1,
      warehouse: 1,
      wall: 0,
      ...v.buildings,
    },
    units: normalizeUnits(v.units),
  };
}

export const nemesisClan = () => CLANS.find((c) => rivalInfo(c.name)?.nemesis)!;

/** The villages a bot owns right now: its home (as generated, unless it is already in `world`) plus anything it conquered. */
export function botVillages(
  bot: Clan,
  world: Record<string, Village>,
  now: number,
): Village[] {
  const out = Object.values(world).filter((v) => v.owner === bot.name);
  const homeId = `${bot.home[0]}|${bot.home[1]}`;
  if (!world[homeId]) {
    const g = villageAt(bot.home[0], bot.home[1], now);
    if (g?.owner === bot.name) out.push(g);
  }
  return out;
}

/** The nearest barbarian village to `from` (the next target of a clan's noble run). */
export function nearestBarbarian(
  from: [number, number],
  now: number,
  skip?: (v: Village) => boolean,
): Village | null {
  let best: Village | null = null;
  let bd = Infinity;
  const cx0 = Math.floor(from[0] / CHUNK),
    cy0 = Math.floor(from[1] / CHUNK);
  for (let cx = cx0 - 3; cx <= cx0 + 3; cx++)
    for (let cy = cy0 - 3; cy <= cy0 + 3; cy++)
      for (const v of chunkVillages(cx, cy, now)) {
        if (v.owner !== null || skip?.(v)) continue;
        const d = Math.hypot(v.x - from[0], v.y - from[1]);
        if (d < bd) {
          bd = d;
          best = v;
        }
      }
  return best;
}
