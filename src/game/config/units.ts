import type {
  AttackClass,
  BuildingId,
  Cost,
  UnitId,
  UnitRole,
} from "../core/types";
export interface UnitDef {
  name: string;
  role: UnitRole;
  klass: AttackClass; // how it attacks (decides which defense value applies against it)
  pop: number;
  attack: number;
  defense: Record<AttackClass, number>; // defense against infantry / cavalry / ranged attackers
  carry: number;
  minutesPerField: number;
  cost: Cost;
  timeSec: number;
  trainedAt: BuildingId; // whose level speeds up training
  requires?: { building: BuildingId; level: number }[];
}
const D = (infantry: number, cavalry: number, ranged: number) => ({
  infantry,
  cavalry,
  ranged,
});

// timeSec = base training time on a speed-1 world (the real table; Paladin is my estimate).
// Order here = order in the UI (grouped by role). Add a unit: add its id to UnitId in types.ts + an entry here.
// Numbers approximate the classic game from memory; tune freely — the Help screen reads them from here.
export const UNITS: Record<UnitId, UnitDef> = {
  // ---- defensive
  spear: {
    name: "Spearman",
    role: "defense",
    klass: "infantry",
    pop: 1,
    attack: 10,
    defense: D(15, 45, 20),
    carry: 25,
    minutesPerField: 18,
    cost: { wood: 50, clay: 30, iron: 10 },
    timeSec: 1020,
    trainedAt: "barracks",
    requires: [{ building: "barracks", level: 1 }],
  },
  sword: {
    name: "Swordsman",
    role: "defense",
    klass: "infantry",
    pop: 1,
    attack: 25,
    defense: D(50, 15, 40),
    carry: 15,
    minutesPerField: 22,
    cost: { wood: 30, clay: 30, iron: 70 },
    timeSec: 1500,
    trainedAt: "barracks",
    requires: [{ building: "barracks", level: 1 }],
  },
  archer: {
    name: "Archer",
    role: "defense",
    klass: "ranged",
    pop: 1,
    attack: 15,
    defense: D(50, 40, 5),
    carry: 10,
    minutesPerField: 18,
    cost: { wood: 100, clay: 30, iron: 60 },
    timeSec: 1800,
    trainedAt: "barracks",
    requires: [
      { building: "barracks", level: 5 },
      { building: "smithy", level: 5 },
    ],
  },
  heavy: {
    name: "Heavy Cav.",
    role: "hybrid",
    klass: "cavalry",
    pop: 6,
    attack: 150,
    defense: D(200, 80, 180),
    carry: 50,
    minutesPerField: 11,
    cost: { wood: 200, clay: 150, iron: 600 },
    timeSec: 3600,
    trainedAt: "stable",
    requires: [
      { building: "stable", level: 10 },
      { building: "smithy", level: 15 },
    ],
  },
  paladin: {
    name: "Paladin",
    role: "hybrid",
    klass: "cavalry",
    pop: 10,
    attack: 150,
    defense: D(100, 100, 100),
    carry: 100,
    minutesPerField: 10,
    cost: { wood: 100, clay: 100, iron: 200 },
    timeSec: 3000,
    trainedAt: "statue",
    requires: [{ building: "statue", level: 1 }],
  },
  // ---- offensive
  axe: {
    name: "Axeman",
    role: "offense",
    klass: "infantry",
    pop: 1,
    attack: 40,
    defense: D(10, 5, 10),
    carry: 10,
    minutesPerField: 18,
    cost: { wood: 60, clay: 30, iron: 40 },
    timeSec: 1320,
    trainedAt: "barracks",
    requires: [{ building: "barracks", level: 1 }],
  },
  light: {
    name: "Light Cav.",
    role: "offense",
    klass: "cavalry",
    pop: 4,
    attack: 130,
    defense: D(30, 40, 30),
    carry: 80,
    minutesPerField: 10,
    cost: { wood: 125, clay: 100, iron: 250 },
    timeSec: 1800,
    trainedAt: "stable",
    requires: [{ building: "stable", level: 3 }],
  },
  mounted: {
    name: "Mounted Archer",
    role: "offense",
    klass: "ranged",
    pop: 5,
    attack: 120,
    defense: D(40, 30, 50),
    carry: 50,
    minutesPerField: 10,
    cost: { wood: 250, clay: 100, iron: 150 },
    timeSec: 2700,
    trainedAt: "stable",
    requires: [
      { building: "stable", level: 5 },
      { building: "smithy", level: 5 },
    ],
  },
  ram: {
    name: "Ram",
    role: "offense",
    klass: "infantry",
    pop: 5,
    attack: 2,
    defense: D(20, 50, 20),
    carry: 0,
    minutesPerField: 30,
    cost: { wood: 300, clay: 200, iron: 200 },
    timeSec: 4800,
    trainedAt: "workshop",
    requires: [{ building: "workshop", level: 1 }],
  },
  catapult: {
    name: "Catapult",
    role: "offense",
    klass: "infantry",
    pop: 8,
    attack: 100,
    defense: D(100, 50, 100),
    carry: 0,
    minutesPerField: 30,
    cost: { wood: 320, clay: 400, iron: 100 },
    timeSec: 7200,
    trainedAt: "workshop",
    requires: [{ building: "workshop", level: 2 }],
  },
  // ---- special
  scout: {
    name: "Scout",
    role: "special",
    klass: "infantry",
    pop: 2,
    attack: 0,
    defense: D(2, 1, 2),
    carry: 0,
    minutesPerField: 9,
    cost: { wood: 50, clay: 50, iron: 20 },
    timeSec: 900,
    trainedAt: "barracks",
    requires: [{ building: "barracks", level: 1 }],
  },
  noble: {
    name: "Nobleman",
    role: "special",
    klass: "infantry",
    pop: 100,
    attack: 30,
    defense: D(100, 50, 100),
    carry: 0,
    minutesPerField: 35,
    cost: { wood: 40000, clay: 50000, iron: 50000 },
    timeSec: 18000,
    trainedAt: "academy",
    requires: [
      { building: "academy", level: 1 },
      { building: "main", level: 20 },
      { building: "smithy", level: 20 },
      { building: "market", level: 10 },
    ],
  },
};
export const UNIT_IDS = Object.keys(UNITS) as UnitId[];
