import { UNITS, UNIT_IDS } from "../config/units";
import {
  ATTACK_CLASSES,
  HERO_XP_CONQUEST,
  HERO_XP_WIN,
  attackBonusFor,
  attackShares,
  carryCapacity,
  defenseBonusFor,
  defenseRating,
  emptyUnits,
  heroLevel,
  loyaltyHit,
  ramPostLevels,
  ramsToBreakWall,
  resolveBattle,
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
  merchantsFree,
  settle,
  tradeMs,
  travelMs,
} from "./economy";
import { luckOf } from "./luck";
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
  feudOf,
  getIntel,
  intelFresh,
  launchWar,
  nobleTrain,
  noteFeud,
  recordScout,
  sendScouts,
  strikePool,
  type LaunchCtx,
} from "./botwar";
import type { Stats } from "./ranking";
import type { Command, Cost, Units, UnitId, Village } from "./types";

/**
 * The bots play like players. This file DECIDES, core/botwar.ts EXECUTES (scouting, noble trains, reinforcements, feuds).
 * A bot only knows what its scouts told it: before it attacks anything it scouts it, and it sizes its army from that report
 * (which can be out of date), exactly as you would. It conquers with a NOBLE TRAIN: a clearing army, then one wave per noble
 * landing right behind it, because only one noble works per attack. All fights use your battle rules.
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

/**
 * How bold the bots are. Every level still scouts first and only attacks what its report says it can beat; a bolder level
 * just accepts thinner odds, takes its turns more often, launches more attacks per turn, goes after YOU and conquers more often.
 * margin = how many times the target's defense the army must bring (1.15 = a 15% edge; luck can swing a fight by ±25%).
 */
export interface Aggr {
  name: string;
  margin: number;
  gapH: number;
  launches: number;
  player: number;
  conquer: number;
}
export const AGGRESSION: Aggr[] = [
  {
    name: "Calm",
    margin: 1.3,
    gapH: 14,
    launches: 1,
    player: 0.2,
    conquer: 0.5,
  },
  {
    name: "Normal",
    margin: 1.15,
    gapH: 10,
    launches: 1,
    player: 0.4,
    conquer: 0.7,
  },
  {
    name: "Aggressive",
    margin: 1.05,
    gapH: 6,
    launches: 2,
    player: 0.65,
    conquer: 0.85,
  },
  {
    name: "Relentless",
    margin: 1.0,
    gapH: 4,
    launches: 3,
    player: 0.9,
    conquer: 1.0,
  },
];
export interface Advice {
  targetId: string;
  action: "raid" | "conquer";
  reason: string;
}
export type Stance = "no" | "raid" | "conquer";
export interface TurnCtx {
  now: number;
  world: Record<string, Village>;
  owned: Village[]; // the player's villages
  stance: Stance; // what this bot may do to YOU right now (nothing / raid / conquer)
  held: Record<string, number>; // villages each bot has taken with nobles
  commands: Command[]; // everything on the road (to know which merchants are busy)
  grudge?: number; // how much this bot hates YOU (you hit it): it wants to hit back
  aggr?: Aggr; // how bold the bots are (default: Normal)
  heroXp?: number; // this bot's Paladin experience (a bot has one hero, kept as xp: he leads its clearing army)
  exclude?: Set<string>; // targets it already hit or scouted this turn
  advice?: Advice; // an optional plan from the AI advisor (validated here, never trusted)
}
export interface Option {
  id: string;
  label: string;
  kind: "barbarian" | "bot" | "player";
  owner: string | null;
  target: Village;
  known: boolean; // does the bot have a fresh scouting report about it?
  dist: number;
  ratio: number;
  viable: boolean;
  loot: number;
  conquer: boolean;
  score: number;
  stuck?: boolean; // no report and not worth one: too big for the bot, or its scouts keep failing there
  send: Units;
  weighted: number;
  power: number;
}
export interface TurnResult {
  changed: Record<string, Village>;
  commands: Command[];
  news: string[];
  alerts: { id: string; text: string }[];
  bumps: [string, Partial<Stats>][];
  held: number;
  hero?: { botId: string; xp: number; fell?: boolean }; // a march with the bot's Paladin was fought: xp gained, or he fell
}
const newResult = (): TurnResult => ({
  changed: {},
  commands: [],
  news: [],
  alerts: [],
  bumps: [],
  held: 0,
});

/** What a bot could do right now: its best strike village, and every target in reach (with odds ONLY where it has a report). */
export function planOptions(
  bot: Clan,
  ctx: TurnCtx,
): { src: Village; options: Option[]; hero: number } | null {
  const A = ctx.aggr ?? AGGRESSION[3];
  const mine = botVillages(bot, ctx.world, ctx.now);
  if (!mine.length) return null; // a bot with no villages is out of the game
  const pool = strikePool(bot);
  const strikePower = (v: Village) =>
    pool.reduce((s, u) => s + v.units[u] * UNITS[u].attack, 0);
  const src = mine.reduce((b, v) => (strikePower(v) > strikePower(b) ? v : b));
  const have = emptyUnits();
  for (const u of pool) have[u] = src.units[u];
  const heroAway = ctx.commands.some(
    (c) =>
      c.clan === bot.name && (c.heroLevel ?? 0) > 0 && c.arriveAt > ctx.now,
  ); // his army is still on the road
  const hero = heroAway ? 0 : heroLevel(ctx.heroXp ?? 0);
  const power =
    attackPower(have) *
    attackBonusFor(
      src.buildings.smithy,
      { ...have, paladin: hero > 0 ? 1 : 0 },
      hero,
    );
  const targeted = new Set(
    ctx.commands
      .filter(
        (c) =>
          c.clan === bot.name &&
          c.arriveAt > ctx.now &&
          ["strike", "raid", "expand"].includes(c.kind),
      )
      .map((c) => c.toId),
  ); // never send a second army at what it is already attacking
  const shares = attackShares(have);
  const canNoble =
    botCanNoble(src) &&
    nobleTrain(src, `${bot.id}:${Math.floor(ctx.now / HOUR)}`) >=
      NOBLES_PER_RUN - 1 &&
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
  if (ctx.stance !== "no") {
    // like a player with a long list of neighbours: look at the few weakest-looking villages in reach, not at all of them (with 100+ villages that was hundreds of scouting missions)
    const near = ctx.owned
      .filter((v) => d(v) <= 70)
      .sort((a, b) => a.points - b.points || d(a) - d(b))
      .slice(0, 8);
    for (const v of near) cands.push({ t: v, kind: "player" });
  }

  // does this bot go for YOU this turn? always when you hurt it (grudge); otherwise now and then, more often in war mode
  const campaign = Math.floor((ctx.now * SPEED) / (6 * HOUR)); // the same answer for 6 game hours, so a bot that scouts you is still after you when its scouts are back
  const wantsPlayer =
    (ctx.grudge ?? 0) > 0.5 ||
    h01(`${bot.id}:p:${campaign}`) <
      Math.min(1, ctx.stance === "conquer" ? A.player : A.player * 1.25);
  const options = cands
    .filter((c) => !ctx.exclude?.has(c.t.id))
    .map(({ t, kind }): Option => {
      const info = getIntel(bot.id, t.id);
      const known = intelFresh(info, ctx.now); // a fresh report from its scouts (or from its own last fight)
      const dist = d(t);
      const jitter =
        0.85 + 0.3 * h01(`${bot.id}:${Math.floor(ctx.now / HOUR)}:${t.id}`);
      const feud =
        (1 + 2 * Math.min(2, feudOf(bot.id, t.owner ?? "", ctx.now))) *
        (kind === "player" && wantsPlayer ? 100 * (1 + (ctx.grudge ?? 0)) : 1); // it prefers to hit back whoever hit it, and a bot that is allowed to attack YOU sometimes picks you over a barbarian village (you are worth more to it than your few points say)
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
        const waiting = (info?.pendingUntil ?? 0) > ctx.now; // its scouts are still on the way
        const beatable = power * 0.85 >= 2.5 * t.points; // from the points on the map, is it worth a look at all?
        const stuck =
          waiting ||
          !beatable ||
          ((info?.tries ?? 0) >= 3 &&
            src.units.scout < (info?.lastSent ?? 0) * 2);
        return {
          ...base,
          stuck,
          ratio: 0,
          viable: false,
          loot: 0,
          conquer: false,
          score:
            (t.points / (1 + dist / 15)) *
            jitter *
            feud *
            (kind === "barbarian" ? 3 : 1) *
            (stuck ? 0.05 : 1),
          send: emptyUnits(),
          weighted: 0,
          power,
        }; // like any player: farm the easy barbarians first, other players when it is safe
      }
      const rating = info!.rating as Record<string, number>; // what its LAST report says, not what is there now
      const weighted = ATTACK_CLASSES.reduce(
        (s, k) => s + shares[k] * (rating[k] ?? 0),
        0,
      );
      const need = A.margin * weighted;
      const frac = Math.min(0.85, need / power);
      const send = pickUnits(src, pool, (n) => Math.ceil(n * frac));
      if (src.units.ram > 0 && (info!.wall ?? 0) >= 2)
        send.ram = Math.min(src.units.ram, ramsToBreakWall(info!.wall!));
      const stock = RES.reduce((s, r) => s + t.resources[r], 0); // loot is guessed from the village's points
      const loot = Math.min(
        carryCapacity(send),
        Math.floor(Math.min(stock, t.points * 40) * 0.5),
      );
      const conquer =
        canNoble &&
        !targeted.has(t.id) &&
        power * 0.75 >= 1.3 * (A.margin / 1.15) * weighted &&
        !(
          kind === "player" &&
          (ctx.stance !== "conquer" || ctx.owned.length <= 1)
        );
      return {
        ...base,
        ratio: Math.round(((power * 0.85) / Math.max(1, weighted)) * 100) / 100,
        viable: power * 0.85 >= need && !targeted.has(t.id),
        loot,
        conquer,
        score:
          ((loot + (conquer ? 3000 : 0)) / (1 + dist / 15)) *
          jitter *
          feud *
          (kind === "bot" ? 1.2 : 1),
        send,
        weighted,
        power,
      };
    });
  return { src, options, hero };
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

/** One bot's turn. Pure: returns what changed. A bolder bot takes several actions (each from its best village that is left). */
export function botTurn(bot: Clan, ctx: TurnCtx): TurnResult {
  const out = newResult();
  const trade = balanceTrade(bot, ctx.world, ctx.commands, ctx.now);
  Object.assign(out.changed, trade.changed);
  out.commands.push(...trade.commands);
  out.bumps.push(...trade.bumps);
  const A = ctx.aggr ?? AGGRESSION[1];
  const done = new Set<string>(ctx.exclude ?? []);
  for (let k = 0; k < A.launches; k++) {
    const target = oneAction(
      bot,
      {
        ...ctx,
        world: { ...ctx.world, ...out.changed },
        commands: [...ctx.commands, ...out.commands],
        exclude: done,
      },
      out,
      A,
    );
    if (!target) break;
    done.add(target);
  }
  return out;
}

/** Scout or attack once. Returns the target it acted on, or null when there was nothing worth doing. */
function oneAction(
  bot: Clan,
  ctx: TurnCtx,
  out: TurnResult,
  A: Aggr,
): string | null {
  const plan = planOptions(bot, ctx);
  if (!plan) return null;
  const pool = strikePool(bot);
  const s = settle(normalizeVillage(plan.src), ctx.now); // botwar edits this village in place
  const lc: LaunchCtx = {
    now: ctx.now,
    raids: out.commands,
    alerts: out.alerts,
    news: [],
    changed: out.changed,
  };
  const finish = (id: string) => {
    out.news.push(...lc.news.map((n) => n.text));
    return id;
  };
  const viable = plan.options.filter((o) => o.known && o.viable);

  // ---- no report on anything worth hitting: scout first ----
  if (!viable.length) {
    const unknown = plan.options.filter((o) => !o.known && !o.stuck); // never scout what it cannot beat or is already looking at
    const flying = ctx.commands.filter(
      (c) => c.clan === bot.name && c.kind === "scout" && c.arriveAt > ctx.now,
    ).length;
    if (!unknown.length || s.units.scout < 1 || flying >= 2 + A.launches)
      return null; // and never flood the map with scouts
    const best = unknown.reduce((b, o) => (o.score > b.score ? o : b));
    sendScouts(
      lc,
      bot,
      s,
      best.target,
      Math.max(
        best.kind === "barbarian" ? 2 : 8,
        (getIntel(bot.id, best.id)?.lastSent ?? 0) * 2,
      ),
    ); // after a failure it doubles the scouts
    return finish(best.id);
  }

  const advised = ctx.advice
    ? viable.find((o) => o.id === ctx.advice!.targetId)
    : undefined; // an AI plan is only followed if it is a real, winnable option
  const pick = advised ?? viable.reduce((b, o) => (o.score > b.score ? o : b));
  const t = pick.target;
  let conquer =
    pick.conquer &&
    (advised
      ? ctx.advice!.action === "conquer"
      : h01(`${bot.id}:c:${Math.floor(ctx.now / HOUR)}:${t.id}`) < A.conquer);
  const wallSeen = getIntel(bot.id, t.id)?.wall ?? 0;
  let waves = 0;
  if (conquer)
    waves = nobleTrain(s, `${bot.id}:${t.id}:${Math.floor(ctx.now / HOUR)}`);
  const frac = Math.min(
    conquer ? 0.4 : 0.85,
    ((conquer ? 1.3 * (A.margin / 1.15) : A.margin) * pick.weighted) /
      pick.power,
  );
  const clear = pickUnits(s, pool, (n) => Math.ceil(n * frac));
  if (s.units.ram > 0 && wallSeen >= 2)
    clear.ram = Math.min(s.units.ram, ramsToBreakWall(wallSeen));
  if (conquer) {
    // each noble wave brings an escort: it must beat what the wall alone defends with once the clearing wave's rams are done
    const rest = emptyUnits();
    for (const u of pool) rest[u] = s.units[u] - clear[u];
    const escortPower = attackPower(rest) / Math.max(1, waves);
    const wallLeft = Math.max(
      0,
      wallSeen -
        ramPostLevels(
          Math.round(clear.ram * 0.9),
          Math.round(clear.ram * 0.1),
          wallSeen,
        ),
    );
    const wallDefense = defenseRating(emptyUnits(), wallLeft).infantry;
    if (
      waves < NOBLES_PER_RUN - 1 ||
      escortPower < Math.max(150, 1.3 * wallDefense)
    )
      conquer = false; // not enough men to protect the nobles: a plain raid instead
  }
  const first = out.commands.length;
  launchWar(lc, bot, s, t, clear, conquer ? waves : 0);
  if (plan.hero > 0 && out.commands[first])
    out.commands[first].heroLevel = plan.hero; // the Paladin leads the clearing army
  return finish(t.id);
}

/**
 * A bot's march lands. The same battle rules as yours decide it. If it wins it carries its loot home (a real march back);
 * the noble in a wave cuts the loyalty (one noble per attack) and the village falls at 0. If the target changed hands on the
 * road, the army turns back. A bot that wins now knows what the village looks like (its report), and a bot that was hit remembers.
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
    attackBonusFor(
      c.smithy ?? 0,
      { ...army, paladin: c.heroLevel ? 1 : 0 },
      c.heroLevel ?? 0,
    ) * (luckOn ? 1 + luckOf(c.id) : 1),
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
    recordScout(bot.id, tgt.id, now, {
      rating: defenseRating(
        garrison(tgt),
        tgt.buildings.wall,
        defenseBonusFor(tgt.buildings.smithy),
      ),
      wall: tgt.buildings.wall,
    }); // it saw the village with its own eyes
  }
  if (c.heroLevel)
    out.hero = {
      botId: bot.id,
      xp: res.attackerWins
        ? HERO_XP_WIN + (out.held ? HERO_XP_CONQUEST : 0)
        : 0,
      fell: !res.attackerWins,
    }; // his army won: xp; it lost: the Paladin fell
  out.changed[tgt.id] = tgt;
  out.bumps.push([bot.name, { kills: killed, lost: fell, looted }]);
  const victim = prevOwner ? rivalInfo(prevOwner) : null;
  if (victim) {
    out.bumps.push([prevOwner!, { kills: fell, lost: killed }]);
    noteFeud(victim.id, bot.name, res.attackerWins ? 1 : 0.4, now);
  } // it will hit back
  return out;
}
