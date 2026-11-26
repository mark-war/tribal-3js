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
  travelMs,
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
import { AGGRESSION, botTurn, type Advice, type Stance } from "./botbrain";
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
  respawnAt?: number;
  lives?: number;
  followUp?: boolean;
  heroXp?: number;
  nextBotAt?: number;
  growCursor?: number;
}

// ---- tuning, in GAME time, so everything stretches with the game speed (at 60× these are real minutes) ----
const HOUR = 3_600_000;
export const graceMs = () => (12 * HOUR) / SPEED; // nobody raids you in your first 12 game hours
export const raidIntervalMs = () => (25 * HOUR) / SPEED; // typical gap between unprovoked raids
export const retaliateDelayMs = () => (0.5 * HOUR) / SPEED; // how soon a provoked clan hits back: half a game hour (it was 4, long enough for the grudge to fade first)
const grudgeDecayPerMs = () => SPEED / (15 * HOUR); // a grudge fades by 1 every 15 game hours
/** A grudge above this means you TOOK a village from it (a conquest adds 5, a raid 1): it answers with nobles, not just raids. */
const REVENGE_CONQUEST_GRUDGE = 3;
/** Beginner protection: for the first 24 game hours (or until you reach 800 points) bots cannot attack you, and you cannot attack them. */
export const PROTECT_HOURS = 24;
export const PROTECT_POINTS = 800;
export const protectionLeftHours = (ageHours: number, points: number) =>
  points >= PROTECT_POINTS ? 0 : Math.max(0, PROTECT_HOURS - ageHours);
/** Every bot village keeps at least this many scouts. They are the first thing a village retrains: a bot with no scouts cannot look at anything, so it never attacks or conquers anything. */
const SCOUT_FLOOR = 10;
const GROW_EVERY_MS = 20_000; // real ms between two training updates of a rival village
export const MAX_CATCHUP = 2; // safety bound on raids launched in one step
export const respawnMs = () => (6 * HOUR) / SPEED; // a wiped-out bot starts again 6 game hours later
const MAX_RANGE = 90;
export const expandIntervalMs = () => (36 * HOUR) / SPEED; // the rising kingdom sends a noble run about every 36 game hours
// (the cap on villages a bot can take with nobles is MAX_HOLDINGS in core/botbrain.ts)
const BUILD_CAP: Partial<Record<BuildingId, number>> = {
  timber: 20,
  clay: 20,
  iron: 20,
  warehouse: 15,
  farm: 20,
  main: 20,
  barracks: 15,
  smithy: 10,
  stable: 10,
  workshop: 8,
  wall: 15,
};
// fields: rivals do not raid from further away

const h01 = (s: string) => {
  // deterministic "random" from a string
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

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
    const goalOf = (u: UnitId) =>
      u === "scout" ? Math.max(plan.units.scout, SCOUT_FLOOR) : plan.units[u];
    const deficit = (u: UnitId) => goalOf(u) - v.units[u];
    // scouts first (they are cheap, and everything else a bot does starts with a scouting report), then the biggest gap
    const weight = (u: UnitId) =>
      u === "scout" ? 1e9 : deficit(u) * UNITS[u].pop;
    const wants = UNIT_IDS.filter((u) => deficit(u) > 0 && meetsReq(v, u)).sort(
      (x, y) => weight(y) - weight(x),
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

/**
 * The rival scheduler. Pure: give it the world, it returns the bots' new moods, marches to launch, world news, score changes,
 * and the villages that changed. Lazy like everything else: nothing runs while the game is closed.
 *  - every tick: a bot village that sees an attack coming calls for help from its other villages;
 *  - about every game hour: bots join the world, wiped-out bots restart, the few bots that are due take their turn, support goes home.
 */
export function stepRivals(a: {
  now: number;
  startedAt: number;
  mode: RivalMode;
  rivals: Record<string, RivalState>;
  villages: Record<string, Village>;
  protectedPlayer: boolean;
  advice?: Record<string, Advice>;
  commands: Command[];
  aggression?: number;
  mods?: { morale: boolean; night: boolean };
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
  const bumps: [string, Partial<Stats>][] = [];
  const acted: string[] = [];
  const done = () => ({
    rivals: out,
    raids,
    alerts,
    villages: changed,
    news,
    bumps,
    acted,
  });
  if (a.mode === "off") return done(); // rivals switched off (multiplayer): the world stands still
  {
    // living villages build, train and regrow: a few per tick (a rotating cursor), never all at once
    const vs = Object.values(a.villages);
    const n = vs.length;
    let cur = n ? (out._world?.growCursor ?? 0) % n : 0;
    let budget = 12;
    let scanned = 0;
    while (scanned < n && budget > 0) {
      const v = vs[cur];
      const g =
        growRival(
          v,
          a.now,
          a.rivals[rivalInfo(v.owner)?.id ?? ""]?.bornAge ?? 0,
        ) ?? growNeutral(v, a.now);
      if (g) {
        changed[g.id] = g;
        budget--;
      }
      cur = (cur + 1) % n;
      scanned++;
    }
    if (n)
      out._world = {
        ...(out._world ?? {
          grudge: 0,
          raids: 0,
          updatedAt: a.now,
          nextRaidAt: 0,
        }),
        growCursor: cur,
      };
  }
  const world: Record<string, Village> = { ...a.villages, ...changed };
  const owned = Object.values(world).filter((v) => v.owner === PLAYER);
  if (!owned.length) return done();
  const nem = nemesisClan();
  const aggr =
    AGGRESSION[
      Math.max(
        0,
        Math.min(AGGRESSION.length - 1, Math.round(a.aggression ?? 1)),
      )
    ];
  const W0: RivalState = {
    grudge: 0,
    raids: 0,
    updatedAt: a.now,
    nextRaidAt: 0,
  };
  /** What a bot may do to YOU right now: nothing, raid, or send noble trains. */
  const stance = (id: string): Stance => {
    if (a.protectedPlayer || a.mode === "peace") return "no"; // beginner protection / peaceful world
    if (a.mode === "war") return "conquer"; // like a normal player: raids and noble trains
    const grudge = out[id]?.grudge ?? 0;
    if (grudge > REVENGE_CONQUEST_GRUDGE) return "conquer"; // you took a village from it: it wants it back
    return grudge > 0.5 || (a.mode === "raids" && id === nem.id)
      ? "raid"
      : "no";
  };

  // ---- the world's turn (about every game hour) ----
  if (a.now >= (out._world?.nextPassAt ?? 0)) {
    out._world = {
      ...(out._world ?? W0),
      updatedAt: a.now,
      nextPassAt: a.now + HOUR / SPEED,
    };
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
    for (const b of BOTS) {
      // grudges fade
      const st = out[b.id];
      if (!st) continue;
      if (st.grudge <= 0) {
        // keep the clock current: a grudge that arrives later (the store adds it without touching updatedAt) must not
        // start with hours of fading already counted, which used to wipe it out before the bot could act on it
        if (st.updatedAt !== a.now) out[b.id] = { ...st, updatedAt: a.now };
        continue;
      }
      out[b.id] = {
        ...st,
        grudge: Math.max(
          0,
          st.grudge - (a.now - st.updatedAt) * grudgeDecayPerMs(),
        ),
        updatedAt: a.now,
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
        // it has just been wiped out: schedule a restart
        out[b.id] = {
          ...(rs ?? { ...W0, nextRaidAt: a.now }),
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
          // a new life starts clean: the villages it took before no longer count against its cap, and its old Paladin is gone
          held: 0,
          heroXp: 0,
          followUp: false,
          nextActAt: a.now + (8 * HOUR) / SPEED,
        };
        news.push(`🌱 ${b.name} starts again at ${nv.id} as a newcomer`);
      }
    }
  }

  // ---- a bot takes its turn: ONE at a time, every few hundred ms (a burst of 8-20 turns in one tick froze the game for half a second) ----
  if (a.now >= (out._world?.nextBotAt ?? 0)) {
    out._world = {
      ...(out._world ?? W0),
      nextBotAt:
        a.now +
        [600, 500, 400, 300][
          Math.max(0, Math.min(3, Math.round(a.aggression ?? 1)))
        ],
    };
    const held: Record<string, number> = {};
    for (const b of BOTS) held[b.id] = out[b.id]?.held ?? 0;
    const first = (b: { id: string }) =>
      a.startedAt + ((6 + 10 * h01(b.id)) * HOUR) / SPEED;
    const urgency = (b: { id: string }) => (out[b.id]?.followUp ? -1 : 1);
    const bot = BOTS.filter(
      (b) =>
        out[b.id]?.respawnAt === undefined &&
        a.now >= (out[b.id]?.nextActAt ?? first(b)),
    ).sort(
      (p, q) =>
        urgency(p) - urgency(q) ||
        (out[p.id]?.nextActAt ?? first(p)) - (out[q.id]?.nextActAt ?? first(q)),
    )[0]; // a bot whose scouts are back goes first, while its report is fresh
    if (bot) {
      const r = botTurn(bot, {
        now: a.now,
        world,
        owned,
        stance: stance(bot.id),
        held,
        commands: [...a.commands, ...raids],
        grudge: out[bot.id]?.grudge ?? 0,
        aggr,
        mods: a.mods,
        heroXp: out[bot.id]?.heroXp ?? 0,
        advice: a.advice?.[bot.id],
      });
      Object.assign(changed, r.changed);
      Object.assign(world, r.changed);
      raids.push(...r.commands);
      news.push(...r.news);
      bumps.push(...r.bumps);
      acted.push(bot.id);
      alerts.push(...r.alerts);
      const prev = out[bot.id] ?? { ...W0, nextRaidAt: a.now };
      const looked = r.commands.filter((c) => c.kind === "scout"); // a bot that sent scouts acts again when they are back, while the report is fresh
      const ready = Math.max(
        r.scoutReadyAt ?? 0,
        ...looked.map((c) => c.arriveAt * 2 - a.now),
      );
      const normal =
        a.now +
        (aggr.gapH *
          HOUR *
          (0.7 + 0.6 * h01(`${bot.id}:act:${Math.floor(a.now / HOUR)}`))) /
          SPEED;
      out[bot.id] = {
        ...prev,
        held: (prev.held ?? 0) + r.held,
        followUp: ready > 0,
        nextActAt:
          ready > 0 ? Math.min(normal, ready + HOUR / SPEED / 2) : normal,
      };
    }
  }
  return done();
}
