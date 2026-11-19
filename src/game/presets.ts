import { UNITS, UNIT_IDS } from "./config/units";
import type { Preset, UnitId, Units } from "./core/types";

export const PRESETS_VERSION = 2;

/** In a preset, a unit count of -1 means "all I have of it": the preset stays up to date as your army grows. */
export const ALL = -1;
const OFFENSE = UNIT_IDS.filter((u) => UNITS[u].role === "offense");
const DEFENSE: UnitId[] = ["spear", "sword", "archer", "heavy"];
const all = (ids: UnitId[]) => Object.fromEntries(ids.map((u) => [u, ALL]));

/** The presets every game starts with. They are ordinary presets: rename, change, update or delete them like your own. */
export const DEFAULT_PRESETS: Preset[] = [
  {
    id: "default-garrison",
    name: "🛡 Garrison",
    waves: [{ kind: "support", units: all(DEFENSE), offset: 0, cat: "wall" }],
  },
  {
    id: "default-strike",
    name: "⚔ Strike",
    waves: [{ kind: "attack", units: all(OFFENSE), offset: 0, cat: "wall" }],
  },
  {
    id: "default-raid",
    name: "🐎 Raid",
    waves: [
      {
        kind: "attack",
        units: all(["light", "mounted"]),
        offset: 0,
        cat: "wall",
      },
    ],
  },
  {
    id: "default-scout",
    name: "🔍 Scout",
    waves: [{ kind: "scout", units: { scout: ALL }, offset: 0, cat: "wall" }],
  },
  {
    id: "default-noble-train",
    name: "👑 Noble train",
    waves: [
      { kind: "attack", units: all(OFFENSE), offset: 0, cat: "wall" }, // the clearing wave: everything that is left
      ...[0, 1, 2, 3].map((i) => ({
        kind: "attack" as const,
        units: { noble: 1, axe: 15 },
        offset: 0.5 + i * 0.3,
        cat: "wall" as const,
      })), // one noble per attack, each with 15 axemen
    ],
  },
];

/**
 * Turn drafts into real armies. Fixed numbers are given out first (in wave order), a noble wave with no noble left is dropped
 * (an escort alone is pointless), and the waves marked "all" take what is left.
 */
export function resolveWaves(
  ws: { units: Partial<Units> }[],
  have: Units,
): Units[] {
  const left = { ...have };
  const out: Record<string, number>[] = ws.map(() => ({}));
  ws.forEach((w, i) => {
    for (const u of UNIT_IDS) {
      const n = w.units[u] ?? 0;
      if (n >= 0) {
        const g = Math.max(0, Math.min(Math.floor(n), left[u]));
        out[i][u] = g;
        left[u] -= g;
      }
    }
  });
  ws.forEach((w, i) => {
    if ((w.units.noble ?? 0) > 0 && !out[i].noble)
      for (const u of UNIT_IDS) {
        left[u] += out[i][u] ?? 0;
        out[i][u] = 0;
      }
  });
  ws.forEach((w, i) => {
    for (const u of UNIT_IDS)
      if ((w.units[u] ?? 0) < 0) {
        out[i][u] = left[u];
        left[u] = 0;
      }
  });
  return out.map(
    (o) => Object.fromEntries(UNIT_IDS.map((u) => [u, o[u] ?? 0])) as Units,
  );
}
