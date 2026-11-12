// core/population.ts
// Population the way the original Tribal Wars does it:
//  * the Farm sets how many "slots" a village has: 240 at level 1, growing about 17% per level (about 24,000 at level 30);
//  * units use slots (their `pop`), AND so do buildings: every level of every building takes slots, and higher levels
//    take more (about 17% more per level). The Farm itself takes none, and neither does the Rally Point;
//  * the slots a building needs are reserved when you QUEUE its upgrade, and the upgrade is refused when they are not free.
// These are the classic values from memory; every number here can be tuned.
import type { BuildingId, Village } from "./types";

export const FARM_BASE = 240; // slots at Farm level 1
export const FARM_GROWTH = 1.172103; // per level
/** Slots a village has with its Farm at `level` (0 = no Farm = no slots). */
export const farmCapAt = (level: number) =>
  level <= 0 ? 0 : Math.round(FARM_BASE * Math.pow(FARM_GROWTH, level - 1));

/** Slots a building takes at level 1; at level L it takes about base × 1.17^(L-1) in total. */
export const BUILDING_POP: Partial<Record<BuildingId, number>> = {
  main: 5,
  barracks: 7,
  stable: 8,
  workshop: 8,
  academy: 80,
  smithy: 20,
  rally: 0,
  statue: 10,
  market: 20,
  timber: 5,
  clay: 10,
  iron: 10,
  farm: 0,
  warehouse: 6,
  hiding: 5,
  wall: 5,
};
export const BUILDING_POP_GROWTH = 1.17;

/** Total slots a building uses when it stands at `level`. */
export const buildingPopAt = (id: BuildingId, level: number) =>
  level <= 0
    ? 0
    : Math.round(
        (BUILDING_POP[id] ?? 0) * Math.pow(BUILDING_POP_GROWTH, level - 1),
      );

/** Extra slots the upgrade TO `level` needs (what must be free when you queue it). */
export const upgradePop = (id: BuildingId, level: number) =>
  buildingPopAt(id, level) - buildingPopAt(id, level - 1);

/** Slots all the buildings of a village use, counting the upgrades that are queued (they reserve their slots). */
export function buildingsPop(
  v: Pick<Village, "buildings" | "buildQueue">,
): number {
  const level: Partial<Record<BuildingId, number>> = { ...v.buildings };
  for (const j of v.buildQueue)
    level[j.building] = Math.max(level[j.building] ?? 0, j.level);
  return (Object.keys(level) as BuildingId[]).reduce(
    (n, id) => n + buildingPopAt(id, level[id] ?? 0),
    0,
  );
}
