// core/botwar.ts  (AI branch version)
// The machinery behind the bots' wars. core/botbrain.ts DECIDES (who to hit, whether to conquer, AI advice); this file
// EXECUTES it with real marches that take time and can be seen, answered and lost:
//   * scouting: a bot scouts another bot before attacking it and sizes its army from what the scouts saw
//   * launchWar: a clearing army, then a train of noble waves (ONE noble per wave, each wave cuts loyalty once)
//   * defendPass: bots reinforce a village that is about to be hit, and call the reinforcements home afterwards
//   * feuds: a bot that was hit remembers who did it and prefers to hit back
// What scouts saw, feuds and the "already answered" list live in memory only (they are not saved): after a reload the
// bots simply scout again, which costs them nothing but a few minutes.
import { UNITS, UNIT_IDS } from "../config/units";
import {
  NOBLE_LOYALTY_HIT,
  attackBonusFor,
  battlePowers,
  defenseBonusFor,
  emptyUnits,
} from "./combat";
import { RES, SPEED, garrison, meetsReq, settle, travelMs } from "./economy";
import {
  BOTS,
  PLAYER,
  botVillages,
  normalizeVillage,
  rivalInfo,
  villageAt,
  type Clan,
} from "./world";
import type { Command, Units, UnitId, Village } from "./types";

const HOUR = 3_600_000;
/** Noble waves needed to take a full-loyalty village (one loyalty hit per wave), plus one spare for losses. */
export const NOBLES_PER_RUN = Math.ceil(100 / NOBLE_LOYALTY_HIT) + 1;
export const NOBLE_TRAIN_MAX = 12; // the longest noble train a bot ever sends
/**
 * Bots pay this share of the normal noble cost. They train their armies from the same stockpile, so with the full price
 * (a noble costs tens of thousands of each resource) almost no bot ever had enough to send a noble train.
 * 1 = full price like a player, 0.25 = a quarter.
 */
export const BOT_NOBLE_COST = 0.25;
export const botNobleCost = (r: (typeof RES)[number]) =>
  Math.ceil(UNITS.noble.cost[r] * BOT_NOBLE_COST);
/**
 * A bot can send nobles with an Academy (Headquarters 20, Smithy 20, Market 10 behind it, like you), or, with this shortcut
 * on, once its Headquarters (10) and Barracks (5) are developed. Without it no bot gets an Academy until the world is
 * many hours old, so nobody expands onto barbarian villages for a long time.
 */
export const BOT_ACADEMY_SHORTCUT = false; // true = bots can send nobles with HQ10 + Barracks5, false = they need an Academy
export const botCanNoble = (v: Village) =>
  meetsReq(v, "noble") ||
  (BOT_ACADEMY_SHORTCUT && v.buildings.main >= 10 && v.buildings.barracks >= 5);
const NOBLE_LAG_MS = 1000; // each noble wave lands this long after the previous one
const ESCORT_SLICE = 0.5; // each noble wave brings this share of the clearing army, so its noble survives
const SCOUTS_PER_MISSION = 2;
const SUPPORT_RANGE = 40; // fields: reinforcements come from villages this close
const DEFEND_VS_PLAYER = true; // bots also reinforce villages YOU are attacking
const intelTtlMs = () => (6 * HOUR) / SPEED; // how long a scouting report stays good
const defendEveryMs = () => (15 * 60_000) / SPEED; // how often bots look at incoming attacks (15 game min)
const feudHalfLifeMs = () => (6 * HOUR) / SPEED;
const HOSTILE: readonly string[] = ["raid", "botwar", "attack"]; // marches that can hit a bot village
const STRIKE: UnitId[] = ["axe", "light", "mounted"];
const DEF_POOL: UnitId[] = ["spear", "sword", "archer", "heavy"];

/** Units a bot attacks with. Turtles own no axes or cavalry, so they use heavy cavalry and swordsmen. */
export const strikePool = (c: Clan): UnitId[] =>
  c.doctrine === "turtle" ? ["heavy", "sword"] : STRIKE;

const h01 = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};
const total = (u: Units) => UNIT_IDS.reduce((s, k) => s + u[k], 0);
const addUnits = (a: Units, b: Units): Units => {
  const o = emptyUnits();
  for (const u of UNIT_IDS) o[u] = a[u] + b[u];
  return o;
};
const dist = (p: Village, q: Village) => Math.hypot(p.x - q.x, p.y - q.y);

/** How many noble waves this village sends: at least NOBLES_PER_RUN, up to about twice that, never more than it can pay for. */
export function nobleTrain(v: Village, seed: string): number {
  const afford = Math.min(
    ...RES.map((r) => Math.floor(v.resources[r] / botNobleCost(r))),
  );
  const want = NOBLES_PER_RUN + Math.round(NOBLES_PER_RUN * h01(seed));
  return Math.max(0, Math.min(afford, want, NOBLE_TRAIN_MAX));
}

// ------------------------------------------------------------------ scouting memory
export interface BotIntel {
  at: number; // when the scouts looked (0 = never)
  rating?: Record<string, number>; // the village's weighted defense per attack class
  wall?: number;
  pendingUntil?: number; // scouts are on their way
}
const INTEL = new Map<string, BotIntel>();
const ikey = (botId: string, villageId: string) => `${botId}|${villageId}`;
export const getIntel = (botId: string, villageId: string) =>
  INTEL.get(ikey(botId, villageId));
export const intelFresh = (
  i: BotIntel | undefined,
  now: number,
): i is BotIntel & { rating: Record<string, number> } =>
  !!i?.rating && now - i.at < intelTtlMs();
function remember(botId: string, villageId: string, i: BotIntel) {
  INTEL.set(ikey(botId, villageId), i);
  if (INTEL.size > 600) {
    // forget the oldest 200
    [...INTEL.entries()]
      .sort(
        (a, b) =>
          (a[1].pendingUntil ?? a[1].at) - (b[1].pendingUntil ?? b[1].at),
      )
      .slice(0, 200)
      .forEach(([k]) => INTEL.delete(k));
  }
}
/** Called by the store when a bot's scouts reach a village. `seen` is set when they got a usable look. */
export function recordScout(
  botId: string,
  villageId: string,
  now: number,
  seen?: { rating: Record<string, number>; wall: number },
) {
  const prev = INTEL.get(ikey(botId, villageId));
  remember(
    botId,
    villageId,
    seen
      ? { at: now, rating: seen.rating, wall: seen.wall }
      : { at: prev?.at ?? 0, rating: prev?.rating, wall: prev?.wall }, // failed: keep what it knew, clear "pending"
  );
}

// ------------------------------------------------------------------ feuds
const FEUDS = new Map<string, { v: number; at: number }>();
/** `victimBotId` was hit by `attackerName`: it will prefer to hit back. */
export function noteFeud(
  victimBotId: string,
  attackerName: string,
  amount: number,
  now: number,
) {
  const k = `${victimBotId}|${attackerName}`;
  FEUDS.set(k, { v: feudOf(victimBotId, attackerName, now) + amount, at: now });
}
export function feudOf(botId: string, ownerName: string, now: number): number {
  const f = FEUDS.get(`${botId}|${ownerName}`);
  return f ? f.v * Math.pow(0.5, (now - f.at) / feudHalfLifeMs()) : 0;
}

// ------------------------------------------------------------------ launching
export interface LaunchCtx {
  now: number;
  world?: Record<string, Village>; // optional: kept in sync when given
  raids: Command[]; // the commands launched (we append)
  alerts: { id: string; text: string }[]; // about YOUR villages
  news: { id: string; text: string }[]; // world news: bots among themselves
  changed: Record<string, Village>;
}
const put = (c: LaunchCtx, v: Village) => {
  c.changed[v.id] = v;
  if (c.world) c.world[v.id] = v;
};

/** Send 2 scouts from `s` (already settled) at `tgt`. Returns false when the village has no scouts to spare. */
export function sendScouts(c: LaunchCtx, bot: Clan, s: Village, tgt: Village) {
  if (s.units.scout < SCOUTS_PER_MISSION) return false;
  const sc: Units = { ...emptyUnits(), scout: SCOUTS_PER_MISSION };
  const ms = travelMs([s.x, s.y], [tgt.x, tgt.y], sc);
  s.units.scout -= SCOUTS_PER_MISSION;
  put(c, s);
  c.raids.push({
    id: `scout-${bot.id}-${tgt.id}-${Math.floor(c.now)}`,
    kind: "scout",
    fromId: s.id,
    toId: tgt.id,
    fromXY: [s.x, s.y],
    toXY: [tgt.x, tgt.y],
    units: sc,
    loot: { wood: 0, clay: 0, iron: 0 },
    departAt: c.now,
    arriveAt: c.now + ms,
    smithy: s.buildings.smithy,
    clan: bot.name,
  });
  const prev = getIntel(bot.id, tgt.id);
  remember(bot.id, tgt.id, {
    at: prev?.at ?? 0,
    rating: prev?.rating,
    wall: prev?.wall,
    pendingUntil: c.now + ms + 5000,
  });
  return true;
}

/**
 * Launch an attack from `s` (already settled) at `tgt`: a clearing army, then `waves` noble waves behind it. Each noble
 * wave is ONE noble plus a small escort slice, lands NOBLE_LAG_MS after the previous one and cuts loyalty once.
 * Pays for and removes everything that leaves.
 * Command kinds: against YOU the clearing army is a "raid" and each noble wave an "expand" (your existing resolvers);
 * against barbarians and other bots everything is "botwar".
 */
export function launchWar(
  c: LaunchCtx,
  bot: Clan,
  s: Village,
  tgt: Village,
  army: Units,
  waves: number,
) {
  const { now } = c;
  const from: [number, number] = [s.x, s.y];
  const to: [number, number] = [tgt.x, tgt.y];
  for (const u of UNIT_IDS) s.units[u] -= army[u];

  // one escort slice per noble wave, taken from what is left at home
  const pool = strikePool(bot);
  const train: Units[] = [];
  for (let i = 0; i < waves; i++) {
    const w = emptyUnits();
    for (const u of pool) {
      const slice = Math.min(
        Math.floor(s.units[u] / (waves - i)),
        Math.max(1, Math.ceil(army[u] * ESCORT_SLICE)),
      );
      w[u] = Math.max(0, slice);
      s.units[u] -= w[u];
    }
    w.noble = 1;
    train.push(w);
  }
  if (waves) for (const r of RES) s.resources[r] -= waves * botNobleCost(r);
  put(c, s);

  const vsPlayer = tgt.owner === PLAYER;
  const clearKind: Command["kind"] = vsPlayer ? "raid" : "botwar";
  const nobleKind: Command["kind"] = vsPlayer ? "expand" : "botwar";
  const ms = travelMs(from, to, army);
  let clearArrive = now + ms;
  let n0 = 0; // when the first noble wave lands
  if (waves) {
    n0 = now + travelMs(from, to, train[0]);
    clearArrive = n0 - NOBLE_LAG_MS; // the clearing army lands just before the first noble
    if (clearArrive < now + ms) {
      clearArrive = now + ms;
      n0 = clearArrive + NOBLE_LAG_MS;
    }
  }
  const id = `war-${bot.id}-${tgt.id}-${Math.floor(now)}`;
  const mk = (
    cid: string,
    kind: Command["kind"],
    units: Units,
    arriveAt: number,
  ): Command => ({
    id: cid,
    kind,
    fromId: s.id,
    toId: tgt.id,
    fromXY: from,
    toXY: to,
    units,
    loot: { wood: 0, clay: 0, iron: 0 },
    departAt: arriveAt - travelMs(from, to, units),
    arriveAt,
    smithy: s.buildings.smithy,
    clan: bot.name,
  });
  c.raids.push(mk(id, clearKind, army, clearArrive));
  train.forEach((w, i) =>
    c.raids.push(mk(`${id}-n${i}`, nobleKind, w, n0 + i * NOBLE_LAG_MS)),
  );

  const mins = Math.max(
    1,
    Math.round(((waves ? n0 : clearArrive) - now) / 60000),
  );
  if (vsPlayer)
    c.alerts.push({
      id: id + "-alert",
      text: waves
        ? `👑 ${bot.name} is sending an army AND ${waves} noble waves from ${s.id} to take ${tgt.name}: they land in ${mins} min`
        : `⚠ ${bot.name} raiders from ${s.id} are marching on ${tgt.name}: they land in ${mins} min`,
    });
  else if (waves)
    c.news.push({
      id: id + "-news",
      text: tgt.owner
        ? `👑 ${bot.name} is sending nobles against ${tgt.owner}'s village at ${tgt.id}`
        : `🏰 ${bot.name} sends a noble run toward the barbarian village ${tgt.id}`,
    });
}

// ------------------------------------------------------------------ defense and recall
const answered = new Set<string>(); // incoming attacks the bots have already reinforced against
const lastBalance = new Map<string, number>(); // when each bot may next move troops to its frontier village
let nextPassAt = 0;

/**
 * Looks at the marches in flight (cheap, throttled: runs every defendEveryMs()):
 *  1. any bot village whose garrison would lose to an incoming attack gets half the defenders of the bot's other
 *     villages within 40 fields, if they can arrive in time
 *  2. reinforcements standing in a village that is no longer threatened walk home
 * Returns the villages that changed and the commands it created (support and return marches).
 */
export function defendPass(a: {
  now: number;
  villages: Record<string, Village>;
  commands: Command[];
}): { villages: Record<string, Village>; commands: Command[]; news: string[] } {
  const out = {
    villages: {} as Record<string, Village>,
    commands: [] as Command[],
    news: [] as string[],
  };
  const { now } = a;
  if (now < nextPassAt) return out;
  nextPassAt = now + defendEveryMs();
  if (answered.size > 400) answered.clear();

  const world: Record<string, Village> = { ...a.villages };
  const put2 = (v: Village) => {
    out.villages[v.id] = v;
    world[v.id] = v;
  };
  const mine = new Map<string, Village[]>();
  for (const b of BOTS) mine.set(b.name, botVillages(b, world, now));
  const hostile = a.commands.filter(
    (x) => x.arriveAt > now && HOSTILE.includes(x.kind),
  );
  const threatened = new Set(hostile.map((x) => x.toId));

  // ---------- 1) defend ----------
  for (const atk of hostile) {
    if (!DEFEND_VS_PLAYER && atk.kind === "attack") continue;
    if (answered.has(atk.id)) continue;
    const base = world[atk.toId] ?? villageAt(atk.toXY[0], atk.toXY[1], now);
    if (
      !base ||
      !base.owner ||
      base.owner === PLAYER ||
      base.owner === atk.clan
    )
      continue;
    if (!rivalInfo(base.owner)) continue;
    answered.add(atk.id);

    const cur = world[base.id] ?? base;
    const aBonus = attackBonusFor(atk.smithy ?? 0, atk.units, 0);
    const dBonus = defenseBonusFor(cur.buildings.smithy);
    let defenders = garrison(cur);
    let pw = battlePowers(
      atk.units,
      defenders,
      cur.buildings.wall,
      aBonus,
      dBonus,
    );
    if (pw.d >= pw.a * 1.1) continue; // it will hold on its own
    const budget = atk.arriveAt - now - 2000; // reinforcements must arrive before the attack
    const sources = (mine.get(base.owner) ?? [])
      .filter((v) => v.id !== cur.id && dist(v, cur) <= SUPPORT_RANGE)
      .sort((p, q) => dist(p, cur) - dist(q, cur));
    for (const s0 of sources) {
      const s = settle(normalizeVillage(world[s0.id] ?? s0), now);
      const give = emptyUnits();
      for (const u of DEF_POOL) give[u] = Math.floor(s.units[u] * 0.5);
      if (total(give) < 5) continue;
      const ms = travelMs([s.x, s.y], [cur.x, cur.y], give);
      if (ms > budget) continue;
      for (const u of UNIT_IDS) s.units[u] -= give[u];
      put2(s);
      out.commands.push({
        id: `sup-${atk.id}-${s.id}`,
        kind: "support",
        fromId: s.id,
        toId: cur.id,
        fromXY: [s.x, s.y],
        toXY: [cur.x, cur.y],
        units: give,
        loot: { wood: 0, clay: 0, iron: 0 },
        departAt: now,
        arriveAt: now + ms,
        smithy: s.buildings.smithy,
        clan: base.owner,
      });
      out.news.push(
        `🛡 ${base.owner} sends reinforcements from ${s.id} to ${cur.id}, which is about to be attacked`,
      );
      defenders = addUnits(defenders, give);
      pw = battlePowers(
        atk.units,
        defenders,
        cur.buildings.wall,
        aBonus,
        dBonus,
      );
      if (pw.d >= pw.a * 1.15) break;
    }
  }

  // Frontier village: for a bot with two or more villages, the one nearest to you (within 70 fields). It keeps the
  // reinforcements it receives, and the bot's other villages top it up (step 3).
  const playerVillages = Object.values(world).filter((v) => v.owner === PLAYER);
  const frontier = new Map<string, Village>(); // owner name -> its frontier village
  if (playerVillages.length)
    for (const [ownerName, list] of mine) {
      if (list.length < 2) continue;
      const near = (v: Village) =>
        Math.min(...playerVillages.map((p) => dist(v, p)));
      const f = list.reduce((b, v) => (near(v) < near(b) ? v : b));
      if (near(f) <= 70) frontier.set(ownerName, f);
    }
  const frontierIds = new Set([...frontier.values()].map((v) => v.id));

  // ---------- 2) recall reinforcements from villages that are safe again ----------
  for (const [ownerName, list] of mine) {
    for (const h0 of list) {
      const h = world[h0.id] ?? h0;
      if (threatened.has(h.id) || frontierIds.has(h.id)) continue;
      for (const [originId, stack] of Object.entries(h.stationed ?? {})) {
        if (UNIT_IDS.every((u) => stack[u] <= 0)) continue;
        const origin = world[originId];
        if (!origin || origin.owner !== ownerName) continue; // origin was lost: they stay
        const rest = { ...(world[h.id] ?? h).stationed };
        delete rest[originId];
        put2({ ...(world[h.id] ?? h), stationed: rest });
        out.commands.push({
          id: `recall-${originId}-${h.id}-${Math.floor(now)}`,
          kind: "return",
          fromId: h.id,
          toId: originId,
          fromXY: [h.x, h.y],
          toXY: [origin.x, origin.y],
          units: stack,
          loot: { wood: 0, clay: 0, iron: 0 },
          departAt: now,
          arriveAt: now + travelMs([h.x, h.y], [origin.x, origin.y], stack),
          clan: ownerName,
        });
      }
    }
  }

  // ---------- 3) keep the frontier village well defended ----------
  // A bot with several villages moves part of the defenders of its richest nearby village to the one facing you,
  // once every 6 game hours, and only when the donor is much richer. That is the support you see standing there.
  for (const [ownerName, f0] of frontier) {
    if (now < (lastBalance.get(ownerName) ?? 0)) continue;
    const f = world[f0.id] ?? f0;
    const defOf = (u: Units) => DEF_POOL.reduce((n, k) => n + u[k], 0);
    const donor = (mine.get(ownerName) ?? [])
      .filter((v) => v.id !== f.id && dist(v, f) <= SUPPORT_RANGE)
      .map((v) => world[v.id] ?? v)
      .sort((p, q) => defOf(q.units) - defOf(p.units))[0];
    if (!donor) continue;
    if (
      defOf(donor.units) < 30 ||
      defOf(donor.units) <= 1.5 * defOf(garrison(f))
    )
      continue; // only move troops when the donor is much richer
    const s = settle(normalizeVillage(donor), now);
    const give = emptyUnits();
    for (const u of DEF_POOL) give[u] = Math.floor(s.units[u] * 0.3);
    if (total(give) < 10) continue;
    const ms = travelMs([s.x, s.y], [f.x, f.y], give);
    for (const u of UNIT_IDS) s.units[u] -= give[u];
    put2(s);
    out.commands.push({
      id: `bal-${s.id}-${f.id}-${Math.floor(now)}`,
      kind: "support",
      fromId: s.id,
      toId: f.id,
      fromXY: [s.x, s.y],
      toXY: [f.x, f.y],
      units: give,
      loot: { wood: 0, clay: 0, iron: 0 },
      departAt: now,
      arriveAt: now + ms,
      smithy: s.buildings.smithy,
      clan: ownerName,
    });
    lastBalance.set(ownerName, now + (6 * HOUR) / SPEED);
    out.news.push(
      `🛡 ${ownerName} moves ${total(give)} defenders from ${s.id} to ${f.id}, the village facing you`,
    );
  }
  return out;
}
