// core/luck.ts
// Luck, as in the original Tribal Wars: every attack gets a random modifier on the ATTACKER's strength, between
// -25% and +25%. It is drawn from the id of the march that is landing, so it is fixed for that march (the same result
// however many times the game recalculates it, even after a reload) and different for every march.
export const LUCK_RANGE = 0.25; // 0 = no luck at all

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

/** The attacker's luck for the march `seed`: a number from -LUCK_RANGE to +LUCK_RANGE. */
export const luckOf = (seed: string) =>
  (hash(`${seed}:luck`) * 2 - 1) * LUCK_RANGE;

/** For reports: "🍀 luck +12%" or "☘ luck -8%". */
export const luckNote = (luck: number) =>
  ` | ${luck >= 0 ? "🍀" : "☘"} luck ${luck >= 0 ? "+" : ""}${Math.round(luck * 100)}%`;
