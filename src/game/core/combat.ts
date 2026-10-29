import { UNITS, UNIT_IDS } from "../config/units";
import type { AttackClass, Units } from "./types";

// ---- Tunable combat constants (the in-game Help screen reads these, so it never goes stale) ----
export const SMITHY_BONUS = 0.02; // +2% attack per Smithy level of the village the troops left from
export const SMITHY_DEFENSE_BONUS = 0.02; // +2% defense per Smithy level of the village being defended (host's, support included)
// The wall, as in the original game: it multiplies your defenders AND fights back by itself, even when nobody is home.
export const WALL_GROWTH = 1.037; // everything defending is x1.037^level (level 10: +44%, level 20: +107%)
export const WALL_FLAT = 50; // flat defense per wall level (on top of the free base); the wall multiplies this too
export const BASE_DEFENSE = 20; // every village has a little free defense
export const RAM_DECAY = 1.09; // rams get less effective against higher walls
export const CATS_PER_LEVEL = 3; // surviving catapults needed per building level destroyed
export const NOBLE_LOYALTY_HIT = 25; // loyalty removed by each surviving noble on a won attack

export const ATTACK_CLASSES: AttackClass[] = ["infantry", "cavalry", "ranged"];
export const CLASS_ICON: Record<AttackClass, string> = {
  infantry: "🗡️",
  cavalry: "🐎",
  ranged: "🏹",
};
export const CLASS_NAME: Record<AttackClass, string> = {
  infantry: "Infantry",
  cavalry: "Cavalry",
  ranged: "Ranged",
};

export interface CombatResult {
  attackerWins: boolean;
  attackerLeft: Units;
  defenderLeft: Units;
  wallAfter: number;
}
const scale = (u: Units, keep: number): Units =>
  Object.fromEntries(
    UNIT_IDS.map((id) => [id, Math.round(u[id] * keep)]),
  ) as Units; // round, not floor: a lone Noble must not vanish from a 10% loss
export const emptyUnits = (): Units =>
  Object.fromEntries(UNIT_IDS.map((id) => [id, 0])) as Units;

const totalAttack = (u: Units) =>
  UNIT_IDS.reduce((s, id) => s + u[id] * UNITS[id].attack, 0);

/** Share of an army's attack power that comes from each class (sums to 1). */
export function attackShares(u: Units): Record<AttackClass, number> {
  const by: Record<AttackClass, number> = {
    infantry: 0,
    cavalry: 0,
    ranged: 0,
  };
  for (const id of UNIT_IDS) by[UNITS[id].klass] += u[id] * UNITS[id].attack;
  const t = by.infantry + by.cavalry + by.ranged;
  return t <= 0
    ? { infantry: 1, cavalry: 0, ranged: 0 }
    : {
        infantry: by.infantry / t,
        cavalry: by.cavalry / t,
        ranged: by.ranged / t,
      };
}

const rawDefense = (def: Units, k: AttackClass) =>
  UNIT_IDS.reduce((s, id) => s + def[id] * UNITS[id].defense[k], 0);

export const wallMult = (level: number) => Math.pow(WALL_GROWTH, level);
export const wallFlat = (level: number) => BASE_DEFENSE + WALL_FLAT * level;
/** Rams first weaken the wall FOR THE FIGHT (never below half its level)... */
export const ramPreLevels = (rams: number, wall: number) =>
  Math.min(
    Math.floor(wall / 2),
    Math.max(0, Math.round((rams / 4) * Math.pow(RAM_DECAY, -wall))),
  );
/** ...and the rams that survive a won battle really tear it down. */
export const ramPostLevels = (
  ramsLeft: number,
  ramsLost: number,
  wall: number,
) =>
  ramsLeft <= 0 || wall <= 0
    ? 0
    : Math.min(
        wall,
        Math.max(
          0,
          Math.round(
            (ramsLeft + 1 - ramsLost / 2) / (2 * Math.pow(RAM_DECAY, wall)) +
              0.5,
          ),
        ),
      );
/** Rams needed for the biggest possible pre-battle effect (half the wall level). */
export const ramsToBreakWall = (wall: number) =>
  wall < 2
    ? 0
    : Math.ceil(4 * Math.floor(wall / 2) * Math.pow(RAM_DECAY, wall));

/** How strong a garrison is against an attacker of each class (wall included). */
export const defenseBonusFor = (smithy: number) =>
  1 + SMITHY_DEFENSE_BONUS * smithy;
export function defenseRating(
  def: Units,
  wallLevel: number,
  defBonus = 1,
): Record<AttackClass, number> {
  const out = {} as Record<AttackClass, number>;
  for (const k of ATTACK_CLASSES) {
    const raw = rawDefense(def, k) * defBonus; // the Smithy sharpens the soldiers, not the wall
    out[k] = (raw + wallFlat(wallLevel)) * wallMult(wallLevel);
  }
  return out;
}

/** The two numbers that decide a fight (also used by the Help simulator and the attack preview). */
export function battlePowers(
  att: Units,
  def: Units,
  wallLevel: number,
  attackBonus = 1,
  defBonus = 1,
) {
  const effWall = wallLevel - ramPreLevels(att.ram, wallLevel); // the level the wall counts as during the fight
  const shares = attackShares(att);
  const rating = defenseRating(def, effWall, defBonus);
  const a = totalAttack(att) * attackBonus;
  // Defense is weighted by what the attacker actually brought: send the class they are weakest against.
  const d = ATTACK_CLASSES.reduce((s, k) => s + shares[k] * rating[k], 0);
  return { a, d, effWall, shares, rating };
}

/**
 * The loser of the weaker side loses (weaker/stronger)^1.5 of its army if it wins; an attacker who loses loses everything.
 * The wall is a defender too: its flat defense counts even with nobody home, so attacking a walled village costs troops.
 * Rams: weaken the wall for the fight (see ramPreLevels); survivors of a won battle tear it down (ramPostLevels).
 */
export function resolveBattle(
  att: Units,
  def: Units,
  wallLevel: number,
  attackBonus = 1,
  defBonus = 1,
): CombatResult {
  const { a, d } = battlePowers(att, def, wallLevel, attackBonus, defBonus);
  const attackerWins = a > d;
  const lossRatio = Math.pow(Math.min(a, d) / Math.max(a, d, 1), 1.5);
  if (attackerWins) {
    const attackerLeft = scale(att, 1 - lossRatio);
    const down = ramPostLevels(
      attackerLeft.ram,
      att.ram - attackerLeft.ram,
      wallLevel,
    );
    return {
      attackerWins,
      attackerLeft,
      defenderLeft: scale(def, 0),
      wallAfter: Math.max(0, wallLevel - down),
    };
  }
  return {
    attackerWins,
    attackerLeft: scale(att, 0),
    defenderLeft: scale(def, 1 - lossRatio),
    wallAfter: wallLevel,
  };
}

/** Levels of the targeted building destroyed by the catapults that survived a won battle. */
export const catapultLevels = (catsLeft: number) =>
  Math.floor(catsLeft / CATS_PER_LEVEL);

export const SCOUT_KILL = 0.6; // every defending scout kills 0.6 of your scouts
export const SCOUT_COUNTER = 0.4; // every scout you send kills 0.4 of theirs
export const SCOUT_TIER_NAME = ["", "Glimpse", "Recon", "Full report"] as const;

/**
 * A scouting duel. Both sides lose scouts; what you SEE depends on how many of yours survive compared to theirs:
 *  tier 1 Glimpse: any survivor → resources and loyalty
 *  tier 2 Recon: survivors ≥ half their scouts → also troops and wall
 *  tier 3 Full report: survivors ≥ their scouts (or they have none) → also every building level
 */
export function resolveScout(sent: number, defenderScouts: number) {
  const def = Number.isFinite(defenderScouts) ? Math.max(0, defenderScouts) : 0; // tolerate missing field in old data
  const lost = Math.min(sent, Math.floor(def * SCOUT_KILL));
  const left = sent - lost;
  const defenderLost = Math.min(def, Math.floor(sent * SCOUT_COUNTER));
  const q = def === 0 ? Infinity : left / def;
  const tier: 0 | 1 | 2 | 3 = left <= 0 ? 0 : q >= 1 ? 3 : q >= 0.5 ? 2 : 1;
  return { success: left > 0, left, lost, defenderLost, tier };
}
export const carryCapacity = (u: Units) =>
  UNIT_IDS.reduce((s, id) => s + u[id] * UNITS[id].carry, 0);

// ---- Paladin (hero) ----
export const HERO_ATTACK_PER_LEVEL = 0.05; // +5% attack per hero level to the army he leads
export const HERO_XP_LEVELS = [0, 100, 250, 500, 900]; // xp needed for levels 1..5
export const HERO_XP_WIN = 20;
export const HERO_XP_CONQUEST = 50;
export const HERO_XP_NEMESIS = 100; // taking a village from your nemesis
export const heroLevel = (xp: number) =>
  HERO_XP_LEVELS.filter((t) => xp >= t).length;
/** Total attack multiplier: origin Smithy and (if he marches with the army) the Paladin's level. */
export const attackBonusFor = (smithy: number, army: Units, level: number) =>
  (1 + SMITHY_BONUS * smithy) *
  (army.paladin > 0 ? 1 + HERO_ATTACK_PER_LEVEL * level : 1);

/** 0..5 rating of a raw attack/defense number, shown as pips in the UI. */
export const tier = (v: number) =>
  v >= 140 ? 5 : v >= 80 ? 4 : v >= 30 ? 3 : v >= 15 ? 2 : v >= 1 ? 1 : 0;
export const pips = (n: number) => "●".repeat(n) + "○".repeat(5 - n);

export interface SimWave {
  wins: boolean;
  attackerLeft: Units;
  loyalty: number;
  conquered: boolean;
}
/** Plays waves one after another against scouted intel (waves must be given in landing order). An estimate: intel ages. */
export function simulateWaves(
  waves: Units[],
  intel: { units: Units; wall: number; loyalty: number; smithy?: number },
  smithy: number,
  heroLvl: number,
): SimWave[] {
  let def = { ...intel.units };
  let wall = intel.wall;
  let loyalty = intel.loyalty;
  let conquered = false;
  return waves.map((w) => {
    if (conquered) return { wins: true, attackerLeft: w, loyalty, conquered }; // already ours: they just arrive
    const r = resolveBattle(
      w,
      def,
      wall,
      attackBonusFor(smithy, w, heroLvl),
      defenseBonusFor(intel.smithy ?? 0),
    );
    def = r.defenderLeft;
    wall = r.wallAfter;
    if (r.attackerWins && r.attackerLeft.noble > 0) {
      loyalty -= NOBLE_LOYALTY_HIT * r.attackerLeft.noble;
      if (loyalty < 1) conquered = true;
    }
    return {
      wins: r.attackerWins,
      attackerLeft: r.attackerLeft,
      loyalty: Math.max(0, loyalty),
      conquered,
    };
  });
}

/** Surviving nobles needed to take a village at this loyalty (it counts as taken below 1). */
export const noblesNeeded = (loyalty: number) =>
  Math.max(1, Math.ceil((loyalty - 1) / NOBLE_LOYALTY_HIT));

/** After a battle, give every stack of a garrison (own troops, each support stack) the same per-unit survival rate. */
export function survivorsOf(stack: Units, before: Units, after: Units): Units {
  return Object.fromEntries(
    UNIT_IDS.map((id) => [
      id,
      before[id] > 0
        ? Math.round(((stack[id] ?? 0) * after[id]) / before[id])
        : 0,
    ]),
  ) as Units;
}
