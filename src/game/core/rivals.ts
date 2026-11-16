import { UNITS, UNIT_IDS } from "../config/units";
import {
  ATTACK_CLASSES,
  attackShares,
  defenseBonusFor,
  defenseRating,
  emptyUnits,
  ramsToBreakWall,
} from "./combat";
import {
  RES,
  SPEED,
  buildCost,
  buildReqMet,
  garrison,
  meetsReq,
  settle,
  tryBuild,
  tryRecruit,
  worldAgeHours,
} from "./economy";
import { BUILDINGS } from "../config/buildings";
import {
  BOTS,
  CLANS,
  PLAYER,
  botDevFor,
  botPlan,
  botVillages,
  nearestBarbarian,
  nemesisClan,
  newcomerVillage,
  normalizeVillage,
  rivalInfo,
  villageAt,
} from "./world";
import { addStats, botBaseline } from "./ranking";
import { botTurn, type Advice } from "./botbrain";
import {
  NOBLES_PER_RUN,
  botCanNoble,
  botNobleCost,
  launchWar,
  nobleTrain,
  type LaunchCtx,
} from "./botwar";
import type { Stats } from "./ranking";
import type { BuildingId, Command, Units, UnitId, Village } from "./types";

/** How hostile the world is. 'raids' = your nemesis raids you unprovoked now and then; clans always hit back when provoked. */
export type RivalMode = "off" | "peace" | "retaliate" | "raids" | "war";
export interface RivalState {
  grudge: number;
  nextRaidAt: number;
  raids: number;
  updatedAt: number;
  nextExpandAt?: number;
  nextPassAt?: number;
  nextActAt?: number;
  held?: number;
  bornAge?: number;
  banked?: Stats;
  respawnAt?: number;
  lives?: number;
}

// ---- tuning, in GAME time, so everything stretches with the game speed (at 60× these are real minutes) ----
const HOUR = 3_600_000;
export const graceMs = () => (12 * HOUR) / SPEED; // nobody raids you in your first 12 game hours
export const raidIntervalMs = () => (25 * HOUR) / SPEED; // typical gap between unprovoked raids
export const retaliateDelayMs = () => 0; // how soon a provoked clan hits back: 0 = on the very next step
export const volleyGapMs = () => (20 * 60_000) / SPEED; // gap between follow-up retaliation raids (20 game min)
const grudgeDecayPerMs = () => SPEED / (15 * HOUR); // a grudge fades by 1 every 15 game hours
const GRUDGE_PER_RAID = 0.4; // grudge spent per retaliation raid (1 grudge is about 2 raids)
const NOBLE_ESCORT_BOOST = 1.4; // the clearing army is sized bigger when nobles follow it
/** Beginner protection: for the first 24 game hours (or until you reach 800 points) bots cannot attack you, and you cannot attack them. */
export const PROTECT_HOURS = 24;
export const PROTECT_POINTS = 800;
export const protectionLeftHours = (ageHours: number, points: number) =>
  points >= PROTECT_POINTS ? 0 : Math.max(0, PROTECT_HOURS - ageHours);
const GROW_EVERY_MS = 20_000; // real ms between two training updates of a rival village
export const MAX_CATCHUP = 2; // safety bound on raids launched in one step
export const respawnMs = () => (6 * HOUR) / SPEED; // a wiped-out bot starts again 6 game hours later
const MAX_RANGE = 120; // fields from a clan village to the nearest village of yours: further than this it does not raid
const MIN_SHARE_OF_NEED = 0.25; // a fallback raid is only sent if the force is at least this share of what it would need to win
const MIN_FALLBACK_POWER = 800; // ...and is at least this much attack (about 6 light cavalry: no more 4-man "raids")
const BOTS_PER_TURN = 12; // bots that act per world turn (one per game hour); more = a livelier world
const BOT_ACT_HOURS = 4; // about how many game hours a bot waits between two of its turns
export const expandIntervalMs = () => (6 * HOUR) / SPEED; // the rising kingdom sends a noble run about every 36 game hours
const MAX_HOLDINGS = 100; // villages a bot can take on its own

const h01 = (s: string) => {
  // deterministic "random" from a string
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};
const attackPower = (u: Units) =>
  UNIT_IDS.reduce((s, k) => s + u[k] * UNITS[k].attack, 0);

/** Can this village really send a noble run: Academy (or a developed village), and the minimum noble train paid for. */
const canSendNobles = (v: Village) =>
  botCanNoble(v) &&
  RES.every((r) => v.resources[r] >= NOBLES_PER_RUN * botNobleCost(r)) &&
  (h01(v.id) ?? 0) < MAX_HOLDINGS;

/** What a bot builds, in the order it would like to (like a player: economy first, then army, then the late game). */
const BUILD_ORDER: BuildingId[] = [
  "timber",
  "clay",
  "iron",
  "main",
  "warehouse",
  "farm",
  "barracks",
  "smithy",
  "stable",
  "market",
  "wall",
  "workshop",
  "hiding",
  "academy",
];

/**
 * A bot village plays by YOUR rules. Every visit it may place up to two construction orders and one training order, through the
 * same queues, costs, build and training times, requirements and population limit as yours; what it aims for is its plan
 * (what a competent player of its style has by now). If it runs out of resources it simply waits, if you destroy its Stable it has
 * to pay to build it again, and a wiped-out army takes real time to train back.
 */
export function growRival(
  src: Village,
  now: number,
  bornAge = 0,
): Village | null {
  const info = rivalInfo(src.owner);
  if (!info || now - src.updatedAt < GROW_EVERY_MS) return null;
  const bot = CLANS.find((k) => k.name === src.owner)!;
  let v = settle(normalizeVillage(src), now); // production and finished orders
  // what it WANTS is always a little more than a typical player has by now; what it GETS is limited by resources and time
  const plan = botPlan(
    bot,
    Math.min(1, 0.15 + botDevFor(bot, worldAgeHours(now) - bornAge) * 1.4),
  );
  const queued = (b: BuildingId) =>
    v.buildQueue.filter((j) => j.building === b).length;
  const wantedNow = () =>
    BUILD_ORDER.filter(
      (b) =>
        v.buildings[b] + queued(b) <
          Math.min(plan.buildings[b], BUILDINGS[b].maxLevel) &&
        buildReqMet(v, b),
    );
  for (let i = 0; i < 2 && v.buildQueue.length < 3; i++) {
    let built: Village | null = null;
    for (const b of wantedNow()) {
      built = tryBuild(v, b, now);
      if (built) break;
    } // the first thing it can afford
    if (!built) break;
    v = built;
  }
  // Soldiers only come out of what is LEFT after saving for the next building (a player who trains everything never builds anything).
  const next = wantedNow()[0];
  const pop = (u: Units) =>
    UNIT_IDS.reduce((n, k) => n + u[k] * UNITS[k].pop, 0);
  const econ =
    Object.values(v.buildings).reduce((n, x) => n + x, 0) /
    Math.max(
      1,
      Object.values(plan.buildings).reduce((n, x) => n + x, 0),
    );
  const army = pop(v.units) / Math.max(1, pop(plan.units));
  // keep the army in step with the economy: when it has fallen behind, soldiers come first; otherwise the next building does
  const reserve =
    next && army >= econ * 0.8
      ? buildCost(next, v.buildings[next] + queued(next) + 1)
      : { wood: 0, clay: 0, iron: 0 };
  if (v.recruitQueue.length === 0) {
    const deficit = (u: UnitId) => plan.units[u] - v.units[u];
    const wants = UNIT_IDS.filter((u) => deficit(u) > 0 && meetsReq(v, u)).sort(
      (x, y) => deficit(y) * UNITS[y].pop - deficit(x) * UNITS[x].pop,
    );
    for (const u of wants) {
      const afford = Math.min(
        ...RES.map((r) =>
          Math.floor(
            Math.max(0, v.resources[r] - reserve[r]) / UNITS[u].cost[r],
          ),
        ),
      );
      const n = Math.min(deficit(u), 10, afford);
      if (n < 1) continue;
      const trained = tryRecruit(v, u, n, now); // time, cost and the farm limit all apply
      if (trained) {
        v = trained;
        break;
      }
    }
  }
  v.goal = { ...plan.units };
  return v;
}

/**
 * Barbarian villages grow with the world, as in the original: the same village is a little stronger every day. One you have
 * attacked keeps its losses but wins its troops back (and its buildings catch up) toward what it would naturally be by now.
 */
export function growNeutral(src: Village, now: number): Village | null {
  if (src.owner !== null || now - src.updatedAt < GROW_EVERY_MS) return null;
  const natural = villageAt(src.x, src.y, now);
  if (!natural || natural.owner !== null) return null;
  const hours = ((now - src.updatedAt) * SPEED) / HOUR;
  const v = settle(normalizeVillage(src), now);
  const f = Math.min(1, 0.05 * hours);
  for (const u of UNIT_IDS)
    if (v.units[u] < natural.units[u])
      v.units[u] += Math.ceil((natural.units[u] - v.units[u]) * f);
  for (const b of Object.keys(v.buildings) as BuildingId[])
    if (v.buildings[b] >= 1 && natural.buildings[b] > v.buildings[b])
      v.buildings[b] += 1;
  return v;
}

const STRIKE: UnitId[] = ["axe", "light", "mounted"]; // what raiders are made of; defenders stay home
/**
 * A raid is made of troops the source village REALLY has. It brings roughly what it thinks it needs (your weighted defense × a
 * factor × boost), never more than 85% of its strike force, and if that force is not enough to have a go, nobody leaves:
 * returns null and the clan regroups. A clan's first raid is a weak probe.
 * `boost` > 1 sizes the wave up (the clearing army before nobles). `desperate` = a provoked clan (or your nemesis) that is
 * too weak to win still sends what it has, but only if that is a real force (offensive units only, enough power, and a
 * meaningful share of what it would need).
 */
export function planRaid(
  source: Village,
  target: Village,
  grudge: number,
  raidNo: number,
  seed: string,
  boost = 1,
  desperate = false,
): Units | null {
  const avail = source.units;
  const pool: UnitId[] = desperate
    ? UNIT_IDS.filter(
        (u) =>
          UNITS[u].attack > 0 &&
          (UNITS[u].role === "offense" || UNITS[u].role === "hybrid") && // never the defenders
          !["ram", "catapult", "noble", "scout", "paladin"].includes(u),
      )
    : STRIKE;
  const have = emptyUnits();
  for (const u of pool) have[u] = avail[u];
  const power = attackPower(have);
  if (power <= 0) return null;
  const shares = attackShares(have);
  const rating = defenseRating(
    garrison(target),
    target.buildings.wall,
    defenseBonusFor(target.buildings.smithy),
  );
  const weighted = ATTACK_CLASSES.reduce(
    (s, k) => s + shares[k] * rating[k],
    0,
  );
  const factor = Math.min(
    1.6,
    (raidNo === 0 ? 0.5 : 0.7 + 0.35 * h01(seed)) *
      (1 + 0.15 * Math.min(grudge, 4)),
  );
  const want = boost * factor * weighted;
  if (!desperate && power * 0.85 < 0.6 * want) return null; // too weak to try
  if (desperate && power * 0.85 < MIN_SHARE_OF_NEED * want) return null; // too small to be worth sending at all
  const frac = Math.min(0.85, want / power);
  const army = emptyUnits();
  for (const u of pool)
    army[u] = Math.min(avail[u], Math.ceil(avail[u] * frac));
  if (avail.ram > 0 && target.buildings.wall >= 2)
    army.ram = Math.min(avail.ram, ramsToBreakWall(target.buildings.wall));
  return attackPower(army) >= (desperate ? MIN_FALLBACK_POWER : 50)
    ? army
    : null;
}

const gap = (grudge: number, seed: string) =>
  (raidIntervalMs() * (0.7 + 0.6 * h01(seed))) /
  (1 + 0.5 * Math.min(grudge, 4));

/**
 * The rival scheduler. Pure: give it the world, it returns the bots' new moods, marches to launch (against YOU), world news,
 * score changes, and the villages that changed. Lazy like everything else: nothing runs while the game is closed.
 */
export function stepRivals(a: {
  now: number;
  startedAt: number;
  mode: RivalMode;
  rivals: Record<string, RivalState>;
  villages: Record<string, Village>;
  protectedPlayer: boolean;
  advice?: Record<string, Advice>;
  commands?: Command[];
}): {
  rivals: Record<string, RivalState>;
  raids: Command[];
  alerts: { id: string; text: string }[];
  villages: Record<string, Village>;
  news: string[];
  bumps: [string, Partial<Stats>][];
  acted: string[];
} {
  const out = { ...a.rivals };
  const raids: Command[] = [];
  const alerts: { id: string; text: string }[] = [];
  const changed: Record<string, Village> = {};
  const news: string[] = [];
  const warNews: { id: string; text: string }[] = []; // world news written by launchWar
  const bumps: [string, Partial<Stats>][] = [];
  const acted: string[] = [];
  const done = () => ({
    rivals: out,
    raids,
    alerts,
    villages: changed,
    news: [...news, ...warNews.map((n) => n.text)],
    bumps,
    acted,
  });
  if (a.mode === "off") return done(); // rivals switched off (multiplayer): the world stands still
  for (const v of Object.values(a.villages)) {
    const g =
      growRival(
        v,
        a.now,
        a.rivals[rivalInfo(v.owner)?.id ?? ""]?.bornAge ?? 0,
      ) ?? growNeutral(v, a.now);
    if (g) changed[g.id] = g;
  } // living villages retrain and regrow
  const world: Record<string, Village> = { ...a.villages, ...changed };
  const owned = Object.values(world).filter((v) => v.owner === PLAYER);
  if (!owned.length) return done();
  const nem = nemesisClan();
  const ready = !a.protectedPlayer; // beginner protection
  // everything that launches an attack on you goes through launchWar with this context
  const lc: LaunchCtx = {
    now: a.now,
    world,
    raids,
    alerts,
    news: warNews,
    changed,
  };

  for (const clan of CLANS.filter(
    (c) => c.id === nem.id || (out[c.id]?.grudge ?? 0) > 0.15,
  )) {
    let st: RivalState = out[clan.id] ?? {
      grudge: 0,
      raids: 0,
      updatedAt: a.now,
      nextRaidAt:
        a.startedAt + graceMs() + 0.5 * raidIntervalMs() * h01(clan.id),
    };
    st = {
      ...st,
      grudge: Math.max(
        0,
        st.grudge - (a.now - st.updatedAt) * grudgeDecayPerMs(),
      ),
      updatedAt: a.now,
    };
    // 'peace': no attacks on YOU, the world still lives
    const willing = () =>
      a.mode !== "peace" &&
      (st.grudge > 0.15 ||
        ((a.mode === "raids" || a.mode === "war") && clan.id === nem.id));

    // A fresh provocation pulls the next raid forward: don't wait out the normal 25-game-hour gap.
    if (
      a.mode !== "peace" &&
      st.grudge > 0.15 &&
      st.nextRaidAt > a.now + volleyGapMs()
    )
      st = { ...st, nextRaidAt: a.now + retaliateDelayMs() };

    let launched = 0;
    while (
      willing() &&
      ready &&
      a.now >= st.nextRaidAt &&
      launched < MAX_CATCHUP
    ) {
      const provoked = st.grudge > 0.15;
      const ref = owned[0];
      const seed = `${clan.id}:${st.raids}`;
      // their villages near you that are still theirs, nearest first: the first one that can really field a raid sends it
      let pick: {
        src: Village;
        target: Village;
        units: Units;
        withNobles: boolean;
      } | null = null;
      const mine = botVillages(clan, world, a.now).sort(
        (p, q) =>
          Math.hypot(p.x - ref.x, p.y - ref.y) -
          Math.hypot(q.x - ref.x, q.y - ref.y),
      );
      const nearestTarget = (src: Village) =>
        owned
          .filter((v) => v.id !== src.id)
          .reduce((b, v) =>
            Math.hypot(v.x - src.x, v.y - src.y) <
            Math.hypot(b.x - src.x, b.y - src.y)
              ? v
              : b,
          );
      const inRange = (src: Village, t: Village) =>
        Math.hypot(src.x - t.x, src.y - t.y) <= MAX_RANGE;
      for (const src of mine) {
        const target = nearestTarget(src);
        if (!inRange(src, target)) continue;
        let withNobles = provoked && canSendNobles(src);
        let units = planRaid(
          src,
          target,
          st.grudge,
          st.raids,
          seed,
          withNobles ? NOBLE_ESCORT_BOOST : 1,
        );
        if (!units && withNobles) {
          // can't field the bigger clearing army: fall back to a plain raid
          withNobles = false;
          units = planRaid(src, target, st.grudge, st.raids, seed);
        }
        if (units) {
          pick = { src, target, units, withNobles };
          break;
        }
      }
      if (!pick && (provoked || clan.id === nem.id)) {
        // provoked (or your nemesis) but too weak to win: send a real force anyway, never a handful of riders and never nobles
        for (const src of mine) {
          const target = nearestTarget(src);
          if (!inRange(src, target)) continue;
          const units = planRaid(
            src,
            target,
            st.grudge,
            st.raids,
            seed,
            1,
            true,
          );
          if (units) {
            pick = { src, target, units, withNobles: false };
            break;
          }
        }
      }
      if (!pick) {
        // nobody has the troops: they regroup and look again soon (angry clans look again almost at once)
        st = {
          ...st,
          nextRaidAt:
            a.now + (provoked ? volleyGapMs() : raidIntervalMs() * 0.25),
        };
        break;
      }
      // the raiders leave their village (it is weaker until they are back); nobles come as single-noble waves
      const src = settle(normalizeVillage(pick.src), a.now);
      const waves = pick.withNobles ? nobleTrain(src, seed) : 0;
      launchWar(lc, clan, src, pick.target, pick.units, waves);
      st = {
        ...st,
        raids: st.raids + 1,
        grudge: Math.max(0, st.grudge - (provoked ? GRUDGE_PER_RAID : 1)),
        // angry clans follow up quickly while the grudge lasts; otherwise the usual long gap
        nextRaidAt:
          a.now + (provoked ? volleyGapMs() : gap(st.grudge, seed + "n")),
      };
      launched++;
    }
    if (a.now >= st.nextRaidAt)
      st = {
        ...st,
        nextRaidAt: a.now + gap(st.grudge, `${clan.id}:${st.raids}:later`),
      }; // not in the mood / caught up: look again later
    out[clan.id] = { ...(out[clan.id] ?? {}), ...st };
  }

  // ---- The world's turn (about every game hour): the few bots that are due act like players ----
  if (a.now >= (out._world?.nextPassAt ?? 0)) {
    for (const b of BOTS) {
      // every bot is a real village from now on (no more formula for its home)
      const homeId = `${b.home[0]}|${b.home[1]}`;
      if (world[homeId] || out[b.id]?.respawnAt !== undefined) continue;
      const g = villageAt(b.home[0], b.home[1], a.now);
      if (g && g.owner === b.name) {
        changed[g.id] = g;
        world[g.id] = g;
      }
    }
    out._world = {
      ...(out._world ?? { grudge: 0, raids: 0, nextRaidAt: 0 }),
      updatedAt: a.now,
      nextPassAt: a.now + HOUR / SPEED,
    };
    const held: Record<string, number> = {};
    for (const b of BOTS) held[b.id] = out[b.id]?.held ?? 0;
    const busy = new Set(
      CLANS.filter(
        (c) => c.id === nem.id || (out[c.id]?.grudge ?? 0) > 0.05,
      ).map((c) => c.id),
    ); // these already hunt you through the grudge scheduler
    const warOnPlayer = a.mode === "war" && !a.protectedPlayer;
    const first = (b: { id: string }) =>
      a.startedAt + ((6 + 10 * h01(b.id)) * HOUR) / SPEED;
    const due = BOTS.filter(
      (b) =>
        out[b.id]?.respawnAt === undefined &&
        a.now >= (out[b.id]?.nextActAt ?? first(b)),
    )
      .sort(
        (p, q) =>
          (out[p.id]?.nextActAt ?? first(p)) -
          (out[q.id]?.nextActAt ?? first(q)),
      )
      .slice(0, BOTS_PER_TURN);
    for (const bot of due) {
      const r = botTurn(bot, {
        now: a.now,
        world,
        owned,
        warOnPlayer,
        skipPlayer: busy,
        held,
        advice: a.advice?.[bot.id],
      });
      Object.assign(changed, r.changed);
      Object.assign(world, r.changed);
      raids.push(...r.commands);
      news.push(...r.news);
      bumps.push(...r.bumps);
      acted.push(bot.id);
      r.alerts.forEach((t, i) =>
        alerts.push({ id: `${bot.id}-${Math.floor(a.now)}-a${i}`, text: t }),
      );
      const prev = out[bot.id] ?? {
        grudge: 0,
        raids: 0,
        updatedAt: a.now,
        nextRaidAt: a.now + raidIntervalMs(),
      };
      out[bot.id] = {
        ...prev,
        held: (prev.held ?? 0) + r.held,
        nextActAt:
          a.now +
          (BOT_ACT_HOURS *
            HOUR *
            (0.7 + 0.6 * h01(`${bot.id}:act:${Math.floor(a.now / HOUR)}`))) /
            SPEED,
      };
    }
    // A bot that has lost its LAST village is out of the game for a while, then it starts AGAIN as a newcomer on a barbarian village.
    for (const b of BOTS) {
      const rs = out[b.id];
      if (botVillages(b, world, a.now).length > 0) {
        if (rs?.respawnAt !== undefined)
          out[b.id] = { ...rs, respawnAt: undefined };
        continue;
      }
      if (rs?.respawnAt === undefined) {
        // it has just been wiped out: bank what this life earned, schedule a restart
        const base = rs ?? {
          grudge: 0,
          raids: 0,
          updatedAt: a.now,
          nextRaidAt: a.now,
        };
        out[b.id] = {
          ...base,
          banked: addStats(
            rs?.banked,
            botBaseline(b.growth, worldAgeHours(a.now) - (rs?.bornAge ?? 0)),
          ),
          respawnAt: a.now + respawnMs(),
        };
        news.push(
          `☠ ${b.name} has lost its last village and is out of the game`,
        );
      } else if (a.now >= rs.respawnAt) {
        const spot = nearestBarbarian(
          b.home,
          a.now,
          (v) =>
            (world[v.id]?.owner ?? null) !== null ||
            owned.some((o) => Math.hypot(o.x - v.x, o.y - v.y) < 20),
        );
        if (!spot) continue;
        const nv = newcomerVillage(spot.x, spot.y, b, a.now);
        changed[nv.id] = nv;
        world[nv.id] = nv;
        out[b.id] = {
          ...rs,
          respawnAt: undefined,
          bornAge: worldAgeHours(a.now),
          lives: (rs.lives ?? 1) + 1,
          nextActAt: a.now + (8 * HOUR) / SPEED,
        };
        news.push(`🌱 ${b.name} starts again at ${nv.id} as a newcomer`);
      }
    }
  }
  return done();
}
