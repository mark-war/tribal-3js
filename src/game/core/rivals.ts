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
  garrison,
  meetsReq,
  popFree,
  recruitTimeMs,
  settle,
  tryBuild,
  worldAgeHours,
} from "./economy";
import {
  BOTS,
  CLANS,
  PLAYER,
  botVillages,
  doctrineUnits,
  nemesisClan,
  normalizeVillage,
  rivalInfo,
  villageAt,
} from "./world";
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
  frozenAge?: number;
}

// ---- tuning, in GAME time, so everything stretches with the game speed (at 60× these are real minutes) ----
const HOUR = 3_600_000;
export const graceMs = () => (12 * HOUR) / SPEED; // nobody raids you in your first 12 game hours
export const raidIntervalMs = () => (25 * HOUR) / SPEED; // typical gap between unprovoked raids
export const retaliateDelayMs = () => 0; // how soon a provoked clan hits back: 0 = on the very next step
export const volleyGapMs = () => (20 * 60_000) / SPEED; // gap between follow-up retaliation raids (20 game min)
const grudgeDecayPerMs = () => SPEED / (15 * HOUR); // a grudge fades by 1 every 15 game hours
const GRUDGE_PER_RAID = 0.4; // grudge spent per retaliation raid (1 grudge is about 2 raids)
const MIN_SHARE_OF_NEED = 0.25; // a fallback raid is only sent if the force is at least this share of what it would need to win
const MIN_FALLBACK_POWER = 800; // ...and is at least this much attack (about 6 light cavalry: no more 4-man "raids")
const BOTS_PER_TURN = 12; // bots that act per world turn (one per game hour); more = a livelier world
const BOT_ARMY_AGE_HOURS = 360; // a bot's garrison goal doubles after this many game hours of world age (higher = gentler; 1e9 = no growth with age)
const NOBLE_ESCORT_BOOST = 1.4; // the clearing army is sized bigger when nobles follow it
/** Beginner protection: for the first 24 game hours (or until you reach 800 points) bots cannot attack you, and you cannot attack them. */
export const PROTECT_HOURS = 24;
export const PROTECT_POINTS = 800;
export const protectionLeftHours = (ageHours: number, points: number) =>
  points >= PROTECT_POINTS ? 0 : Math.max(0, PROTECT_HOURS - ageHours);
const GROW_EVERY_MS = 20_000; // real ms between two training updates of a rival village
export const MAX_CATCHUP = 2; // safety bound on raids launched in one step
const MAX_RANGE = 120; // fields from a clan village to the nearest village of yours: further than this it does not raid
export const expandIntervalMs = () => (36 * HOUR) / SPEED; // the rising kingdom sends a noble run about every 36 game hours
const MAX_HOLDINGS = 100; // villages a bot can take on its own
const BUILD_CAP: Partial<Record<BuildingId, number>> = {
  timber: 30,
  clay: 30,
  iron: 30,
  warehouse: 30,
  farm: 30,
  main: 20,
  barracks: 20,
  smithy: 20,
  stable: 20,
  workshop: 15,
  wall: 20,
  market: 20,
  academy: 1,
  statue: 1,
  rally: 1,
  hiding: 10,
};

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

/** Can this village really send a noble run: Academy + required buildings, and the minimum noble train paid for in full. */
const canSendNobles = (v: Village) =>
  botCanNoble(v) &&
  RES.every((r) => v.resources[r] >= NOBLES_PER_RUN * botNobleCost(r));

/**
 * Rival villages are alive: once you have touched one (or it has raided you) it is a real village that keeps its losses,
 * and it TRAINS them back like a player would: unit by unit, paying for each, limited by the level of the building that
 * trains it (Barracks, Stable, Workshop). Destroy its Stable and it can never train cavalry again.
 */
export function growRival(
  src: Village,
  now: number,
  world: Record<string, Village> = {},
  commands: Command[] = [],
): Village | null {
  if (!rivalInfo(src.owner) || now - src.updatedAt < GROW_EVERY_MS) return null;
  const dt = now - src.updatedAt;
  const v = settle(normalizeVillage(src), now); // production, finished queues
  const goal = v.goal ?? villageAt(v.x, v.y, now)?.units ?? v.units;
  // Population rules apply to the bots too: troops at home, in training, marching and standing in other villages all
  // use this village's farm slots. A bot never trains past the free slots, however big its garrison goal is.
  let free = popFree(v, commands, world);
  for (const b of ["barracks", "stable", "workshop"] as const) {
    const level = v.buildings[b];
    if (level < 1) continue; // building destroyed → nothing trained there
    let budget = dt;
    const wanted = UNIT_IDS.filter(
      (u) =>
        UNITS[u].trainedAt === b &&
        (goal[u] ?? 0) > v.units[u] &&
        meetsReq(v, u),
    ).sort((x, y) => goal[y] - goal[x]);
    for (const u of wanted) {
      const t = recruitTimeMs(u, level);
      const affordable = Math.min(
        ...RES.map((r) => Math.floor(v.resources[r] / UNITS[u].cost[r])),
      );
      const room = Math.floor(free / UNITS[u].pop); // farm slots left for this unit type
      const n = Math.max(
        0,
        Math.min(
          goal[u] - v.units[u],
          Math.floor(budget / t),
          affordable,
          room,
        ),
      );
      if (n <= 0) continue;
      v.units[u] += n;
      free -= n * UNITS[u].pop;
      budget -= n * t;
      for (const r of RES) v.resources[r] -= n * UNITS[u].cost[r];
    }
  }
  // The village grows like a player's: one upgrade at a time, cheapest level first.
  // It may also START buildings it lacks (once established), but never one that a siege razed to 0.
  let cur = v;
  const clan = CLANS.find((k) => k.name === cur.owner)!;
  if (cur.buildQueue.length === 0) {
    const foundable = (id: BuildingId) => {
      if (cur.buildings.main < 10 || cur.razed?.[id]) return false;
      if (id === "stable")
        return ["cavalry", "horde", "balanced"].includes(clan.doctrine);
      if (id === "workshop") return clan.doctrine === "siege";
      return ["market", "academy", "hiding", "rally", "statue"].includes(id);
    };
    const options = (Object.keys(BUILD_CAP) as BuildingId[])
      .filter(
        (id) =>
          cur.buildings[id] < BUILD_CAP[id]! &&
          (cur.buildings[id] >= 1 || foundable(id)),
      )
      .sort(
        (x, y) =>
          cur.buildings[x] / BUILD_CAP[x]! - cur.buildings[y] / BUILD_CAP[y]!,
      );
    for (const id of options) {
      const built = tryBuild(cur, id, now);
      if (built) {
        cur = built;
        break;
      }
    }
  }
  // its garrison goal grows with it, and never shrinks
  const S = Math.floor(
    (20 +
      4 * (cur.buildings.main + cur.buildings.barracks + cur.buildings.farm)) *
      (rivalInfo(cur.owner)!.nemesis ? 1.25 : 1) *
      (1 + worldAgeHours(now) / BOT_ARMY_AGE_HOURS), // bots keep growing as the world ages, so they can still threaten a big village
  );
  const g = doctrineUnits(clan, S);
  cur.goal = Object.fromEntries(
    UNIT_IDS.map((u) => [u, Math.max(goal[u] ?? 0, g[u])]),
  ) as Units;
  return cur;
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
 * `boost` > 1 sizes the wave up (the clearing army before nobles). `desperate` = a provoked clan short of troops sends
 * whatever can fight, so you still get a retaliation even when you have grown stronger than it.
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
  commands?: Command[]; // everything marching: armies away still use their village's farm slots
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
      growRival(v, a.now, a.villages, a.commands ?? []) ??
      growNeutral(v, a.now);
    if (g) changed[g.id] = g;
  } // living villages retrain and regrow
  const world: Record<string, Village> = { ...a.villages, ...changed };
  const owned = Object.values(world).filter((v) => v.owner === PLAYER);
  if (!owned.length) return done();
  const nem = nemesisClan();
  const ready = !a.protectedPlayer; // beginner protection
  const lc: LaunchCtx = {
    now: a.now,
    world,
    raids,
    alerts,
    news: warNews,
    changed,
  };

  for (const clan of CLANS.filter(
    (c) => c.id === nem.id || (out[c.id]?.grudge ?? 0) > 0.05,
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
      (st.grudge > 0.5 ||
        ((a.mode === "raids" || a.mode === "war") && clan.id === nem.id));

    // A fresh provocation pulls the next raid forward: don't wait out the normal 25-game-hour gap.
    if (
      a.mode !== "peace" &&
      st.grudge > 0.5 &&
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
      const provoked = st.grudge > 0.5;
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
        // provoked (or your nemesis) but too weak to win: send whatever can fight anyway, so the pressure never stops
        // completely once you have outgrown it (never nobles)
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
    out._world = {
      ...(out._world ?? { grudge: 0, raids: 0, nextRaidAt: 0 }),
      updatedAt: a.now,
      nextPassAt: a.now + HOUR / SPEED,
    };
    // villages each bot has taken with nobles (the store counts them when the nobles land)
    const held: Record<string, number> = Object.fromEntries(
      BOTS.map((b) => [b.id, out[b.id]?.held ?? 0]),
    );
    for (const b of BOTS) {
      if (
        out[b.id]?.frozenAge !== undefined ||
        botVillages(b, world, a.now).length > 0
      )
        continue;
      out[b.id] = {
        ...(out[b.id] ?? {
          grudge: 0,
          raids: 0,
          updatedAt: a.now,
          nextRaidAt: a.now,
        }),
        frozenAge: worldAgeHours(a.now),
      };
      news.push(`☠ ${b.name} has lost its last village and is out of the game`);
    }
    const busy = new Set(
      CLANS.filter(
        (c) => c.id === nem.id || (out[c.id]?.grudge ?? 0) > 0.05,
      ).map((c) => c.id),
    ); // these already hunt you through the grudge scheduler
    const warOnPlayer = a.mode === "war" && !a.protectedPlayer;
    const first = (b: { id: string }) =>
      a.startedAt + ((6 + 10 * h01(b.id)) * HOUR) / SPEED;
    const due = BOTS.filter((b) => a.now >= (out[b.id]?.nextActAt ?? first(b)))
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
        // a bot that is scouting or has a war on its hands looks again sooner than one that just did a big move
        nextActAt:
          a.now +
          (4 *
            HOUR *
            (0.7 + 0.6 * h01(`${bot.id}:act:${Math.floor(a.now / HOUR)}`))) /
            SPEED,
      };
    }
  }
  return done();
}
