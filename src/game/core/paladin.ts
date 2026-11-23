import { PLAYER } from "./world";
import type { Command, Village } from "./types";

/**
 * Where is YOUR Paladin? There is only one, and he can be in five places, which is why a "move him" button that only looked
 * at the troops standing at home could not find him:
 *   home      standing at home in one of your villages
 *   marching  on the road: an attack, a return, a support march, a rally, or a move of his own
 *   support   standing as SUPPORT in a village (after a conquest the whole army, Paladin included, stays there as support)
 *   training  in a training queue
 */
export type PaladinSpot =
  | { where: "home"; villageId: string }
  | {
      where: "marching";
      commandId: string;
      kind: Command["kind"];
      toId: string;
    }
  | { where: "support"; hostId: string; originId: string }
  | { where: "training"; villageId: string };

export function locatePaladin(
  villages: Record<string, Village>,
  commands: Command[],
): PaladinSpot | null {
  const all = Object.values(villages);
  for (const v of all)
    if (v.owner === PLAYER && (v.units.paladin ?? 0) > 0)
      return { where: "home", villageId: v.id };
  for (const c of commands)
    if (!c.clan && (c.units.paladin ?? 0) > 0)
      return { where: "marching", commandId: c.id, kind: c.kind, toId: c.toId };
  for (const h of all)
    for (const [origin, st] of Object.entries(h.stationed ?? {}))
      if (
        (st.paladin ?? 0) > 0 &&
        (h.owner === PLAYER || villages[origin]?.owner === PLAYER)
      )
        return { where: "support", hostId: h.id, originId: origin };
  for (const v of all)
    if (v.owner === PLAYER)
      for (const j of v.recruitQueue)
        if (j.unit === "paladin") return { where: "training", villageId: v.id };
  return null;
}
