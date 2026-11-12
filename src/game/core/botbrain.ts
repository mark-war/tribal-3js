import { UNITS, UNIT_IDS } from "../config/units";
import {
  ATTACK_CLASSES,
  NOBLE_LOYALTY_HIT,
  attackBonusFor,
  attackShares,
  carryCapacity,
  defenseBonusFor,
  defenseRating,
  emptyUnits,
  ramsToBreakWall,
  resolveBattle,
  survivorsOf,
} from "./combat";
import { RES, emptyCost, garrison, hidingProtect, settle } from "./economy";
import {
  BOTS,
  PLAYER,
  botVillages,
  nearestBarbarian,
  normalizeVillage,
  rivalInfo,
  villageAt,
  type Clan,
} from "./world";
import {
  NOBLES_PER_RUN,
  botCanNoble,
  botNobleCost,
  feudOf,
  getIntel,
  intelFresh,
  launchWar,
  noteFeud,
  nobleTrain,
  sendScouts,
  strikePool,
  type LaunchCtx,
} from "./botwar";
import { luckOf } from "./luck";
import type { Stats } from "./ranking";
import type { Command, Cost, Units, Village } from "./types";

/**
 * The bots play like players. Each turn a bot looks at what it can reach (barbarians, other bots, and you), works out what
 * it needs to win, and picks the best target it can really beat. It conquers with nobles only if it has earned them
 * (Academy or a developed village, and the nobles paid for). Every attack is a REAL march that takes time:
 *  - another bot is scouted first, and the army is sized from what the scouts saw;
 *  - the clearing army lands first, then a train of single-noble waves (each wave cuts loyalty once);
 *  - marches against you are raids and noble waves you can see coming; marches against barbarians and other bots are
 *    "strikes" that landStrike resolves when they arrive, with the very same battle rules (and luck) you play by.
 */
const HOUR = 3_600_000;
export const MAX_HOLDINGS = 1000; // villages a bot can take with nobles
export const h01 = (s: string) => {
  // deterministic "random" from a string
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};
const total = (u: Units) => UNIT_IDS.reduce((s, k) => s + u[k], 0);
const attackPower = (u: Units) =>
  UNIT_IDS.reduce((s, k) => s + u[k] * UNITS[k].attack, 0);

export interface Advice {
  targetId: string;
  action: "raid" | "conquer";
  reason: string;
}
export interface TurnCtx {
  now: number;
  world: Record<string, Village>;
  owned: Village[]; // the player's villages
  warOnPlayer: boolean; // mode 'war' and you are not under beginner protection
  skipPlayer: Set<string>; // bots the grudge/raid scheduler already handles
  held: Record<string, number>; // villages each bot has taken with nobles
  advice?: Advice; // an optional plan from the AI advisor (validated here, never trusted)
}
export interface Option {
  id: string;
  label: string;
  kind: "barbarian" | "bot" | "player";
  owner: string | null;
  target: Village;
  dist: number;
  ratio: number;
  viable: boolean;
  loot: number;
  conquer: boolean;
  score: number;
  send: Units;
  weighted: number;
  power: number;
}
export interface TurnResult {
  changed: Record<string, Village>;
  commands: Command[];
  news: string[];
  alerts: string[];
  bumps: [string, Partial<Stats>][];
  held: number;
}

/** What a bot could do right now: its best strike village, and every target in reach with the odds. */
export function planOptions(
  bot: Clan,
  ctx: TurnCtx,
): { src: Village; options: Option[] } | null {
  const mine = botVillages(bot, ctx.world, ctx.now);
  if (!mine.length) return null; // a bot with no villages is out of the game
  const pool = strikePool(bot);
  const strikePower = (v: Village) =>
    pool.reduce((s, u) => s + v.units[u] * UNITS[u].attack, 0);

  // Rough estimate of remaining strike power after we leave troops behind for escorts
  const afterReservePower = (v: Village) => strikePower(v) * 0.6;

  const strongest = mine.reduce((b, v) =>
    strikePower(v) > strikePower(b) ? v : b,
  );
  const canNobleAt = (v: Village) =>
    botCanNoble(v) &&
    RES.every((r) => v.resources[r] >= NOBLES_PER_RUN * botNobleCost(r)) &&
    (ctx.held[bot.id] ?? 0) < MAX_HOLDINGS;
  // A village that can really send nobles is preferred as the source, as long as it is not much weaker than the
  // strongest one (before, only the strongest village was ever checked for an Academy).
  const noblers = mine.filter(canNobleAt);

  const nobler = noblers.length
    ? noblers.reduce((b, v) =>
        afterReservePower(v) > afterReservePower(b) ? v : b,
      )
    : undefined;

  const src =
    nobler && afterReservePower(nobler) >= 0.55 * strikePower(strongest)
      ? nobler
      : strongest;

  const have = emptyUnits();
  for (const u of pool) have[u] = src.units[u];
  const power =
    attackPower(have) * attackBonusFor(src.buildings.smithy, have, 0);
  if (power < 150) return { src, options: [] };
  const shares = attackShares(have);
  const canNoble = canNobleAt(src);
  const d = (v: Village) => Math.hypot(v.x - src.x, v.y - src.y);
  const cands: { t: Village; kind: Option["kind"] }[] = [];
  // the three nearest barbarian villages (it used to look at only the nearest one)
  const picked = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const barb = nearestBarbarian(
      [src.x, src.y],
      ctx.now,
      (v) => (ctx.world[v.id]?.owner ?? null) !== null || picked.has(v.id),
    );
    if (!barb || d(barb) > 40) break;
    picked.add(barb.id);
    cands.push({ t: ctx.world[barb.id] ?? barb, kind: "barbarian" });
  }
  for (const b of BOTS) {
    if (
      b.id === bot.id ||
      Math.hypot(b.home[0] - src.x, b.home[1] - src.y) > 55
    )
      continue;
    for (const v of botVillages(b, ctx.world, ctx.now))
      if (d(v) <= 55) cands.push({ t: v, kind: "bot" });
  }
  if (ctx.warOnPlayer && !ctx.skipPlayer.has(bot.id))
    for (const v of ctx.owned)
      if (d(v) <= 70) cands.push({ t: v, kind: "player" });

  const options = cands.map(({ t, kind }): Option => {
    const rating = defenseRating(
      garrison(t),
      t.buildings.wall,
      defenseBonusFor(t.buildings.smithy),
    );
    const weighted = ATTACK_CLASSES.reduce(
      (s, k) => s + shares[k] * rating[k],
      0,
    );
    const need = 1.15 * weighted;
    const frac = Math.min(0.85, need / power);
    const send = emptyUnits();
    for (const u of pool)
      send[u] = Math.min(src.units[u], Math.ceil(src.units[u] * frac));
    if (src.units.ram > 0 && t.buildings.wall >= 2)
      send.ram = Math.min(src.units.ram, ramsToBreakWall(t.buildings.wall));
    const loot = Math.min(
      carryCapacity(send),
      Math.floor(RES.reduce((s, r) => s + t.resources[r], 0) * 0.5),
    );
    const conquer =
      canNoble &&
      power * 0.85 >= (kind === "barbarian" ? 1.4 : 1.3) * weighted &&
      !(kind === "player" && ctx.owned.length <= 1);
    const jitter =
      0.85 + 0.3 * h01(`${bot.id}:${Math.floor(ctx.now / HOUR)}:${t.id}`);
    const dist = d(t);
    // a bot that was hit by this owner recently prefers to hit back
    const grudge =
      kind === "bot" && t.owner && feudOf(bot.id, t.owner, ctx.now) > 0.3
        ? 2.5
        : 1;
    return {
      id: t.id,
      label: `${t.name} (${t.owner ?? "barbarians"})`,
      kind,
      owner: t.owner,
      target: t,
      dist: Math.round(dist),
      ratio: Math.round(((power * 0.85) / Math.max(1, weighted)) * 100) / 100,
      viable: power * 0.85 >= need,
      loot,
      conquer,
      score:
        ((loot + (conquer ? 3000 : 0)) / (1 + dist / 15)) *
        jitter *
        (kind === "bot" ? 1.2 * grudge : 1),
      send,
      weighted,
      power,
    };
  });
  return { src, options };
}

/**
 * A bot's march lands (a clearing army or one noble wave). The same battle rules as yours decide it, luck included.
 * If it wins it carries its loot home (a real march back); a surviving noble cuts loyalty once, and below 1 the village
 * is conquered. If the target changed hands while the army was on the road, the army turns back.
 */
export function landStrike(
  c: Command,
  world: Record<string, Village>,
  now: number,
  bot: Clan,
): TurnResult {
  const out: TurnResult = {
    changed: {},
    commands: [],
    news: [],
    alerts: [],
    bumps: [],
    held: 0,
  };
  const goHome = (units: Units, loot: Cost) => {
    if (total(units) > 0)
      out.commands.push({
        id: `${c.id}-back`,
        kind: "return",
        clan: c.clan,
        fromId: c.toId,
        toId: c.fromId,
        fromXY: c.toXY,
        toXY: c.fromXY,
        units,
        loot,
        departAt: now,
        arriveAt: now + (c.arriveAt - c.departAt),
      });
  };
  const base = world[c.toId] ?? villageAt(c.toXY[0], c.toXY[1], now);
  if (
    !base ||
    base.owner === PLAYER ||
    (base.owner ?? "") !== (c.expectOwner ?? "")
  ) {
    goHome({ ...c.units, noble: 0 }, emptyCost()); // e.g. an earlier noble wave already took it: the rest turn back
    return out;
  }
  const tgt = settle(normalizeVillage(base), now);
  const army = c.units;
  const prevOwner = tgt.owner;
  const defBefore = garrison(tgt);
  const res = resolveBattle(
    army,
    defBefore,
    tgt.buildings.wall,
    attackBonusFor(c.smithy ?? 0, army, 0) * (1 + luckOf(c.id)), // luck: the attacker's strength varies by up to ±25%
    defenseBonusFor(tgt.buildings.smithy),
  );
  tgt.units = survivorsOf(tgt.units, defBefore, res.defenderLeft);
  tgt.stationed = Object.fromEntries(
    Object.entries(tgt.stationed).map(([k, u]) => [
      k,
      survivorsOf(u, defBefore, res.defenderLeft),
    ]),
  );
  tgt.buildings.wall = res.wallAfter;
  const killed = total(defBefore) - total(res.defenderLeft);
  const fell = total(army) - total(res.attackerLeft);
  let looted = 0;
  let conquered = false;
  if (res.attackerWins) {
    const back: Units = { ...res.attackerLeft, noble: 0 };
    if (res.attackerLeft.noble > 0) {
      tgt.loyalty -= NOBLE_LOYALTY_HIT; // one hit per attack, however many nobles came along
      conquered = tgt.loyalty < 1;
    }
    if (conquered) {
      const cav =
        bot.doctrine === "cavalry" ||
        bot.doctrine === "horde" ||
        bot.doctrine === "balanced";
      Object.assign(tgt, {
        owner: bot.name,
        name: `${bot.name} Outpost`,
        loyalty: 25,
        units: back,
        stationed: {},
        buildQueue: [],
        recruitQueue: [],
        goal: undefined,
        buildings: {
          ...tgt.buildings,
          barracks: Math.max(tgt.buildings.barracks, 3),
          smithy: Math.max(tgt.buildings.smithy, 1),
          stable: cav
            ? Math.max(tgt.buildings.stable, 1)
            : tgt.buildings.stable,
        },
      });
      // support that came FROM this village and still stands in other villages is stranded: it is gone
      for (const h of Object.values(world)) {
        if (h.id === tgt.id || !h.stationed?.[tgt.id]) continue;
        const rest = { ...h.stationed };
        delete rest[tgt.id];
        out.changed[h.id] = { ...h, stationed: rest };
      }
      out.held++;
      out.news.push(
        `👑 ${bot.name} conquered ${prevOwner ? `${prevOwner}'s village` : "the barbarian village"} ${tgt.id}`,
      );
    } else {
      const loot = emptyCost();
      const carry = carryCapacity(back);
      const safe = hidingProtect(tgt.buildings.hiding);
      for (const r of RES) {
        const take = Math.min(
          Math.max(0, Math.floor(tgt.resources[r]) - safe),
          Math.floor(carry / 3),
        );
        tgt.resources[r] -= take;
        loot[r] = take;
        looted += take;
      }
      goHome(back, loot); // the survivors walk home with the loot
      out.news.push(
        prevOwner
          ? `⚔ ${bot.name} raided ${prevOwner} at ${tgt.id}${looted ? ` and carried off ${looted} resources` : ""}`
          : `🌾 ${bot.name} raided the barbarian village ${tgt.id}`,
      );
    }
  }
  // the victim remembers who hit it
  const victim = prevOwner ? rivalInfo(prevOwner) : null;
  if (victim)
    noteFeud(
      victim.id,
      bot.name,
      conquered ? 3 : res.attackerWins ? 1 : 0.5,
      now,
    );
  out.changed[tgt.id] = tgt;
  out.bumps.push([bot.name, { kills: killed, lost: fell, looted }]);
  if (prevOwner && rivalInfo(prevOwner))
    out.bumps.push([prevOwner, { kills: fell, lost: killed }]);
  return out;
}

/** One bot's turn. Pure: returns what changed (launching a march changes the source village and adds commands). */
export function botTurn(bot: Clan, ctx: TurnCtx): TurnResult {
  const out: TurnResult = {
    changed: {},
    commands: [],
    news: [],
    alerts: [],
    bumps: [],
    held: 0, // conquests are counted when the nobles land (landStrike / the store)
  };
  const plan = planOptions(bot, ctx);
  const viable = plan?.options.filter((o) => o.viable) ?? [];
  if (!plan || !viable.length) return out;
  const advised = ctx.advice
    ? viable.find((o) => o.id === ctx.advice!.targetId)
    : undefined; // an AI plan is only followed if it is a real, winnable option
  const pick = advised ?? viable.reduce((b, o) => (o.score > b.score ? o : b));
  const conquer =
    pick.conquer &&
    (advised
      ? ctx.advice!.action === "conquer"
      : h01(`${bot.id}:c:${Math.floor(ctx.now / HOUR)}`) < 0.7);

  // everything it launches goes through this: commands land in `out`, the source village in `out.changed`
  const lc: LaunchCtx = {
    now: ctx.now,
    raids: out.commands,
    alerts: [],
    news: [],
    changed: out.changed,
  };
  const flush = () => {
    out.alerts.push(...lc.alerts.map((a) => a.text));
    out.news.push(...lc.news.map((n) => n.text));
  };

  const pool = strikePool(bot);
  const have = emptyUnits();
  for (const u of pool) have[u] = plan.src.units[u];
  const shares = attackShares(have);
  let weighted = pick.weighted;

  // Another bot is scouted first (it takes a real march), then attacked with what the scouts saw.
  if (pick.kind === "bot") {
    const seen = getIntel(bot.id, pick.target.id);
    if (seen?.pendingUntil && seen.pendingUntil > ctx.now) return out; // scouts are on their way
    if (!intelFresh(seen, ctx.now)) {
      sendScouts(
        lc,
        bot,
        settle(normalizeVillage(plan.src), ctx.now),
        pick.target,
      );
      return out; // it will look again on its next turn
    }
    weighted = ATTACK_CLASSES.reduce(
      (s, k) => s + shares[k] * (seen.rating[k] ?? 0),
      0,
    );
    if (pick.power * 0.85 < (conquer ? 1.3 : 1.15) * weighted) return out; // what the scouts saw is too strong
  }

  // --- build the clearing force ---
  const send = emptyUnits();
  const baseMult = conquer ? 1.35 : 1.15; // slightly higher safety for conquers
  const frac = Math.min(0.88, (baseMult * weighted) / pick.power);

  for (const u of pool) {
    send[u] = Math.min(plan.src.units[u], Math.ceil(plan.src.units[u] * frac));
  }
  if (plan.src.units.ram > 0 && pick.target.buildings.wall >= 2) {
    send.ram = Math.min(
      plan.src.units.ram,
      ramsToBreakWall(pick.target.buildings.wall),
    );
  }

  const src = settle(normalizeVillage(plan.src), ctx.now);
  const waves = conquer
    ? nobleTrain(src, `${bot.id}:${pick.target.id}:${Math.floor(ctx.now)}`)
    : 0;

  // --- smarter escort reservation (only when sending nobles) ---
  if (waves > 0) {
    // How much of the planned clear we are willing to leave behind for escorts.
    // Barbarians are less predictable (no scouting), so leave a bit more.
    const isBarb = pick.kind === "barbarian";
    const leaveFrac = isBarb ? 0.42 : 0.34;

    // Never leave so much that the clear becomes too weak.
    // We still want the clear to be at least ~1.15× the expected defense.
    const minClearFrac = 0.55;

    for (const u of pool) {
      const planned = send[u];
      if (planned <= 0) continue;

      const leave = Math.floor(planned * leaveFrac);
      const afterLeave = planned - leave;

      // Safety: don't gut the clear below a usable size
      const floor = Math.ceil(planned * minClearFrac);
      send[u] = Math.max(floor, afterLeave);
    }

    // Extra safety for long trains: later waves get weaker escorts anyway,
    // so make sure the first 3–4 waves are properly protected.
    if (waves >= 5) {
      for (const u of pool) {
        send[u] = Math.floor(send[u] * 0.92); // shave a little more off the clear
      }
    }
  }

  launchWar(lc, bot, src, pick.target, send, waves);
  flush();
  return out;
}
