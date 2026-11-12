import { UNITS, UNIT_IDS } from "../config/units";
import {
  ATTACK_CLASSES,
  attackBonusFor,
  attackShares,
  carryCapacity,
  defenseBonusFor,
  defenseRating,
  emptyUnits,
  loyaltyHit,
  luckFor,
  ramPostLevels,
  ramsToBreakWall,
  resolveBattle,
  resolveScout,
  survivorsOf,
} from "./combat";
import {
  MERCHANT_CAPACITY,
  RES,
  SPEED,
  capacity,
  emptyCost,
  garrison,
  hidingProtect,
  meetsReq,
  merchantsFree,
  settle,
  tradeMs,
  travelMs,
} from "./economy";
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
import type { Stats } from "./ranking";
import type { Command, Cost, Units, UnitId, Village } from "./types";

/**
 * The bots play like players. A bot only knows what its scouts told it: before it attacks anything it sends scouts, and it sizes
 * its army from that report (which can be out of date), exactly as you would. It conquers with a NOBLE TRAIN: a clearing wave
 * with its strike force, then four waves landing right behind it, one noble (with a small escort) in each, because only one noble
 * works per attack. A threatened bot village calls for help from its other villages. All fights use your battle rules.
 */
const STRIKE: UnitId[] = ["axe", "light", "mounted"]; // what attackers are made of; defenders stay home
const HOUR = 3_600_000;
export const MAX_HOLDINGS = 6; // villages a bot can take with nobles
const TRAIN_GAP_MS = 400; // noble waves land this far behind each other
export const freshMs = () => (60 * HOUR) / SPEED; // a scouting report is trusted for 60 game hours (a bot gets a turn about every 25)
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
const pickUnits = (
  v: Village,
  ids: UnitId[],
  f: (n: number, u: UnitId) => number,
): Units => {
  const o = emptyUnits();
  for (const u of ids)
    o[u] = Math.max(0, Math.min(v.units[u], f(v.units[u], u)));
  return o;
};

export interface Advice {
  targetId: string;
  action: "raid" | "conquer";
  reason: string;
}
/** What a bot learned from its scouts (or from its last fight) about a village. */
export interface BotIntel {
  at: number;
  tier: 1 | 2 | 3;
  units?: Units;
  wall?: number;
  smithy?: number;
  tries?: number;
  lastSent?: number;
}
export type Stance = "no" | "raid" | "conquer";
export interface TurnCtx {
  now: number;
  world: Record<string, Village>;
  owned: Village[]; // the player's villages
  stance: Stance; // what this bot may do to YOU right now (nothing / raid / conquer)
  held: Record<string, number>; // villages each bot has taken with nobles
  commands: Command[]; // everything on the road (to know which merchants are busy)
  intel: Record<string, BotIntel>; // this bot's reports about villages
  advice?: Advice; // an optional plan from the AI advisor (validated here, never trusted)
}
export interface Option {
  id: string;
  label: string;
  kind: "barbarian" | "bot" | "player";
  owner: string | null;
  target: Village;
  known: boolean; // does the bot have a fresh report about it?
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
  intel: [string, string, BotIntel][];
  scoutNote?: {
    toId: string;
    botName: string;
    lost: number;
    killed: number;
    sent: number;
  };
}
const newResult = (): TurnResult => ({
  changed: {},
  commands: [],
  news: [],
  alerts: [],
  bumps: [],
  held: 0,
  intel: [],
});

export const mergeIntel = (
  old: Record<string, BotIntel> | undefined,
  id: string,
  info: BotIntel,
  now: number,
) => {
  const keep = Object.entries({ ...(old ?? {}), [id]: info })
    .filter(([, i]) => now - i.at < 3 * freshMs())
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 15);
  return Object.fromEntries(keep);
};

/** What a bot could do right now: its best strike village, and every target in reach (with odds ONLY where it has a report). */
export function planOptions(
  bot: Clan,
  ctx: TurnCtx,
): { src: Village; options: Option[] } | null {
  const mine = botVillages(bot, ctx.world, ctx.now);
  if (!mine.length) return null; // a bot with no villages is out of the game
  const strikePower = (v: Village) =>
    STRIKE.reduce((s, u) => s + v.units[u] * UNITS[u].attack, 0);
  const src = mine.reduce((b, v) => (strikePower(v) > strikePower(b) ? v : b));
  const have = emptyUnits();
  for (const u of STRIKE) have[u] = src.units[u];
  const power =
    attackPower(have) * attackBonusFor(src.buildings.smithy, have, 0);
  const shares = attackShares(have);
  const canNoble =
    meetsReq(src, "noble") &&
    RES.every((r) => src.resources[r] >= 4 * UNITS.noble.cost[r]) &&
    (ctx.held[bot.id] ?? 0) < MAX_HOLDINGS;
  const d = (v: Village) => Math.hypot(v.x - src.x, v.y - src.y);
  const cands: { t: Village; kind: Option["kind"] }[] = [];
  const barb = nearestBarbarian(
    [src.x, src.y],
    ctx.now,
    (v) => (ctx.world[v.id]?.owner ?? null) !== null,
  );
  if (barb && d(barb) <= 40)
    cands.push({ t: ctx.world[barb.id] ?? barb, kind: "barbarian" });
  for (const b of BOTS) {
    if (
      b.id === bot.id ||
      Math.hypot(b.home[0] - src.x, b.home[1] - src.y) > 55
    )
      continue;
    for (const v of botVillages(b, ctx.world, ctx.now))
      if (d(v) <= 55) cands.push({ t: v, kind: "bot" });
  }
  if (ctx.stance !== "no")
    for (const v of ctx.owned)
      if (d(v) <= 70) cands.push({ t: v, kind: "player" });

  const options = cands.map(({ t, kind }): Option => {
    const info = ctx.intel[t.id];
    const known =
      !!info &&
      info.units !== undefined &&
      info.wall !== undefined &&
      ctx.now - info.at <= freshMs();
    const dist = d(t);
    const jitter =
      0.85 + 0.3 * h01(`${bot.id}:${Math.floor(ctx.now / HOUR)}:${t.id}`);
    const base = {
      id: t.id,
      label: `${t.name} (${t.owner ?? "barbarians"})`,
      kind,
      owner: t.owner,
      target: t,
      known,
      dist: Math.round(dist),
    };
    if (!known || power < 150) {
      // no report: the bot can only guess from what everybody sees on the map (the points)
      const beatable = power * 0.85 >= 2.5 * t.points; // from the points on the map, is it worth a look at all?
      const stuck =
        !beatable ||
        ((info?.tries ?? 0) >= 3 &&
          src.units.scout < (info?.lastSent ?? 0) * 2); // too big, or it keeps failing: leave it      // it keeps failing and cannot send enough scouts: leave it for now
      return {
        ...base,
        ratio: 0,
        viable: false,
        loot: 0,
        conquer: false,
        score:
          (t.points / (1 + dist / 15)) *
          jitter *
          (kind === "bot" ? 1.2 : 1) *
          (stuck ? 0.05 : 1),
        send: emptyUnits(),
        weighted: 0,
        power,
      };
    }
    const rating = defenseRating(
      info.units!,
      info.wall!,
      defenseBonusFor(info.smithy ?? 0),
    ); // what its LAST report says, not what is there now
    const weighted = ATTACK_CLASSES.reduce(
      (s, k) => s + shares[k] * rating[k],
      0,
    );
    const need = 1.15 * weighted;
    const frac = Math.min(0.85, need / power);
    const send = pickUnits(src, STRIKE, (n) => Math.ceil(n * frac));
    if (src.units.ram > 0 && info.wall! >= 2)
      send.ram = Math.min(src.units.ram, ramsToBreakWall(info.wall!));
    const stock = RES.reduce((s, r) => s + t.resources[r], 0); // loot is guessed from the village's points
    const loot = Math.min(
      carryCapacity(send),
      Math.floor(Math.min(stock, t.points * 40) * 0.5),
    );
    const conquer =
      canNoble &&
      power * 0.75 >= 1.3 * weighted &&
      !(
        kind === "player" &&
        (ctx.stance !== "conquer" || ctx.owned.length <= 1)
      );
    return {
      ...base,
      ratio: Math.round(((power * 0.85) / Math.max(1, weighted)) * 100) / 100,
      viable: power * 0.85 >= need,
      loot,
      conquer,
      score:
        ((loot + (conquer ? 3000 : 0)) / (1 + dist / 15)) *
        jitter *
        (kind === "bot" ? 1.2 : 1),
      send,
      weighted,
      power,
    };
  });
  return { src, options };
}

/** Put marches on the road so that wave i lands `offset` ms after the first one. Edits `out`. */
function launchWaves(
  bot: Clan,
  srcIn: Village,
  t: Village,
  kinds: Command["kind"][],
  waves: { units: Units; offset: number }[],
  ctx: TurnCtx,
  out: TurnResult,
) {
  const src = settle(normalizeVillage(srcIn), ctx.now);
  let nobles = 0;
  for (const w of waves) {
    for (const u of UNIT_IDS)
      if (u !== "noble") src.units[u] = Math.max(0, src.units[u] - w.units[u]);
    nobles += w.units.noble;
  }
  if (nobles > 0)
    for (const r of RES)
      src.resources[r] -= (nobles / 4) * 4 * UNITS.noble.cost[r]; // each noble is paid for in full
  out.changed[src.id] = src;
  const ms = waves.map((w) => travelMs([src.x, src.y], [t.x, t.y], w.units));
  const T = ctx.now + Math.max(...waves.map((w, i) => ms[i] - w.offset)) + 2000; // the first wave lands at T, the others right behind it
  waves.forEach((w, i) =>
    out.commands.push({
      id: `${kinds[i]}-${bot.id}-${Math.floor(ctx.now)}-w${i}`,
      kind: kinds[i],
      fromId: src.id,
      toId: t.id,
      fromXY: [src.x, src.y],
      toXY: [t.x, t.y],
      units: w.units,
      loot: emptyCost(),
      departAt: T + w.offset - ms[i],
      arriveAt: T + w.offset,
      smithy: src.buildings.smithy,
      clan: bot.name,
      expectOwner: t.owner ?? "",
    }),
  );
  if (t.owner === PLAYER) {
    const mins = Math.max(1, Math.round((T - ctx.now) / 60000));
    out.alerts.push(
      nobles > 0
        ? `👑 ${bot.name} is sending a NOBLE TRAIN from ${src.id} at ${t.name}: ${waves.length} waves, the first lands in ${mins} min, and each noble that gets through cuts the loyalty by 20–35`
        : `⚠ ${bot.name} raiders from ${src.id} are marching on ${t.name}: they land in ${mins} min`,
    );
  }
}

/** Keep every village of the bot stocked: a rich village with merchants sends to a poor one (real caravans). */
export function balanceTrade(
  bot: Clan,
  world: Record<string, Village>,
  commands: Command[],
  now: number,
): TurnResult {
  const out = newResult();
  const mine = botVillages(bot, world, now);
  if (mine.length < 2) return out;
  const busy = [...commands];
  for (const donor0 of mine) {
    if (donor0.buildings.market < 1 || merchantsFree(donor0, busy) < 1)
      continue;
    for (const r of RES) {
      const cap = capacity(donor0);
      if (donor0.resources[r] < 0.7 * cap) continue;
      const poor = mine
        .filter(
          (v) => v.id !== donor0.id && v.resources[r] < 0.25 * capacity(v),
        )
        .sort((p, q) => p.resources[r] - q.resources[r])[0];
      if (!poor) continue;
      const free = merchantsFree(donor0, busy);
      const amount = Math.floor(
        Math.min(
          donor0.resources[r] - 0.4 * cap,
          0.5 * capacity(poor) - poor.resources[r],
          free * MERCHANT_CAPACITY,
        ),
      );
      if (amount < 500) continue;
      const donor =
        out.changed[donor0.id] ?? settle(normalizeVillage(donor0), now);
      donor.resources[r] -= amount;
      out.changed[donor.id] = donor;
      const cargo: Cost = { ...emptyCost(), [r]: amount };
      const c: Command = {
        id: `trade-${bot.id}-${Math.floor(now)}-${donor.id}-${r}`,
        kind: "trade",
        fromId: donor.id,
        toId: poor.id,
        fromXY: [donor.x, donor.y],
        toXY: [poor.x, poor.y],
        units: emptyUnits(),
        loot: cargo,
        merchants: Math.ceil(amount / MERCHANT_CAPACITY),
        departAt: now,
        arriveAt: now + tradeMs([donor.x, donor.y], [poor.x, poor.y]),
        clan: bot.name,
      };
      out.commands.push(c);
      busy.push(c);
      out.bumps.push([bot.name, { sent: amount }]);
    }
  }
  return out;
}

/** One bot's turn. Pure: returns what changed. */
export function botTurn(bot: Clan, ctx: TurnCtx): TurnResult {
  const out = newResult();
  const trade = balanceTrade(bot, ctx.world, ctx.commands, ctx.now);
  Object.assign(out.changed, trade.changed);
  out.commands.push(...trade.commands);
  out.bumps.push(...trade.bumps);
  const plan = planOptions(bot, {
    ...ctx,
    world: { ...ctx.world, ...out.changed },
  });
  if (!plan) return out;
  const src = plan.src;
  const viable = plan.options.filter((o) => o.known && o.viable);

  // ---- no report on anything worth hitting: scout first (and a bot with no scouts can only train some) ----
  if (!viable.length) {
    const unknown = plan.options.filter((o) => !o.known);
    if (!unknown.length || src.units.scout < 1) return out;
    const best = unknown.reduce((b, o) => (o.score > b.score ? o : b));
    const prev = ctx.intel[best.id];
    const n = Math.min(
      src.units.scout,
      Math.max(best.kind === "barbarian" ? 2 : 8, (prev?.lastSent ?? 0) * 2),
    ); // after a failure it doubles the scouts
    launchWaves(
      bot,
      src,
      best.target,
      ["scout"],
      [{ units: { ...emptyUnits(), scout: n }, offset: 0 }],
      ctx,
      out,
    );
    return out;
  }

  const advised = ctx.advice
    ? viable.find((o) => o.id === ctx.advice!.targetId)
    : undefined; // an AI plan is only followed if it is a real, winnable option
  const pick = advised ?? viable.reduce((b, o) => (o.score > b.score ? o : b));
  const t = pick.target;
  const toPlayer = pick.kind === "player";
  let conquer =
    pick.conquer &&
    (advised
      ? ctx.advice!.action === "conquer"
      : h01(`${bot.id}:c:${Math.floor(ctx.now / HOUR)}`) < 0.7);
  const frac = Math.min(
    conquer ? 0.6 : 0.85,
    ((conquer ? 1.3 : 1.15) * pick.weighted) / pick.power,
  );
  const clear = pickUnits(src, STRIKE, (n) => Math.ceil(n * frac));
  if (src.units.ram > 0 && (ctx.intel[t.id]?.wall ?? 0) >= 2)
    clear.ram = Math.min(src.units.ram, ramsToBreakWall(ctx.intel[t.id].wall!));
  const baseKind: Command["kind"] = toPlayer ? "raid" : "strike";

  if (conquer) {
    // a NOBLE TRAIN: the clearing wave, then four waves behind it with ONE noble each (only one noble works per attack), every one with a small escort
    const rest = emptyUnits();
    for (const u of STRIKE) rest[u] = src.units[u] - clear[u];
    const wall = ctx.intel[t.id]?.wall ?? 0;
    const wallLeft = Math.max(
      0,
      wall -
        ramPostLevels(
          Math.round(clear.ram * 0.9),
          Math.round(clear.ram * 0.1),
          wall,
        ),
    ); // what the surviving rams of the clearing wave leave standing
    const wallDefense = defenseRating(emptyUnits(), wallLeft).infantry; // what the wall alone defends with when the nobles arrive
    const share = pickUnits({ ...src, units: rest } as Village, STRIKE, (n) =>
      Math.floor(n / 4),
    ); // at most a quarter of what is left for each noble
    const wanted = Math.max(200, 2 * wallDefense); // an escort twice as strong as it needs to be
    const f = Math.min(1, wanted / Math.max(1, attackPower(share)));
    const escort = pickUnits({ ...src, units: share } as Village, STRIKE, (n) =>
      Math.ceil(n * f),
    );
    if (attackPower(escort) >= Math.max(120, 1.3 * wallDefense)) {
      const waves = [
        { units: clear, offset: 0 },
        ...[1, 2, 3, 4].map((i) => ({
          units: { ...escort, noble: 1 },
          offset: TRAIN_GAP_MS * i,
        })),
      ];
      launchWaves(
        bot,
        src,
        t,
        [
          baseKind,
          ...[1, 2, 3, 4].map(
            () => (toPlayer ? "expand" : "strike") as Command["kind"],
          ),
        ],
        waves,
        ctx,
        out,
      );
      return out;
    }
    conquer = false; // not enough men left to protect the nobles: a plain raid instead
  }
  launchWaves(bot, src, t, [baseKind], [{ units: clear, offset: 0 }], ctx, out);
  return out;
}

/**
 * A bot's march lands. The same battle rules as yours decide it. If it wins it carries its loot home (a real march back);
 * the noble in a wave cuts the loyalty (20-35, one per attack) and the village falls at 0. If the target changed hands on the
 * road, the army turns back. A bot that wins now knows what the village looks like (its report).
 */
export function landStrike(
  c: Command,
  world: Record<string, Village>,
  now: number,
  bot: Clan,
  luckOn = true,
): TurnResult {
  const out = newResult();
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
    goHome({ ...c.units, noble: 0 }, emptyCost());
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
    attackBonusFor(c.smithy ?? 0, army, 0) * (luckOn ? luckFor(c.id) : 1),
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
  if (res.attackerWins) {
    const back: Units = { ...res.attackerLeft, noble: 0 };
    let conquered = false;
    if (res.attackerLeft.noble > 0) {
      tgt.loyalty -= loyaltyHit(c.id);
      conquered = tgt.loyalty < 1;
    } // one noble per attack
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
      if (prevOwner)
        out.news.push(
          `⚔ ${bot.name} raided ${prevOwner} at ${tgt.id}${looted ? ` and carried off ${looted} resources` : ""}`,
        );
    }
    out.intel.push([
      bot.id,
      tgt.id,
      {
        at: now,
        tier: 3,
        units: garrison(tgt),
        wall: tgt.buildings.wall,
        smithy: tgt.buildings.smithy,
      },
    ]); // it saw the village with its own eyes
  }
  out.changed[tgt.id] = tgt;
  out.bumps.push([bot.name, { kills: killed, lost: fell, looted }]);
  if (prevOwner && rivalInfo(prevOwner))
    out.bumps.push([prevOwner, { kills: fell, lost: killed }]);
  return out;
}

/** A bot's scouts arrive: they duel the village's own scouts (same rules as yours), and the survivors bring a report home. */
export function landScout(
  c: Command,
  world: Record<string, Village>,
  now: number,
  bot: Clan,
  prev?: BotIntel,
): TurnResult {
  const out = newResult();
  const sent = c.units.scout;
  const base = world[c.toId] ?? villageAt(c.toXY[0], c.toXY[1], now);
  const back = (n: number) => {
    if (n > 0)
      out.commands.push({
        id: `${c.id}-back`,
        kind: "return",
        clan: c.clan,
        fromId: c.toId,
        toId: c.fromId,
        fromXY: c.toXY,
        toXY: c.fromXY,
        units: { ...emptyUnits(), scout: n },
        loot: emptyCost(),
        departAt: now,
        arriveAt: now + (c.arriveAt - c.departAt),
      });
  };
  if (!base || (base.owner ?? "") !== (c.expectOwner ?? "")) {
    back(sent);
    return out;
  }
  const tgt = settle(normalizeVillage(base), now);
  const r = resolveScout(sent, garrison(tgt).scout);
  tgt.units.scout = Math.max(0, tgt.units.scout - r.defenderLost); // they lose scouts too
  out.changed[tgt.id] = tgt;
  back(r.left);
  if (r.tier >= 2)
    out.intel.push([
      bot.id,
      tgt.id,
      {
        at: now,
        tier: r.tier as 2 | 3,
        units: garrison(tgt),
        wall: tgt.buildings.wall,
        smithy: tgt.buildings.smithy,
      },
    ]);
  else
    out.intel.push([
      bot.id,
      tgt.id,
      { at: now, tier: 1, tries: (prev?.tries ?? 0) + 1, lastSent: sent },
    ]); // it saw nothing useful: next time it sends more
  out.scoutNote = {
    toId: tgt.id,
    botName: bot.name,
    lost: r.lost,
    killed: r.defenderLost,
    sent,
  };
  return out;
}

/**
 * A threatened bot village calls for help: every other village of the same bot that can get defenders there BEFORE the attack lands
 * sends up to half of them as support, which stays and defends like any stationed troops. Returns the support marches and the ids answered.
 */
export function botDefend(
  world: Record<string, Village>,
  commands: Command[],
  now: number,
  answered: Set<string>,
) {
  const changed: Record<string, Village> = {};
  const out: Command[] = [];
  const ids: string[] = [];
  const w = { ...world };
  for (const c of commands) {
    if (
      !["attack", "raid", "strike", "expand"].includes(c.kind) ||
      c.arriveAt <= now ||
      answered.has(c.id)
    )
      continue;
    const t = w[c.toId];
    const owner = t?.owner ?? null;
    const bot = owner ? BOTS.find((b) => b.name === owner) : undefined;
    ids.push(c.id);
    if (!t || !bot || c.clan === owner) continue;
    for (const h0 of botVillages(bot, w, now)) {
      if (h0.id === t.id) continue;
      const send = emptyUnits();
      for (const u of UNIT_IDS)
        if (
          (UNITS[u].role === "defense" || UNITS[u].role === "hybrid") &&
          u !== "paladin"
        )
          send[u] = Math.floor(h0.units[u] / 2);
      if (total(send) < 5) continue;
      const ms = travelMs([h0.x, h0.y], [t.x, t.y], send);
      if (now + ms + 500 >= c.arriveAt) continue; // it would arrive too late
      const h = settle(normalizeVillage(h0), now);
      for (const u of UNIT_IDS) h.units[u] -= send[u];
      changed[h.id] = h;
      w[h.id] = h;
      out.push({
        id: `help-${c.id}-${h.id}`,
        kind: "support",
        fromId: h.id,
        toId: t.id,
        fromXY: [h.x, h.y],
        toXY: [t.x, t.y],
        units: send,
        loot: emptyCost(),
        departAt: now,
        arriveAt: now + ms,
        clan: bot.name,
      });
    }
  }
  return { changed, commands: out, ids };
}

/** When the danger has passed, support that a bot stationed in one of its own villages walks home. */
export function botRecallSupport(
  world: Record<string, Village>,
  commands: Command[],
  now: number,
) {
  const changed: Record<string, Village> = {};
  const out: Command[] = [];
  for (const h of Object.values(world)) {
    if (!rivalInfo(h.owner)) continue;
    const threatened = commands.some(
      (c) =>
        c.toId === h.id &&
        ["attack", "raid", "strike", "expand"].includes(c.kind) &&
        c.arriveAt > now,
    );
    if (threatened) continue;
    for (const [from, st] of Object.entries(h.stationed ?? {})) {
      const home = world[from];
      if (!home || home.owner !== h.owner || total(st) === 0) continue;
      const rest = { ...h.stationed };
      delete rest[from];
      changed[h.id] = { ...(changed[h.id] ?? h), stationed: rest };
      out.push({
        id: `home-${h.id}-${from}-${Math.floor(now)}`,
        kind: "return",
        clan: h.owner ?? undefined,
        fromId: h.id,
        toId: from,
        fromXY: [h.x, h.y],
        toXY: [home.x, home.y],
        units: st,
        loot: emptyCost(),
        departAt: now,
        arriveAt: now + travelMs([h.x, h.y], [home.x, home.y], st),
      });
    }
  }
  return { changed, commands: out };
}
