import type { BuildingId, Cost } from "../core/types";
export interface BuildingDef {
  name: string;
  desc: string;
  maxLevel: number;
  baseCost: Cost;
  costFactor: number;
  baseTimeSec: number;
  timeFactor: number;
  /** Needed to construct it the first time (upgrades of an existing building are never blocked). */
  requires?: { building: BuildingId; level: number }[];
}
export const BUILDINGS: Record<BuildingId, BuildingDef> = {
  main: {
    name: "Headquarters",
    desc: "Speeds up all construction (-5% build time per level).",
    maxLevel: 20,
    baseCost: { wood: 90, clay: 80, iron: 70 },
    costFactor: 1.26,
    baseTimeSec: 900,
    timeFactor: 1.2,
  },
  barracks: {
    name: "Barracks",
    desc: "Recruits infantry. Higher levels train faster and unlock stronger units.",
    maxLevel: 20,
    baseCost: { wood: 200, clay: 170, iron: 90 },
    costFactor: 1.26,
    baseTimeSec: 1800,
    timeFactor: 1.2,
    requires: [{ building: "main", level: 3 }],
  },
  academy: {
    name: "Academy",
    desc: "Lets you train Noblemen, the only unit that can conquer villages.",
    maxLevel: 1,
    baseCost: { wood: 15000, clay: 25000, iron: 10000 },
    costFactor: 1.26,
    baseTimeSec: 3600,
    timeFactor: 1.2,
    requires: [
      { building: "main", level: 20 },
      { building: "smithy", level: 20 },
      { building: "market", level: 10 },
    ],
  },
  rally: {
    name: "Rally Point",
    desc: "Required to send troops out (attacks and scouting missions).",
    maxLevel: 1,
    baseCost: { wood: 10, clay: 40, iron: 30 },
    costFactor: 1.2,
    baseTimeSec: 600,
    timeFactor: 1.2,
  },
  workshop: {
    name: "Workshop",
    desc: "Builds siege engines: Rams and Catapults. Higher levels build them faster.",
    maxLevel: 15,
    baseCost: { wood: 300, clay: 240, iron: 260 },
    costFactor: 1.26,
    baseTimeSec: 2400,
    timeFactor: 1.2,
    requires: [
      { building: "main", level: 10 },
      { building: "smithy", level: 10 },
    ],
  },
  statue: {
    name: "Statue",
    desc: "Lets you train your Paladin, a single hero who levels up with every victory.",
    maxLevel: 1,
    baseCost: { wood: 220, clay: 220, iron: 220 },
    costFactor: 1.2,
    baseTimeSec: 2400,
    timeFactor: 1.2,
    requires: [{ building: "main", level: 3 }],
  },
  market: {
    name: "Market",
    desc: "Merchants carry resources between your villages (1 merchant per level, 1000 each). Needed for the Academy.",
    maxLevel: 20,
    baseCost: { wood: 100, clay: 100, iron: 100 },
    costFactor: 1.26,
    baseTimeSec: 1800,
    timeFactor: 1.2,
    requires: [
      { building: "main", level: 3 },
      { building: "warehouse", level: 2 },
    ],
  },
  hiding: {
    name: "Hiding Place",
    desc: "Hides some of every resource from raiders. They can only loot what is above this amount.",
    maxLevel: 10,
    baseCost: { wood: 50, clay: 60, iron: 50 },
    costFactor: 1.25,
    baseTimeSec: 1800,
    timeFactor: 1.2,
  },
  stable: {
    name: "Stable",
    desc: "Trains cavalry: Light Cavalry, Mounted Archers and Heavy Cavalry.",
    maxLevel: 20,
    baseCost: { wood: 270, clay: 240, iron: 260 },
    costFactor: 1.26,
    baseTimeSec: 2400,
    timeFactor: 1.2,
    requires: [
      { building: "main", level: 10 },
      { building: "barracks", level: 5 },
      { building: "smithy", level: 5 },
    ],
  },
  smithy: {
    name: "Smithy",
    desc: "Forges better weapons: +2% attack per level for troops that leave this village, +2% defense per level for everyone defending it (support included), and it unlocks advanced units.",
    maxLevel: 20,
    baseCost: { wood: 220, clay: 180, iron: 240 },
    costFactor: 1.26,
    baseTimeSec: 2000,
    timeFactor: 1.2,
    requires: [
      { building: "main", level: 5 },
      { building: "barracks", level: 1 },
    ],
  },
  farm: {
    name: "Farm",
    desc: "Raises the population cap. Every unit (home, training or away) uses population.",
    maxLevel: 30,
    baseCost: { wood: 45, clay: 40, iron: 30 },
    costFactor: 1.28,
    baseTimeSec: 1000,
    timeFactor: 1.2,
  },
  timber: {
    name: "Timber Camp",
    desc: "Produces wood.",
    maxLevel: 30,
    baseCost: { wood: 50, clay: 60, iron: 40 },
    costFactor: 1.25,
    baseTimeSec: 900,
    timeFactor: 1.2,
  },
  clay: {
    name: "Clay Pit",
    desc: "Produces clay.",
    maxLevel: 30,
    baseCost: { wood: 65, clay: 50, iron: 40 },
    costFactor: 1.25,
    baseTimeSec: 900,
    timeFactor: 1.2,
  },
  iron: {
    name: "Iron Mine",
    desc: "Produces iron.",
    maxLevel: 30,
    baseCost: { wood: 75, clay: 65, iron: 70 },
    costFactor: 1.25,
    baseTimeSec: 1000,
    timeFactor: 1.2,
  },
  warehouse: {
    name: "Warehouse",
    desc: "Raises the storage cap for every resource.",
    maxLevel: 30,
    baseCost: { wood: 60, clay: 50, iron: 40 },
    costFactor: 1.27,
    baseTimeSec: 1020,
    timeFactor: 1.2,
  },
  wall: {
    name: "Wall",
    desc: "Boosts defense against every attack.",
    maxLevel: 20,
    baseCost: { wood: 50, clay: 100, iron: 20 },
    costFactor: 1.26,
    baseTimeSec: 3600,
    timeFactor: 1.2,
    requires: [{ building: "barracks", level: 1 }],
  },
};
export const BUILDING_IDS = Object.keys(BUILDINGS) as BuildingId[];
export const RESOURCE_BUILDING = {
  wood: "timber",
  clay: "clay",
  iron: "iron",
} as const;
