import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_PRESETS } from "./presets";
import { BUILDINGS } from "./config/buildings";
import { UNIT_IDS, UNITS } from "./config/units";
import {
  ATTACK_CLASSES,
  CLASS_ICON,
  SCOUT_TIER_NAME,
  HERO_XP_CONQUEST,
  HERO_XP_WIN,
  HERO_XP_NEMESIS,
  loyaltyHit,
  attackBonusFor,
  battlePowers,
  defenseBonusFor,
  heroLevel,
  survivorsOf,
  carryCapacity,
  catapultLevels,
  defenseRating,
  emptyUnits,
  resolveBattle,
  resolveScout,
} from "./core/combat";
import {
  CANCEL_REFUND,
  MERCHANT_CAPACITY,
  RES,
  SPEED,
  buildCost,
  buildTimeMs,
  capacity,
  recruitTimeMs,
  emptyCost,
  garrison,
  hidingProtect,
  merchantsFree,
  paladinCount,
  recallWindowMs,
  setSpeed,
  setWorldClock,
  worldAgeHours,
  settle,
  tradeMs,
  travelMs,
  tryBuild,
  tryRecruit,
} from "./core/economy";
import {
  CLANS,
  PLAYER,
  dist,
  newPlayerVillage,
  normalizeUnits,
  normalizeVillage,
  rivalInfo,
  villageAt,
  type Clan,
} from "./core/world";
import { addStats, type Stats } from "./core/ranking";
import { RALLY } from "./config/rally";
import {
  collectRally,
  joinProblem,
  splitLoot,
  splitSurvivors,
  sumUnits,
  troopCount,
  type Rally,
  type RallyTimerKey,
} from "./core/rally";

/** How long a rally waits before its combined army leaves, by the timer the panel offers (real time, not game time). */
const RALLY_TIMER_MS: Record<string, number> = {
  "30s": 30_000,
  "1m": 60_000,
  "2m": 120_000,
  "5m": 300_000,
  "10m": 600_000,
};
import { landStrike, type Advice } from "./core/botbrain";
import { defendPass, recordScout } from "./core/botwar";
import { luckNote, luckOf } from "./core/luck";
import {
  PROTECT_POINTS,
  protectionLeftHours,
  raidIntervalMs,
  retaliateDelayMs,
  stepRivals,
  type RivalMode,
  type RivalState,
} from "./core/rivals";
import type {
  BattleDetail,
  BuildingId,
  Command,
  Cost,
  Intel,
  PlanOrder,
  Preset,
  Report,
  ReportDetail,
  ScoutDetail,
  Units,
  UnitId,
  Village,
  WaveDraft,
} from "./core/types";

export const SAVE_KEY = "tribal-3js-save";

/**
 * localStorage, but writing at most every 1.5 s. With 100 bots the save is big and the game changes it several times a
 * second, so saving on every change would waste time; the last state is also written when the page closes.
 */
const lazyStorage = (() => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: [string, string] | null = null;
  const has = () => typeof localStorage !== "undefined";
  const flush = () => {
    if (pending && has()) {
      try {
        localStorage.setItem(pending[0], pending[1]);
      } catch {
        /* storage full or blocked */
      }
    }
    pending = null;
    timer = null;
  };
  if (typeof window !== "undefined")
    window.addEventListener("beforeunload", flush);
  return {
    getItem: (k: string) => (has() ? localStorage.getItem(k) : null),
    removeItem: (k: string) => {
      pending = null;
      if (has()) localStorage.removeItem(k);
    },
    setItem: (k: string, v: string) => {
      pending = [k, v];
      if (!timer) timer = setTimeout(flush, 1500);
    },
  };
})();
const SAVE_VERSION = 12;
/** true = if your whole army dies you learn nothing about the defenders; false = a lost battle still shows who beat you. */
const FOG_OF_WAR = false;
/** Earlier waves that were sent home from a village less than this many real ms before it fell stay there as support. */
const GARRISON_WINDOW_MS = 30_000;
/** true = when a village falls, the armies of your earlier waves that just left it stay as its garrison; false = only the wave that took it stays. */
const EARLIER_WAVES_STAY = false;
/** Buildings catapults cannot destroy completely. */
const MIN_LEVEL: Partial<Record<BuildingId, number>> = {
  main: 1,
  farm: 1,
  warehouse: 1,
  timber: 1,
  clay: 1,
  iron: 1,
};
const HOME = newPlayerVillage("home", PLAYER, 5, 5, Date.now());

/** Everything that makes up a game in progress, as it is on day one. */
function freshGame(o: {
  speed: number;
  mode: RivalMode;
  name?: string;
  luck?: boolean;
}) {
  const now = Date.now();
  const home = newPlayerVillage("home", PLAYER, 5, 5, now);
  if (o.name?.trim()) home.name = o.name.trim().slice(0, 24);
  return {
    now,
    villages: { home },
    activeId: "home",
    target: null,
    selectedBuilding: null,
    commands: [] as Command[],
    reports: [] as Report[],
    rallies: [] as Rally[],
    intel: {},
    hero: { xp: 0 },
    rivals: {},
    rivalMode: o.mode,
    startedAt: now,
    gameSpeed: o.speed,
    luck: o.luck ?? true,
    stats: {},
    news: [] as { at: number; text: string }[],
    aiAdvice: {},
    worldClock: { age: 0, at: now },
    cursor: null,
    picked: null,
    focus: null,
    view: "village" as const,
  };
}

interface GameState {
  now: number;
  villages: Record<string, Village>; // player-owned + touched foreign villages
  activeId: string;
  target: Village | null; // village picked on the world map
  commands: Command[];
  reports: Report[];
  rivals: Record<string, RivalState>; // each clan's mood: grudge, next raid
  rivalMode: RivalMode; // how hostile the world is
  setRivalMode: (m: RivalMode) => void;
  news: { at: number; text: string }[]; // world news: what the bots are doing to each other
  aiEnabled: boolean;
  setAi: (on: boolean) => void; // let an AI model advise the bots (optional)
  aiAdvice: Record<string, Advice & { at: number }>;
  setAdvice: (botId: string, a: (Advice & { at: number }) | null) => void;
  aiStatus: string;
  setAiStatus: (s: string) => void;
  pushNews: (text: string) => void;
  stats: Record<string, Stats>; // kills, losses, loot and resources sent, per player
  worldClock: { age: number; at: number }; // the world's age in game hours at a real moment (bots develop by it)
  /** Erase the saved game and start a brand-new one (your 2D/3D choice and War Table presets are kept). */
  newGame: (o: {
    speed: number;
    mode: RivalMode;
    name?: string;
    luck?: boolean;
  }) => void;
  luck: boolean; // luck on: every attack counts for 75%..125% of its strength
  setLuck: (on: boolean) => void;
  botAggression: number; // 0 Calm · 1 Normal · 2 Aggressive · 3 Relentless: how bold the bots are (they still scout and only attack what they can beat)
  setBotAggression: (n: number) => void;
  gameSpeed: number; // 1 = real time; 60 = one real minute is one game hour
  setGameSpeed: (n: number) => void;
  startedAt: number; // when this game began (rivals leave you alone at first)
  cursor: { x: number; y: number } | null; // the map tile under the mouse (not saved)
  picked: { x: number; y: number } | null; // the last tile you clicked (not saved)
  setCursor: (x: number, y: number) => void;
  pickTile: (x: number, y: number) => void;
  focus: { x: number; y: number; n: number } | null; // ask the world map to centre on a village (not saved)
  focusOn: (x: number, y: number) => void;
  renameVillage: (id: string, name: string) => void;
  hero: { xp: number }; // the single Paladin's experience
  presets: Preset[]; // saved War Table operations
  intel: Record<string, Intel>; // last successful scout of each village
  view: "village" | "world";
  mode: "2d" | "3d";
  setMode: (m: "2d" | "3d") => void;
  setView: (v: "village" | "world") => void;
  selectedBuilding: BuildingId | null;
  selectBuilding: (b: BuildingId | null) => void;
  setActive: (id: string) => void;
  selectTarget: (v: Village | null) => void;
  tick: () => void;
  build: (b: BuildingId) => void;
  recruit: (u: UnitId, n: number) => void;
  /** Commit planned waves; each lands exactly at its arriveAt. Returns an error message, or null on success. */
  plan: (orders: PlanOrder[]) => string | null;
  recall: (id: string) => void;
  /** Open rallies: one village hosts, your other villages send troops, the combined army leaves when the timer ends. */
  rallies: Rally[];
  /** Open a rally against the selected target. Returns an error message, or null on success. */
  startRally: (o: {
    hostId: string;
    targetId: string;
    timerKey: RallyTimerKey; // how long until the army leaves: "30s", "1m", "2m", "5m", "10m"
    targetXY?: [number, number]; // where the target stands (for a village that is not in the saved game yet)
    maxParticipants: number;
    maxTroops: number;
    units: Units; // what the host itself sends
    catTarget?: BuildingId;
  }) => string | null;
  /** Send troops from one of your villages to a rally's host. Returns an error message, or null on success. */
  joinRally: (rallyId: string, fromId: string, units: Units) => string | null;
  /** The host cancels the rally: everyone's troops walk home. */
  cancelRally: (rallyId: string) => void;
  /** Internal: the rallies whose timer ended leave now. */
  launchRallies: (now: number) => void;
  /** Cancel the n-th construction in the active village (and later upgrades of that building); most of it comes back. */
  cancelBuild: (index: number) => void;
  /** Cancel the n-th training order in the active village; most of it comes back. */
  cancelRecruit: (index: number) => void;
  /** Send support troops standing in `hostId` (of village `originId`) back home. */
  withdraw: (hostId: string, originId: string) => void;
  /** Send resources from the active village to another of yours. Returns an error message or null. */
  trade: (toId: string, cargo: Cost) => string | null;
  savePreset: (name: string, waves: WaveDraft[]) => void;
  deletePreset: (id: string) => void;
  updatePreset: (
    id: string,
    patch: { name?: string; waves?: WaveDraft[] },
  ) => void;
}

const name = (id: UnitId) => UNITS[id].name;

/** Sends each village's share of a rally home (the host's own troops go back into the host). Returns the marches. */
function sendRallyHome(
  host: Village,
  taken: { villageId: string; units: Units }[],
  villages: Record<string, Village>,
  now: number,
): Command[] {
  const cmds: Command[] = [];
  for (const t of taken) {
    if (t.villageId === host.id) {
      UNIT_IDS.forEach((u) => (host.units[u] += t.units[u]));
      continue;
    }
    const origin = villages[t.villageId];
    if (!origin || origin.owner !== PLAYER) continue; // its village fell: those troops are lost
    cmds.push({
      id: crypto.randomUUID(),
      kind: "return",
      fromId: host.id,
      toId: origin.id,
      fromXY: [host.x, host.y],
      toXY: [origin.x, origin.y],
      units: t.units,
      loot: emptyCost(),
      departAt: now,
      arriveAt: now + travelMs([host.x, host.y], [origin.x, origin.y], t.units),
    });
  }
  return cmds;
}

export const useGame = create<GameState>()(
  persist(
    (set, get) => ({
      now: Date.now(),
      villages: { home: HOME },
      activeId: "home",
      target: null,
      commands: [],
      reports: [],
      rallies: [],
      intel: {},
      presets: DEFAULT_PRESETS,
      hero: { xp: 0 },
      focus: null,
      rivals: {},
      rivalMode: "raids",
      startedAt: Date.now(),
      gameSpeed: 60,
      luck: true,
      setLuck: (luck) => set({ luck }),
      botAggression: 3,
      setBotAggression: (botAggression) =>
        set({
          botAggression: Math.max(0, Math.min(3, Math.round(botAggression))),
        }),
      news: [],
      aiEnabled: false,
      aiAdvice: {},
      aiStatus: "off",
      setAi: (aiEnabled) =>
        set({ aiEnabled, aiStatus: aiEnabled ? "on" : "off" }),
      setAdvice: (botId, a) => {
        const cur = { ...get().aiAdvice };
        if (a) cur[botId] = a;
        else delete cur[botId];
        set({ aiAdvice: cur });
      },
      setAiStatus: (aiStatus) => set({ aiStatus }),
      pushNews: (text) =>
        set({ news: [{ at: Date.now(), text }, ...get().news].slice(0, 60) }),
      stats: {},
      worldClock: { age: 0, at: Date.now() },
      newGame: (o) => {
        const speed = [1, 10, 60, 600].includes(o.speed) ? o.speed : 60;
        const s = get();
        const fresh = freshGame({ ...o, speed });
        try {
          localStorage.removeItem(SAVE_KEY);
        } catch {
          /* no storage (tests) */
        }
        setSpeed(speed);
        setWorldClock(0, fresh.now); // the world starts at age 0 again, so the bots start as newcomers
        set({
          ...fresh,
          mode: s.mode,
          presets: s.presets,
          botAggression: s.botAggression,
        }); // the new game is saved from this moment on
      },
      setGameSpeed: (n) => {
        const s = get();
        const now = Date.now();
        const speed = [1, 10, 60, 600].includes(n) ? n : 60;
        // bring every village up to date at the OLD speed first, so nothing is paid out at the new one
        const villages = Object.fromEntries(
          Object.entries(s.villages).map(([k, v]) => [
            k,
            settle(normalizeVillage(v), now),
          ]),
        );
        const age = worldAgeHours(now); // the world's age so far, at the old speed
        setSpeed(speed);
        setWorldClock(age, now);
        set({ villages, gameSpeed: speed, worldClock: { age, at: now } });
      },
      setRivalMode: (rivalMode) => set({ rivalMode }),
      view: "village",
      mode: "3d",
      setMode: (mode) => set({ mode }),
      setView: (view) => set({ view }),
      selectedBuilding: null,
      selectBuilding: (selectedBuilding) => set({ selectedBuilding }),
      setActive: (activeId) => set({ activeId, selectedBuilding: null }),
      selectTarget: (target) =>
        set({
          target,
          ...(target ? { picked: { x: target.x, y: target.y } } : {}),
        }),
      cursor: null,
      picked: null,
      setCursor: (x, y) => {
        const c = get().cursor;
        if (!c || c.x !== x || c.y !== y) set({ cursor: { x, y } });
      },
      /** Click on the map ground: remember the tile, and select the village standing on it (if any). */
      pickTile: (x, y) => {
        const s = get();
        const found =
          Object.values(s.villages).find((v) => v.x === x && v.y === y) ??
          villageAt(x, y, Date.now());
        set({ picked: { x, y }, ...(found ? { target: found } : {}) });
      },
      renameVillage: (id, name) => {
        const s = get();
        const v = s.villages[id];
        const n = name.trim().slice(0, 24);
        if (v && v.owner === PLAYER && n)
          set({ villages: { ...s.villages, [id]: { ...v, name: n } } });
      },
      focusOn: (x, y) => {
        const s = get();
        const found =
          Object.values(s.villages).find((v) => v.x === x && v.y === y) ??
          villageAt(x, y, Date.now());
        set({
          view: "world",
          target: found ?? s.target,
          focus: { x, y, n: Date.now() },
        });
      },

      build: (b) => {
        const s = get();
        const nv = tryBuild(
          s.villages[s.activeId],
          b,
          Date.now(),
          s.commands,
          s.villages,
        );
        if (nv) set({ villages: { ...s.villages, [s.activeId]: nv } });
      },
      recruit: (u, n) => {
        const s = get();
        if (
          u === "paladin" &&
          (n !== 1 || paladinCount(s.villages, s.commands) > 0)
        )
          return; // one hero only
        const nv = tryRecruit(
          s.villages[s.activeId],
          u,
          n,
          Date.now(),
          s.commands,
          s.villages,
        );
        if (nv) set({ villages: { ...s.villages, [s.activeId]: nv } });
      },

      plan: (orders) => {
        const s = get();
        const now = Date.now();
        const t = s.target ? (s.villages[s.target.id] ?? s.target) : null;
        if (!t || t.id === s.activeId) return "Pick a target village first.";
        if (rivalInfo(t.owner) && orders.some((o) => o.kind === "attack")) {
          // beginner protection: no attacks on other players yet
          const pts = Object.values(s.villages)
            .filter((v) => v.owner === PLAYER)
            .reduce((n, v) => n + v.points, 0);
          const left = protectionLeftHours(worldAgeHours(now), pts);
          if (left > 0)
            return `Beginner protection: you can't attack other players for another ${Math.ceil(left)} game hours (or until you reach ${PROTECT_POINTS} points). Barbarians are fair game, and you can still scout.`;
        }
        const from = settle(s.villages[s.activeId], now);
        if (from.buildings.rally < 1)
          return "Build a Rally Point to send troops.";
        const need = emptyUnits();
        const cmds: Command[] = [];
        for (let i = 0; i < orders.length; i++) {
          const o = orders[i];
          if (o.kind === "support" && t.owner !== PLAYER)
            return "Support can only be sent to your own villages.";
          if (o.kind !== "support" && t.owner === PLAYER)
            return "Attacks and scouts need an enemy village — pick another target, or send support.";
          const units =
            o.kind === "scout"
              ? { ...emptyUnits(), scout: o.units.scout }
              : o.units;
          if (UNIT_IDS.every((u) => units[u] <= 0))
            return `Wave ${i + 1} has no units.`;
          UNIT_IDS.forEach((u) => (need[u] += units[u]));
          const ms = travelMs([from.x, from.y], [t.x, t.y], units);
          const departAt = o.arriveAt - ms;
          if (departAt < now - 100)
            return `Wave ${i + 1} cannot land that early — it needs ${Math.ceil((now + ms - o.arriveAt) / 1000)}s more.`;
          cmds.push({
            id: crypto.randomUUID(),
            kind: o.kind,
            fromId: from.id,
            toId: t.id,
            fromXY: [from.x, from.y],
            toXY: [t.x, t.y],
            units,
            loot: emptyCost(),
            departAt,
            arriveAt: o.arriveAt,
            smithy: from.buildings.smithy,
            catTarget: units.catapult > 0 ? o.catTarget : undefined,
          });
        }
        if (UNIT_IDS.some((u) => need[u] > from.units[u]))
          return "Not enough troops at home for all waves.";
        UNIT_IDS.forEach((u) => (from.units[u] -= need[u]));
        set({
          villages: { ...s.villages, [from.id]: from },
          commands: [...s.commands, ...cmds],
        });
        return null;
      },

      cancelBuild: (index) => {
        const s = get();
        const now = Date.now();
        const v = settle(normalizeVillage(s.villages[s.activeId]), now);
        const job = v.buildQueue[index];
        if (!job) return;
        const gone = v.buildQueue.filter(
          (j, i) => i === index || (i > index && j.building === job.building), // later upgrades of the same building depend on this one
        );
        const keep = v.buildQueue.filter((j) => !gone.includes(j));
        for (const j of gone) {
          const c = buildCost(j.building, j.level);
          for (const r of RES)
            v.resources[r] = Math.min(
              capacity(v),
              v.resources[r] + Math.floor(c[r] * CANCEL_REFUND),
            );
        }
        let cursor = index > 0 ? v.buildQueue[index - 1].finishesAt : now; // the jobs behind it move up
        v.buildQueue = keep.map((j, i) =>
          i < index
            ? j
            : {
                ...j,
                finishesAt: (cursor += buildTimeMs(
                  j.building,
                  j.level,
                  v.buildings.main,
                )),
              },
        );
        set({ villages: { ...s.villages, [v.id]: v } });
      },
      cancelRecruit: (index) => {
        const s = get();
        const now = Date.now();
        const v = settle(normalizeVillage(s.villages[s.activeId]), now);
        const job = v.recruitQueue[index];
        if (!job) return;
        for (const r of RES)
          v.resources[r] = Math.min(
            capacity(v),
            v.resources[r] +
              Math.floor(UNITS[job.unit].cost[r] * job.count * CANCEL_REFUND),
          );
        let cursor = index > 0 ? v.recruitQueue[index - 1].finishesAt : now;
        v.recruitQueue = v.recruitQueue
          .filter((_, i) => i !== index)
          .map((j, i) =>
            i < index
              ? j
              : {
                  ...j,
                  finishesAt: (cursor +=
                    recruitTimeMs(
                      j.unit,
                      v.buildings[UNITS[j.unit].trainedAt],
                    ) * j.count),
                },
          );
        set({ villages: { ...s.villages, [v.id]: v } });
      },

      startRally: (o) => {
        const s = get();
        const now = Date.now();
        const host0 = s.villages[o.hostId];
        const t =
          s.villages[o.targetId] ??
          (s.target?.id === o.targetId ? s.target : null) ??
          (o.targetXY ? villageAt(o.targetXY[0], o.targetXY[1], now) : null);
        if (!host0 || host0.owner !== PLAYER)
          return "Pick one of your villages to host the rally.";
        if (!t || t.owner === PLAYER)
          return "Pick an enemy or barbarian village as the target.";
        if (s.rallies.some((r) => r.hostId === o.hostId))
          return "This village already hosts a rally.";
        if (rivalInfo(t.owner)) {
          // beginner protection: no attacks on other players yet
          const pts = Object.values(s.villages)
            .filter((v) => v.owner === PLAYER)
            .reduce((n, v) => n + v.points, 0);
          const left = protectionLeftHours(worldAgeHours(now), pts);
          if (left > 0)
            return `Beginner protection: you can't attack other players for another ${Math.ceil(left)} game hours (or until you reach ${PROTECT_POINTS} points).`;
        }
        const timerMs = RALLY_TIMER_MS[o.timerKey];
        if (!timerMs) return "Pick one of the timers.";
        const host = settle(normalizeVillage(host0), now);
        if (host.buildings.rally < 1)
          return "Build a Rally Point to send troops.";
        const units = o.units;
        if ((units.noble ?? 0) > 0) return "Nobles cannot join a rally.";
        const n = troopCount(units);
        if (n < 1) return "Choose the troops the host village sends.";
        if (UNIT_IDS.some((u) => units[u] > host.units[u]))
          return "The host does not have that many troops at home.";
        const maxTroops = Math.min(
          RALLY.maxTroopsLimit,
          Math.max(1, Math.floor(o.maxTroops)),
        );
        const maxParticipants = Math.min(
          RALLY.maxParticipantsLimit,
          Math.max(2, Math.floor(o.maxParticipants)),
        );
        if (n > maxTroops)
          return `The host alone sends ${n} troops, more than the rally cap of ${maxTroops}.`;
        UNIT_IDS.forEach((u) => (host.units[u] -= units[u]));
        // the host's own troops wait at home, still defending it (the same place the other villages' troops will wait)
        host.stationed = { ...host.stationed, [host.id]: { ...units } };
        const rally: Rally = {
          id: crypto.randomUUID(),
          hostId: host.id,
          targetId: t.id,
          targetXY: [t.x, t.y],
          createdAt: now,
          startsAt: now + timerMs,
          maxParticipants,
          maxTroops,
          joins: [{ villageId: host.id, units: { ...units } }],
          pending: [],
          catTarget: o.catTarget,
        };
        set({
          villages: { ...s.villages, [host.id]: host },
          rallies: [...s.rallies, rally],
        });
        return null;
      },
      joinRally: (rallyId, fromId, units) => {
        const s = get();
        const now = Date.now();
        const r = s.rallies.find((x) => x.id === rallyId);
        if (!r) return "That rally is over.";
        const host = s.villages[r.hostId];
        const from0 = s.villages[fromId];
        if (!host || host.owner !== PLAYER) return "The host village is gone.";
        if (!from0 || from0.owner !== PLAYER)
          return "Pick one of your villages.";
        if (fromId === r.hostId) return "The host's troops are already in.";
        const from = settle(normalizeVillage(from0), now);
        if (from.buildings.rally < 1)
          return "Build a Rally Point to send troops.";
        if (UNIT_IDS.some((u) => units[u] > from.units[u]))
          return "Not enough troops at home.";
        const ms = travelMs([from.x, from.y], [host.x, host.y], units);
        const problem = joinProblem(r, fromId, units, ms, now);
        if (problem) return problem;
        UNIT_IDS.forEach((u) => (from.units[u] -= units[u]));
        const entry = { villageId: fromId, units: { ...units } };
        set({
          villages: { ...s.villages, [from.id]: from },
          commands: [
            ...s.commands,
            {
              id: crypto.randomUUID(),
              kind: "rally",
              rallyId,
              fromId,
              toId: host.id,
              fromXY: [from.x, from.y],
              toXY: [host.x, host.y],
              units: { ...units },
              loot: emptyCost(),
              departAt: now,
              arriveAt: now + ms,
              smithy: from.buildings.smithy,
            },
          ],
          rallies: s.rallies.map((x) =>
            x.id === rallyId ? { ...x, pending: [...x.pending, entry] } : x,
          ),
        });
        return null;
      },
      cancelRally: (rallyId) => {
        const s = get();
        const now = Date.now();
        const r = s.rallies.find((x) => x.id === rallyId);
        if (!r) return;
        const host0 = s.villages[r.hostId];
        if (!host0)
          return set({ rallies: s.rallies.filter((x) => x.id !== rallyId) });
        const { host, taken } = collectRally(
          settle(normalizeVillage(host0), now),
          r,
        );
        const cmds = sendRallyHome(host, taken, s.villages, now);
        set({
          villages: { ...s.villages, [host.id]: host },
          commands: [...s.commands, ...cmds],
          rallies: s.rallies.filter((x) => x.id !== rallyId),
        });
      },
      launchRallies: (now) => {
        const s = get();
        const dueList = s.rallies.filter((r) => r.startsAt <= now);
        if (!dueList.length) return;
        const villages = { ...s.villages };
        const cmds: Command[] = [];
        const reports = [...s.reports];
        for (const r of dueList) {
          const host0 = villages[r.hostId];
          if (!host0) continue;
          const { host, taken } = collectRally(
            settle(normalizeVillage(host0), now),
            r,
          );
          const target =
            villages[r.targetId] ??
            villageAt(r.targetXY[0], r.targetXY[1], now);
          const army = sumUnits(taken.map((t) => t.units));
          if (!target || target.owner === PLAYER || troopCount(army) < 1) {
            // nothing to attack any more (or nobody came): everybody walks home
            cmds.push(...sendRallyHome(host, taken, villages, now));
            villages[host.id] = host;
            reports.unshift({
              id: `rally-${r.id}`,
              at: now,
              text: `📯 The rally at ${host.name} was called off: the target is gone, so the troops walk home`,
            });
            continue;
          }
          villages[host.id] = host;
          cmds.push({
            id: crypto.randomUUID(),
            kind: "attack",
            fromId: host.id,
            toId: target.id,
            fromXY: [host.x, host.y],
            toXY: [target.x, target.y],
            units: army,
            loot: emptyCost(),
            departAt: now,
            arriveAt:
              now + travelMs([host.x, host.y], [target.x, target.y], army),
            smithy: host.buildings.smithy,
            catTarget: army.catapult > 0 ? r.catTarget : undefined,
            rally: taken,
          });
          reports.unshift({
            id: `rally-${r.id}`,
            at: now,
            text: `📯 The rally leaves ${host.name}: ${troopCount(army)} troops from ${taken.length} village${taken.length === 1 ? "" : "s"} march on ${target.name}`,
          });
        }
        set({
          villages,
          commands: [...s.commands, ...cmds],
          reports: reports.slice(0, 40),
          rallies: s.rallies.filter((r) => r.startsAt > now),
        });
      },

      recall: (id) => {
        const s = get();
        const now = Date.now();
        const c = s.commands.find((x) => x.id === id);
        if (
          !c ||
          c.kind === "return" ||
          c.kind === "trade" ||
          c.kind === "raid" ||
          c.kind === "rally" ||
          !!c.rally ||
          now >= c.arriveAt ||
          now - c.departAt > recallWindowMs()
        )
          return;
        const rest = s.commands.filter((x) => x.id !== id);
        const elapsed = Math.max(0, now - c.departAt);
        const home = settle(s.villages[c.fromId], now);
        if (elapsed <= 0) {
          // not departed yet: units simply stay home
          UNIT_IDS.forEach((u) => (home.units[u] += c.units[u]));
          return set({
            villages: { ...s.villages, [c.fromId]: home },
            commands: rest,
          });
        }
        const f = Math.min(1, elapsed / (c.arriveAt - c.departAt)); // turn around where they are now
        const here: [number, number] = [
          c.fromXY[0] + (c.toXY[0] - c.fromXY[0]) * f,
          c.fromXY[1] + (c.toXY[1] - c.fromXY[1]) * f,
        ];
        set({
          commands: [
            ...rest,
            {
              ...c,
              id: crypto.randomUUID(),
              kind: "return",
              fromId: c.toId,
              toId: c.fromId,
              fromXY: here,
              toXY: c.fromXY,
              loot: emptyCost(),
              departAt: now,
              arriveAt: now + elapsed,
            },
          ],
        });
      },

      withdraw: (hostId, originId) => {
        const s = get();
        const now = Date.now();
        const host = s.villages[hostId];
        const origin = s.villages[originId];
        const stack = host?.stationed?.[originId];
        // only YOUR support in YOUR villages can be sent home (a stack left by someone else never becomes yours)
        if (
          !host ||
          !origin ||
          hostId === originId ||
          host.owner !== PLAYER ||
          origin.owner !== PLAYER ||
          !stack ||
          UNIT_IDS.every((u) => stack[u] <= 0)
        )
          return;
        const rest = { ...host.stationed };
        delete rest[originId];
        set({
          villages: { ...s.villages, [hostId]: { ...host, stationed: rest } },
          commands: [
            ...s.commands,
            {
              id: crypto.randomUUID(),
              kind: "return",
              fromId: hostId,
              toId: originId,
              fromXY: [host.x, host.y],
              toXY: [origin.x, origin.y],
              units: stack,
              loot: emptyCost(),
              departAt: now,
              arriveAt:
                now + travelMs([host.x, host.y], [origin.x, origin.y], stack),
            },
          ],
        });
      },

      trade: (toId, cargo) => {
        const s = get();
        const now = Date.now();
        const to = s.villages[toId];
        if (!to || to.owner !== PLAYER || toId === s.activeId)
          return "Pick another one of your villages.";
        const from = settle(s.villages[s.activeId], now);
        if (from.buildings.market < 1)
          return "Build a Market to send resources.";
        const total = RES.reduce((a, r) => a + cargo[r], 0);
        if (total <= 0) return "Nothing to send.";
        const need = Math.ceil(total / MERCHANT_CAPACITY);
        const free = merchantsFree(from, s.commands);
        if (need > free)
          return `Not enough merchants: ${need} needed, ${free} free.`;
        if (RES.some((r) => cargo[r] > Math.floor(from.resources[r])))
          return "Not enough resources.";
        RES.forEach((r) => (from.resources[r] -= cargo[r]));
        set({
          stats: {
            ...s.stats,
            [PLAYER]: addStats(s.stats[PLAYER], { sent: total }),
          },
          villages: { ...s.villages, [from.id]: from },
          commands: [
            ...s.commands,
            {
              id: crypto.randomUUID(),
              kind: "trade",
              fromId: from.id,
              toId,
              fromXY: [from.x, from.y],
              toXY: [to.x, to.y],
              units: emptyUnits(),
              loot: { ...cargo },
              merchants: need,
              departAt: now,
              arriveAt: now + tradeMs([from.x, from.y], [to.x, to.y]),
            },
          ],
        });
        return null;
      },

      savePreset: (name, waves) =>
        set({
          presets: [...get().presets, { id: crypto.randomUUID(), name, waves }],
        }),
      deletePreset: (id) =>
        set({ presets: get().presets.filter((p) => p.id !== id) }),
      updatePreset: (id, patch) =>
        set({
          presets: get().presets.map((p) =>
            p.id === id ? { ...p, ...patch } : p,
          ),
        }),

      /** Called ~4x/sec. Only resolves due commands; villages settle lazily on demand. */
      tick: () => {
        const now = Date.now();
        if (get().rallies.some((r) => r.startsAt <= now))
          get().launchRallies(now); // a rally whose timer ended leaves now
        const s = get();
        // rivals decide first: they may launch raids (lazily: nothing runs while you are away, the raids just resolve in order)
        const myPoints = Object.values(s.villages)
          .filter((v) => v.owner === PLAYER)
          .reduce((n, v) => n + v.points, 0);
        const rv = stepRivals({
          now,
          startedAt: s.startedAt,
          mode: s.rivalMode,
          rivals: s.rivals,
          villages: s.villages,
          protectedPlayer:
            protectionLeftHours(worldAgeHours(now), myPoints) > 0,
          advice: s.aiAdvice,
          commands: s.commands,
          aggression: s.botAggression,
        });
        let newsAll = rv.news.length
          ? [...rv.news.map((text) => ({ at: now, text })), ...s.news].slice(
              0,
              60,
            )
          : s.news;
        const applyBumps = (base: Record<string, Stats>) => {
          if (!rv.bumps.length) return base;
          const n = { ...base };
          for (const [k, d] of rv.bumps) n[k] = addStats(n[k], d);
          return n;
        };
        const adviceLeft = rv.acted.length
          ? Object.fromEntries(
              Object.entries(s.aiAdvice).filter(([k]) => !rv.acted.includes(k)),
            )
          : s.aiAdvice; // a plan is used once
        const live = s.commands.filter((c) => {
          if (c.clan && c.kind !== "return") {
            // the village they marched from was taken since: that army never arrives
            const o = s.villages[c.fromId]?.owner;
            if (o !== undefined && o !== c.clan) return false;
          }
          if (c.clan && c.kind === "return") {
            // they were walking home to a village that has changed hands
            const o = s.villages[c.toId]?.owner;
            if (o !== undefined && o !== c.clan) return false;
          }
          if (c.kind === "raid" && c.fromId === c.toId) return false;
          return true;
        });
        const baseEverything = rv.raids.length ? [...live, ...rv.raids] : live;
        // bots look at the marches in flight: they reinforce villages about to be hit and call the reinforcements home
        const def = defendPass({
          now,
          villages: { ...s.villages, ...rv.villages },
          commands: baseEverything,
        });
        const everything = def.commands.length
          ? [...baseEverything, ...def.commands]
          : baseEverything;
        const rvVillages = Object.keys(def.villages).length
          ? { ...rv.villages, ...def.villages }
          : rv.villages;
        if (def.news.length)
          newsAll = [
            ...def.news.map((text) => ({ at: now, text })),
            ...newsAll,
          ].slice(0, 60);
        const due = everything.filter((c) => c.arriveAt <= now);
        if (!due.length) {
          return set({
            now,
            rivals: rv.rivals,
            ...(Object.keys(rvVillages).length
              ? { villages: { ...s.villages, ...rvVillages } }
              : {}),
            ...(everything !== s.commands ? { commands: everything } : {}),
            ...(rv.news.length || def.news.length ? { news: newsAll } : {}),
            ...(rv.bumps.length ? { stats: applyBumps(s.stats) } : {}),
            ...(rv.acted.length ? { aiAdvice: adviceLeft } : {}),
            ...(rv.alerts.length
              ? {
                  reports: [
                    ...rv.alerts.map((x) => ({
                      id: x.id,
                      at: now,
                      text: x.text,
                    })),
                    ...s.reports,
                  ].slice(0, 40),
                }
              : {}),
          });
        }
        const villages = { ...s.villages, ...rvVillages };
        const commands = everything.filter((c) => c.arriveAt > now);
        const reports = [...s.reports];
        const worldNews: { at: number; text: string }[] = []; // what the bots did to each other this tick
        const intel = { ...s.intel };
        const rivalsNext = { ...rv.rivals };
        const statsNext = { ...applyBumps(s.stats) };
        const lostIds = new Set<string>(); // villages you lose to a noble run this tick
        const bump = (name: string | null, d: Partial<Stats>) => {
          if (name && (name === PLAYER || rivalInfo(name)))
            statsNext[name] = addStats(statsNext[name], d);
        }; // barbarians keep no score
        const count = (u: Units) => UNIT_IDS.reduce((n, k) => n + u[k], 0);
        rv.alerts.forEach((x) =>
          reports.unshift({ id: x.id, at: now, text: x.text }),
        );
        let heroXp = s.hero.xp;
        let rallies = s.rallies;
        let ralliesChanged = false;
        const say = (id: string, text: string, detail?: ReportDetail) =>
          reports.unshift({ id, at: now, text, detail });
        // When a village changes hands, support that came FROM it and is still standing in other villages belongs to
        // nobody any more. Dropping it stops those troops from ever "coming home" to the new owner.
        const releaseSupportOf = (id: string) => {
          for (const h of Object.values(villages)) {
            if (!h.stationed?.[id]) continue;
            const rest = { ...h.stationed };
            delete rest[id];
            villages[h.id] = { ...h, stationed: rest };
          }
        };
        // a bot's Paladin leads its clearing army: a won fight gives him experience, a lost one kills him
        const botHero = (
          clanName: string | undefined,
          won: boolean,
          conquered = false,
        ) => {
          const bot = CLANS.find((k) => k.name === clanName);
          if (!bot) return;
          const st = rivalsNext[bot.id] ?? {
            grudge: 0,
            nextRaidAt: now + raidIntervalMs(),
            raids: 0,
            updatedAt: now,
          };
          const xp = won
            ? (st.heroXp ?? 0) +
              HERO_XP_WIN +
              (conquered ? HERO_XP_CONQUEST : 0)
            : 0;
          rivalsNext[bot.id] = { ...st, heroXp: xp };
          if (heroLevel(xp) > heroLevel(st.heroXp ?? 0))
            worldNews.push({
              at: now,
              text: `🦸 ${bot.name}'s Paladin reached level ${heroLevel(xp)}`,
            });
          else if (!won && (st.heroXp ?? 0) >= 100)
            worldNews.push({
              at: now,
              text: `💀 ${bot.name}'s Paladin fell in battle`,
            });
        };
        const provoke = (clan: Clan, amount: number) => {
          // hit a clan and it remembers
          const st = rivalsNext[clan.id] ?? {
            grudge: 0,
            nextRaidAt: now + raidIntervalMs(),
            raids: 0,
            updatedAt: now,
          };
          rivalsNext[clan.id] = {
            ...st,
            grudge: Math.min(6, st.grudge + amount),
            nextRaidAt: Math.min(st.nextRaidAt, now + retaliateDelayMs()),
            nextActAt: Math.min(
              st.nextActAt ?? Infinity,
              now + retaliateDelayMs(),
            ), // it takes its next turn soon, first in line
            followUp: true,
          };
        };

        for (const c of due.sort((a, b) => a.arriveAt - b.arriveAt)) {
          if (
            !c.clan &&
            c.kind !== "raid" &&
            c.kind !== "expand" &&
            (lostIds.has(c.fromId) || lostIds.has(c.toId))
          )
            continue; // sent by (or to) a village that has just fallen
          const goHome = (units: Units, loot = emptyCost()) => {
            if (UNIT_IDS.every((u) => units[u] <= 0)) return;
            commands.push({
              ...c,
              id: crypto.randomUUID(),
              kind: "return",
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
          // a rally walks home in pieces: each village gets its share of the survivors and of the loot
          const returnRally = (surv: Units, loot: Cost) => {
            const joins = c.rally ?? [];
            const parts = splitSurvivors(surv, c.units, joins);
            const lootParts = splitLoot(loot, joins);
            joins.forEach((j, i) => {
              const origin = villages[j.villageId];
              if (
                !origin ||
                origin.owner !== PLAYER ||
                troopCount(parts[i]) <= 0
              )
                return; // its village fell: those troops are lost
              commands.push({
                ...c,
                id: crypto.randomUUID(),
                kind: "return",
                rally: undefined,
                fromId: c.toId,
                toId: origin.id,
                fromXY: c.toXY,
                toXY: [origin.x, origin.y],
                units: parts[i],
                loot: lootParts[i],
                departAt: now,
                arriveAt:
                  now + travelMs(c.toXY, [origin.x, origin.y], parts[i]),
              });
            });
          };

          if (c.kind === "return") {
            const dest = villages[c.toId];
            // nowhere to return to (the village changed hands): they are lost
            if (
              c.clan ? !dest || dest.owner !== c.clan : dest?.owner !== PLAYER
            )
              continue;
            const home = settle(normalizeVillage(villages[c.toId]), now);
            UNIT_IDS.forEach((u) => (home.units[u] += c.units[u]));
            RES.forEach((r) => (home.resources[r] += c.loot[r]));
            villages[c.toId] = home;
            continue;
          }

          if (c.kind === "support") {
            // troops move in as a recallable garrison (yours, or a bot's reinforcements for its own villages)
            const base =
              villages[c.toId] ?? villageAt(c.toXY[0], c.toXY[1], now);
            if (!base) {
              goHome(c.units);
              continue;
            }
            const host = settle(normalizeVillage(base), now);
            if (c.clan ? host.owner !== c.clan : host.owner !== PLAYER) {
              goHome(c.units); // the village changed hands: they turn back
              continue;
            }
            const old = host.stationed[c.fromId] ?? emptyUnits();
            host.stationed = {
              ...host.stationed,
              [c.fromId]: UNIT_IDS.reduce(
                (o, u) => ({ ...o, [u]: old[u] + c.units[u] }),
                {} as Units,
              ),
            };
            villages[host.id] = host;
            if (!c.clan)
              say(
                c.id,
                `🛡 Support from ${villages[c.fromId]?.name ?? c.fromId} arrived at ${host.name}`,
              );
            continue;
          }

          if (c.kind === "trade") {
            // deliver, then the merchants walk home (a bot's caravan between its own villages too)
            const dest = settle(normalizeVillage(villages[c.toId]), now);
            if (c.clan ? dest.owner !== c.clan : dest.owner !== PLAYER)
              continue;
            const cap = capacity(dest);
            let delivered = 0;
            let lost = 0;
            for (const r of RES) {
              const put = Math.max(
                0,
                Math.min(c.loot[r], cap - dest.resources[r]),
              );
              dest.resources[r] += put;
              delivered += put;
              lost += c.loot[r] - put;
            }
            villages[dest.id] = dest;
            if (!c.clan)
              say(
                c.id,
                `🏪 ${Math.round(delivered)} resources delivered to ${dest.name}${lost > 0 ? ` (${Math.round(lost)} lost: warehouse full)` : ""}`,
              );
            commands.push({
              ...c,
              id: crypto.randomUUID(),
              kind: "return",
              fromId: c.toId,
              toId: c.fromId,
              fromXY: c.toXY,
              toXY: c.fromXY,
              loot: emptyCost(),
              departAt: now,
              arriveAt: now + (c.arriveAt - c.departAt),
            });
            continue;
          }

          if (c.kind === "expand") {
            // a bot's noble wave on one of YOUR villages (one noble per wave; each wave cuts loyalty once)
            const bot = CLANS.find((k) => k.name === c.clan);
            const tv = villages[c.toId];
            if (!bot || !tv || tv.owner !== PLAYER) continue;
            const tgt = settle(normalizeVillage(tv), c.arriveAt);
            const defBefore = garrison(tgt);
            const wallBefore = tgt.buildings.wall;
            const loyaltyBefore = tgt.loyalty;
            const luck = s.luck ? luckOf(c.id) : 0; // the attacker's luck, -25%..+25% (0 when luck is switched off)
            const bonus =
              attackBonusFor(
                c.smithy ?? 0,
                { ...c.units, paladin: c.heroLevel ? 1 : 0 },
                c.heroLevel ?? 0,
              ) *
              (1 + luck);
            const defBonus = defenseBonusFor(tgt.buildings.smithy);
            const pw = battlePowers(
              c.units,
              defBefore,
              wallBefore,
              bonus,
              defBonus,
            );
            const res = resolveBattle(
              c.units,
              defBefore,
              wallBefore,
              bonus,
              defBonus,
            );
            tgt.units = survivorsOf(tgt.units, defBefore, res.defenderLeft);
            tgt.stationed = Object.fromEntries(
              Object.entries(tgt.stationed).map(([k, u]) => [
                k,
                survivorsOf(u, defBefore, res.defenderLeft),
              ]),
            );
            tgt.buildings.wall = res.wallAfter;
            const yours = Object.values(villages).filter(
              (v) => v.owner === PLAYER,
            ).length;
            let conquered = false;
            let hit = 0;
            if (res.attackerWins && res.attackerLeft.noble > 0) {
              hit = loyaltyHit(c.id); // one noble works per attack: 20..35 loyalty
              tgt.loyalty -= hit;
              if (tgt.loyalty < 1) {
                if (yours > 1) conquered = true;
                else tgt.loyalty = 1;
              } // nobody can take your LAST village
            }
            const killed = count(defBefore) - count(res.defenderLeft),
              fell = count(c.units) - count(res.attackerLeft);
            bump(bot.name, { kills: killed, lost: fell });
            bump(PLAYER, { kills: fell, lost: killed });
            if (c.heroLevel) botHero(c.clan, res.attackerWins, conquered);
            const detail: BattleDetail = {
              kind: "battle",
              luck: s.luck ? luck : undefined,
              perspective: "defense",
              outcome: conquered
                ? "conquered"
                : res.attackerWins
                  ? "win"
                  : "loss",
              attacker: {
                village: `${bot.name} (noble wave)`,
                xy: c.fromXY,
                sent: { ...c.units },
                left: res.attackerLeft,
                bonus,
                heroLevel: 0,
              },
              defender: {
                village: tgt.name,
                xy: c.toXY,
                known: true,
                before: defBefore,
                left: res.defenderLeft,
                bonus: defBonus,
              },
              powers: {
                attack: pw.a,
                defense: pw.d,
                effWall: pw.effWall,
                shares: pw.shares,
                rating: pw.rating,
              },
              wall: {
                before: wallBefore,
                after: tgt.buildings.wall,
                rams: c.units.ram,
              },
              loot: emptyCost(),
              carry: 0,
              loyalty: {
                before: loyaltyBefore,
                after: Math.max(0, tgt.loyalty),
                nobles: hit > 0 ? 1 : 0,
                hit,
              },
            };
            if (conquered) {
              const was = tgt.name;
              Object.assign(tgt, {
                owner: bot.name,
                name: `${bot.name} Outpost`,
                loyalty: 25,
                units: { ...res.attackerLeft, noble: 0 },
                stationed: {},
                buildQueue: [],
                recruitQueue: [],
                goal: undefined,
              });
              lostIds.add(tgt.id);
              releaseSupportOf(tgt.id); // troops you had out from it are gone
              for (let i = commands.length - 1; i >= 0; i--) {
                const q = commands[i];
                if (
                  !q.clan &&
                  q.kind !== "raid" &&
                  q.kind !== "expand" &&
                  (q.fromId === tgt.id || q.toId === tgt.id)
                )
                  commands.splice(i, 1);
              }
              const st = rivalsNext[bot.id] ?? {
                grudge: 0,
                nextRaidAt: now + raidIntervalMs(),
                raids: 0,
                updatedAt: now,
              };
              rivalsNext[bot.id] = { ...st, held: (st.held ?? 0) + 1 };
              say(
                c.id,
                `💔 ${bot.name} conquered ${was}! Troops you had away from it, and every march it sent, are lost`,
                detail,
              );
            } else {
              say(
                c.id,
                res.attackerWins
                  ? `⚠ ${bot.name}'s nobles hit ${tgt.name}: loyalty ${Math.round(loyaltyBefore)} → ${Math.max(0, Math.round(tgt.loyalty))}`
                  : `🛡 ${tgt.name} held against ${bot.name}'s noble wave`,
                detail,
              );
            }
            villages[tgt.id] = tgt;
            continue;
          }

          if (c.kind === "raid") {
            // a rival clan hits one of your villages
            const tv = villages[c.toId];
            if (!tv || tv.owner !== PLAYER) continue;
            const tgt = settle(normalizeVillage(tv), c.arriveAt);
            const defBefore = garrison(tgt);
            const wallBefore = tgt.buildings.wall;
            const luck = s.luck ? luckOf(c.id) : 0; // the attacker's luck, -25%..+25% (0 when luck is switched off)
            const bonus =
              attackBonusFor(
                c.smithy ?? 0,
                { ...c.units, paladin: c.heroLevel ? 1 : 0 },
                c.heroLevel ?? 0,
              ) *
              (1 + luck);
            const defBonus = defenseBonusFor(tgt.buildings.smithy); // YOUR village's smithy, for everyone standing in it
            const pw = battlePowers(
              c.units,
              defBefore,
              wallBefore,
              bonus,
              defBonus,
            );
            const res = resolveBattle(
              c.units,
              defBefore,
              wallBefore,
              bonus,
              defBonus,
            );
            tgt.units = survivorsOf(tgt.units, defBefore, res.defenderLeft); // your troops AND any support standing here share the losses
            tgt.stationed = Object.fromEntries(
              Object.entries(tgt.stationed).map(([k, u]) => [
                k,
                survivorsOf(u, defBefore, res.defenderLeft),
              ]),
            );
            tgt.buildings.wall = res.wallAfter;
            const loot = emptyCost();
            let carry = 0;
            if (res.attackerWins) {
              carry = carryCapacity(res.attackerLeft);
              const safe = hidingProtect(tgt.buildings.hiding); // the Hiding Place keeps its share out of reach
              for (const r of RES) {
                const take = Math.min(
                  Math.max(0, Math.floor(tgt.resources[r]) - safe),
                  Math.floor(carry / 3),
                );
                loot[r] = take;
                tgt.resources[r] -= take;
              }
            }
            villages[tgt.id] = tgt;
            const clan = c.clan ?? "Rival";
            const detail: BattleDetail = {
              kind: "battle",
              luck: s.luck ? luck : undefined,
              perspective: "defense",
              outcome: res.attackerWins ? "win" : "loss",
              attacker: {
                village: `${clan} raiders`,
                xy: c.fromXY,
                sent: { ...c.units },
                left: res.attackerLeft,
                bonus,
                heroLevel: 0,
              },
              defender: {
                village: tgt.name,
                xy: c.toXY,
                known: true,
                before: defBefore,
                left: res.defenderLeft,
                bonus: defBonus,
              },
              powers: {
                attack: pw.a,
                defense: pw.d,
                effWall: pw.effWall,
                shares: pw.shares,
                rating: pw.rating,
              },
              wall: {
                before: wallBefore,
                after: tgt.buildings.wall,
                rams: c.units.ram,
              },
              loot,
              carry,
            };
            const took = loot.wood + loot.clay + loot.iron;
            {
              const killed = count(defBefore) - count(res.defenderLeft),
                fell = count(c.units) - count(res.attackerLeft);
              bump(c.clan ?? null, { kills: killed, lost: fell, looted: took });
              bump(PLAYER, { kills: fell, lost: killed });
              if (c.heroLevel) botHero(c.clan, res.attackerWins);
            }
            if (res.attackerWins)
              commands.push({
                ...c,
                id: crypto.randomUUID(),
                kind: "return",
                fromId: c.toId,
                toId: c.fromId,
                fromXY: c.toXY,
                toXY: c.fromXY,
                units: res.attackerLeft,
                loot,
                departAt: now,
                arriveAt: now + (c.arriveAt - c.departAt),
              }); // the survivors carry the loot HOME to their village
            say(
              c.id,
              res.attackerWins
                ? `💀 ${clan} raiders broke through at ${tgt.name} — they carried off ${took} resources`
                : `🛡 ${tgt.name} held against the ${clan} raid`,
              detail,
            );
            continue;
          }

          if (c.kind === "scout" && c.clan) {
            // a bot's scouts: they learn about the village, you get no report
            const sc = CLANS.find((k) => k.name === c.clan);
            const base =
              villages[c.toId] ?? villageAt(c.toXY[0], c.toXY[1], now);
            if (!sc || !base) continue;
            const tgt = settle(normalizeVillage(base), c.arriveAt);
            const enemyBefore = tgt.units.scout;
            const r = resolveScout(c.units.scout, enemyBefore);
            tgt.units.scout = Math.max(0, enemyBefore - r.defenderLost);
            villages[tgt.id] = tgt;
            recordScout(
              sc.id,
              tgt.id,
              now,
              r.success && r.tier >= 2
                ? {
                    rating: defenseRating(
                      garrison(tgt),
                      tgt.buildings.wall,
                      defenseBonusFor(tgt.buildings.smithy),
                    ),
                    wall: tgt.buildings.wall,
                  }
                : undefined,
            );
            if (r.success) goHome({ ...emptyUnits(), scout: r.left });
            continue;
          }

          if (c.kind === "rally") {
            // troops sent to a rally reach the host village and wait there (as its support) until the timer ends
            const hostV = villages[c.toId];
            if (!hostV || hostV.owner !== PLAYER) {
              goHome(c.units);
              continue;
            }
            const h = settle(normalizeVillage(hostV), now);
            const old = h.stationed[c.fromId] ?? emptyUnits();
            h.stationed = {
              ...h.stationed,
              [c.fromId]: UNIT_IDS.reduce(
                (o, u) => ({ ...o, [u]: old[u] + c.units[u] }),
                {} as Units,
              ),
            };
            villages[h.id] = h;
            const r = rallies.find((x) => x.id === c.rallyId);
            const entry = r?.pending.find((p) => p.villageId === c.fromId);
            const fromName = villages[c.fromId]?.name ?? c.fromId;
            if (r && entry && now < r.startsAt) {
              rallies = rallies.map((x) =>
                x.id === r.id
                  ? {
                      ...x,
                      pending: x.pending.filter((p) => p !== entry),
                      joins: [...x.joins, entry],
                    }
                  : x,
              );
              ralliesChanged = true;
              say(
                c.id,
                `📯 Troops from ${fromName} joined the rally at ${h.name}`,
              );
            } else {
              say(
                c.id,
                `🛡 Troops from ${fromName} reached ${h.name} after its rally ended and stay there as support`,
              );
            }
            continue;
          }

          if (c.kind === "strike") {
            // a bot's army (the clearing army, or one noble wave) lands on a barbarian village or on another bot
            const bot = CLANS.find((k) => k.name === c.clan);
            if (!bot) continue;
            const r = landStrike(c, villages, now, bot, s.luck);
            Object.assign(villages, r.changed);
            for (const x of r.commands) commands.push(x);
            for (const t of r.news) worldNews.push({ at: now, text: t });
            for (const [k, d] of r.bumps) bump(k, d);
            if (r.hero) {
              const st = rivalsNext[bot.id] ?? {
                grudge: 0,
                nextRaidAt: now + raidIntervalMs(),
                raids: 0,
                updatedAt: now,
              };
              const xp = r.hero.fell ? 0 : (st.heroXp ?? 0) + r.hero.xp;
              rivalsNext[bot.id] = { ...st, heroXp: xp };
              if (heroLevel(xp) > heroLevel(st.heroXp ?? 0))
                worldNews.push({
                  at: now,
                  text: `🦸 ${bot.name}'s Paladin reached level ${heroLevel(xp)}`,
                });
              else if (r.hero.fell && (st.heroXp ?? 0) >= 100)
                worldNews.push({
                  at: now,
                  text: `💀 ${bot.name}'s Paladin fell in battle`,
                });
            }
            if (r.held) {
              const st = rivalsNext[bot.id] ?? {
                grudge: 0,
                nextRaidAt: now + raidIntervalMs(),
                raids: 0,
                updatedAt: now,
              };
              rivalsNext[bot.id] = { ...st, held: (st.held ?? 0) + r.held };
            }
            continue;
          }

          const target = settle(
            normalizeVillage(
              villages[c.toId] ?? villageAt(c.toXY[0], c.toXY[1], now)!,
            ),
            c.arriveAt,
          );

          if (c.kind === "scout") {
            const enemyBefore = target.units.scout;
            const r = resolveScout(c.units.scout, enemyBefore);
            target.units.scout = Math.max(0, enemyBefore - r.defenderLost); // a scouting war: they lose scouts too
            villages[target.id] = target;
            if (!r.success) {
              say(c.id, `🔍 Scouts died at ${target.id}`, {
                kind: "scout",
                village: target.name,
                xy: c.toXY,
                sent: c.units.scout,
                lost: c.units.scout,
                success: false,
              });
              continue;
            }
            const gar = garrison(target); // home troops AND support standing here
            const detail: ScoutDetail = {
              kind: "scout",
              village: target.name,
              xy: c.toXY,
              sent: c.units.scout,
              lost: r.lost,
              success: true,
              tier: r.tier as 1 | 2 | 3,
              enemyScouts: enemyBefore,
              enemyLost: r.defenderLost,
              resources: { ...target.resources },
              loyalty: target.loyalty,
            };
            let line = `🔍 ${target.id} (${SCOUT_TIER_NAME[r.tier]}): 🪵${Math.floor(target.resources.wood)} 🧱${Math.floor(target.resources.clay)} ⛏️${Math.floor(target.resources.iron)} | loyalty ${Math.floor(target.loyalty)}`;
            if (r.tier >= 2) {
              // Recon: troops and wall
              const troops =
                UNIT_IDS.filter((u) => gar[u] > 0)
                  .map((u) => `${name(u)} ${gar[u]}`)
                  .join(", ") || "none";
              detail.wall = target.buildings.wall;
              detail.units = { ...gar };
              detail.rating = defenseRating(
                gar,
                target.buildings.wall,
                defenseBonusFor(target.buildings.smithy),
              );
              line += ` | wall ${target.buildings.wall} | troops: ${troops} | 🛡 ${ATTACK_CLASSES.map((k) => `${CLASS_ICON[k]}${Math.round(detail.rating![k])}`).join(" ")}`;
            }
            if (r.tier >= 3) {
              detail.buildings = { ...target.buildings };
              line += " | buildings revealed";
            } // Full report
            say(c.id, line, detail);
            intel[target.id] = {
              at: now,
              tier: r.tier as 1 | 2 | 3,
              loyalty: target.loyalty,
              resources: { ...target.resources },
              enemyScouts: enemyBefore,
              ...(r.tier >= 2
                ? {
                    units: { ...gar },
                    wall: target.buildings.wall,
                    smithy: target.buildings.smithy,
                  }
                : {}),
              ...(r.tier >= 3 ? { buildings: { ...target.buildings } } : {}),
            };
            goHome({ ...emptyUnits(), scout: r.left });
            continue;
          }

          // A wave that lands after an earlier wave already took the village must not attack your own garrison
          // (it would kill the troops that just stayed, or turn around and march home). It stays as support.
          if (target.owner === PLAYER) {
            const old = target.stationed[c.fromId] ?? emptyUnits();
            target.stationed = {
              ...target.stationed,
              [c.fromId]: UNIT_IDS.reduce(
                (o, u) => ({
                  ...o,
                  [u]: old[u] + (u === "noble" ? 0 : c.units[u]),
                }),
                {} as Units,
              ),
            };
            villages[target.id] = target;
            say(
              c.id,
              `🛡 A wave from ${villages[c.fromId]?.name ?? c.fromId} arrived at ${target.name} and stays as support`,
            );
            continue;
          }

          // ---- attack ----
          const heroLvl = heroLevel(heroXp);
          const luck = s.luck ? luckOf(c.id) : 0; // the attacker's luck for this march, -25%..+25% (0 when luck is switched off)
          const lk = s.luck ? luckNote(luck) : "";
          const bonus =
            attackBonusFor(c.smithy ?? 0, c.units, heroLvl) * (1 + luck);
          const defBefore = garrison(target);
          const wallBefore = target.buildings.wall;
          const loyaltyBefore = target.loyalty;
          const prevOwner = target.owner;
          const targetName = target.name;
          const fromName = villages[c.fromId]?.name ?? c.fromId;
          const defBonus = defenseBonusFor(target.buildings.smithy);
          const pw = battlePowers(
            c.units,
            defBefore,
            wallBefore,
            bonus,
            defBonus,
          );
          const res = resolveBattle(
            c.units,
            defBefore,
            wallBefore,
            bonus,
            defBonus,
          );
          // fog of war (optional): if your whole army died, you learn nothing about the defenders
          const known =
            !FOG_OF_WAR ||
            res.attackerWins ||
            UNIT_IDS.some((u) => res.attackerLeft[u] > 0);
          // how many of the defenders were reinforcements standing in the village, not its own troops
          const supportBefore = Object.values(target.stationed).reduce(
            (n, u) => n + count(u),
            0,
          );
          const supportNote =
            known && supportBefore > 0
              ? ` | 🛡 ${supportBefore} of the defenders were reinforcements`
              : "";
          target.units = survivorsOf(target.units, defBefore, res.defenderLeft);
          target.stationed = Object.fromEntries(
            Object.entries(target.stationed).map(([k, u]) => [
              k,
              survivorsOf(u, defBefore, res.defenderLeft),
            ]),
          );
          target.buildings.wall = res.wallAfter;
          let siege = "";
          let siegeD: BattleDetail["siege"]; // catapults: only after a won battle
          if (
            res.attackerWins &&
            res.attackerLeft.catapult > 0 &&
            c.catTarget
          ) {
            const key = c.catTarget;
            const before = target.buildings[key];
            const drop = Math.min(
              catapultLevels(res.attackerLeft.catapult),
              before - (MIN_LEVEL[key] ?? 0),
            );
            if (drop > 0) {
              target.buildings[key] = before - drop;
              siege = ` | 🏚 ${BUILDINGS[key].name} ${before}→${before - drop}`;
              siegeD = { building: key, before, after: before - drop };
            }
          }
          const wallAfter = target.buildings.wall;
          const survivors = { ...res.attackerLeft };
          let heroNote = "";
          let heroD: BattleDetail["hero"];
          if (c.units.paladin > 0 && res.attackerWins) {
            // the Paladin survives a won battle (and dies in a defeat)
            survivors.paladin = c.units.paladin;
            heroXp += HERO_XP_WIN;
            const after = heroLevel(heroXp);
            heroNote =
              ` | 🦸 +${HERO_XP_WIN} xp` +
              (after > heroLvl ? ` — Paladin reached level ${after}!` : "");
            heroD = {
              xp: HERO_XP_WIN,
              levelUp: after > heroLvl ? after : undefined,
            };
          } else if (c.units.paladin > 0 && survivors.paladin === 0) {
            heroNote = " | 🦸 the Paladin fell";
            heroD = { xp: 0, fell: true };
          }
          const loot = emptyCost();
          let conquered = false;
          let loyaltyNote = "";
          let carry = 0;
          let loyD: BattleDetail["loyalty"];
          if (res.attackerWins) {
            if (survivors.noble > 0) {
              // only ONE noble works per attack (20..35 loyalty); the others walk home with the army
              const hit = loyaltyHit(c.id);
              survivors.noble -= 1;
              target.loyalty -= hit;
              loyaltyNote = ` | loyalty ${Math.max(0, Math.floor(target.loyalty))} (−${hit})`;
              conquered = target.loyalty < 1; // < 1, not <= 0: loyalty regrows a hair between waves
              loyD = {
                before: loyaltyBefore,
                after: Math.max(0, target.loyalty),
                nobles: 1,
                hit,
              };
            }
            if (!conquered) {
              carry = carryCapacity(survivors);
              for (const r of RES) {
                const t = Math.min(target.resources[r], Math.floor(carry / 3));
                loot[r] = t;
                target.resources[r] -= t;
              }
            }
          }
          if (conquered && c.units.paladin > 0) {
            heroXp += HERO_XP_CONQUEST;
            heroNote += ` | 🦸 +${HERO_XP_CONQUEST} xp`;
            heroD = {
              xp: (heroD?.xp ?? 0) + HERO_XP_CONQUEST,
              levelUp: heroD?.levelUp,
            };
          }
          const detail: BattleDetail = {
            kind: "battle",
            luck: s.luck ? luck : undefined,
            perspective: "attack",
            outcome: conquered
              ? "conquered"
              : res.attackerWins
                ? "win"
                : "loss",
            attacker: {
              village: fromName,
              xy: c.fromXY,
              sent: { ...c.units },
              left: survivors,
              bonus,
              heroLevel: heroLvl,
            },
            defender: {
              village: targetName,
              xy: c.toXY,
              known,
              before: known ? defBefore : undefined,
              left: known ? res.defenderLeft : undefined,
              bonus: known ? defBonus : undefined,
            },
            powers: {
              attack: pw.a,
              defense: known ? pw.d : undefined,
              effWall: pw.effWall,
              shares: pw.shares,
              rating: known ? pw.rating : undefined,
            },
            wall: {
              before: known ? wallBefore : undefined,
              after: known ? wallAfter : undefined,
              rams: c.units.ram,
            },
            loot,
            carry,
            loyalty: loyD,
            siege: siegeD,
            hero: heroD,
          };
          {
            const killed = count(defBefore) - count(res.defenderLeft),
              fell = count(c.units) - count(res.attackerLeft); // the score
            bump(PLAYER, {
              kills: killed,
              lost: fell,
              looted: loot.wood + loot.clay + loot.iron,
            });
            bump(prevOwner, { kills: fell, lost: killed });
          }
          {
            const hit = CLANS.find((k) => k.name === prevOwner);
            if (hit) provoke(hit, conquered ? 5 : res.attackerWins ? 1 : 0.6);
          } // they will remember this
          if (conquered) {
            if (rivalInfo(target.owner)?.nemesis) {
              heroXp += HERO_XP_NEMESIS;
              heroNote += ` | 😈 Nemesis village taken! +${HERO_XP_NEMESIS} xp`;
            }
            Object.assign(target, {
              owner: PLAYER,
              name: `Conquered ${target.id}`,
              loyalty: 25,
              units: emptyUnits(),
              buildQueue: [],
              recruitQueue: [],
              stationed: UNIT_IDS.some((u) => survivors[u] > 0)
                ? { [c.fromId]: survivors }
                : {},
            }); // the army stays as RECALLABLE support
            // The old owner's support that came FROM this village is still standing in its other villages. It must not
            // become yours: those stacks look like yours and "come home" to you as free troops.
            releaseSupportOf(target.id);
            // With one loyalty hit per attack a conquest takes several waves, and the first ones have already turned
            // around. When EARLIER_WAVES_STAY is on, those that left this village a moment ago stay as support instead.
            for (
              let i = commands.length - 1;
              EARLIER_WAVES_STAY && i >= 0;
              i--
            ) {
              const r = commands[i];
              if (
                r.kind !== "return" ||
                r.clan ||
                r.fromId !== target.id ||
                now - r.departAt > GARRISON_WINDOW_MS ||
                !UNIT_IDS.some((u) => u !== "scout" && r.units[u] > 0)
              )
                continue;
              const old = target.stationed[r.toId] ?? emptyUnits();
              target.stationed = {
                ...target.stationed,
                [r.toId]: UNIT_IDS.reduce(
                  (o, u) => ({ ...o, [u]: old[u] + r.units[u] }),
                  {} as Units,
                ),
              };
              RES.forEach((k) => (target.resources[k] += r.loot[k])); // the loot goes back into the village
              commands.splice(i, 1);
            }
            say(
              c.id,
              `👑 Conquered ${target.id}! Your army stays there as support${siege}${heroNote}${lk}`,
              detail,
            );
          } else {
            say(
              c.id,
              `${res.attackerWins ? "⚔️ Victory" : "💀 Defeat"} at ${target.id} — loot ${loot.wood + loot.clay + loot.iron}${loyaltyNote}${siege}${heroNote}${supportNote}${lk}`,
              detail,
            );
            if (c.rally?.length) returnRally(survivors, loot);
            else goHome(survivors, loot);
          }
          villages[target.id] = target;
        }
        const stillYours = villages[s.activeId]?.owner === PLAYER; // if the village you were looking at has fallen, switch to another
        set({
          now,
          villages,
          commands,
          intel,
          rivals: rivalsNext,
          stats: statsNext,
          news: worldNews.length
            ? [...worldNews, ...newsAll].slice(0, 60)
            : newsAll,
          aiAdvice: adviceLeft,
          ...(ralliesChanged ? { rallies } : {}),
          activeId: stillYours
            ? s.activeId
            : (Object.values(villages).find((v) => v.owner === PLAYER)?.id ??
              s.activeId),
          selectedBuilding: stillYours ? s.selectedBuilding : null,
          hero: { xp: heroXp },
          reports: reports.slice(0, 40),
        });
      },
    }),
    {
      name: SAVE_KEY,
      storage: createJSONStorage(() => lazyStorage),
      version: SAVE_VERSION,
      onRehydrateStorage: () => (state) => {
        // restore the saved game speed and the world's clock
        if (!state) return;
        if (state.gameSpeed) setSpeed(state.gameSpeed);
        if (state.worldClock)
          setWorldClock(state.worldClock.age, state.worldClock.at);
      },
      // Timestamps are absolute, so lazy settlement gives offline progress for free.
      partialize: (s) => ({
        villages: s.villages,
        activeId: s.activeId,
        commands: s.commands,
        reports: s.reports,
        intel: s.intel,
        presets: s.presets,
        hero: s.hero,
        rivals: s.rivals,
        rivalMode: s.rivalMode,
        startedAt: s.startedAt,
        gameSpeed: s.gameSpeed,
        luck: s.luck,
        botAggression: s.botAggression,
        stats: s.stats,
        worldClock: s.worldClock,
        news: s.news,
        rallies: s.rallies,
        aiEnabled: s.aiEnabled,
        aiAdvice: s.aiAdvice,
        view: s.view,
        mode: s.mode,
      }),
      // Bump SAVE_VERSION whenever the saved shape changes, and add a step here.
      // Steps only ADD missing fields — the player's existing progress is kept.
      migrate: (persisted: any, version) => {
        let p = persisted;
        const fixVillages = () =>
          Object.fromEntries(
            Object.entries(p.villages ?? {}).map(([k, v]) => [
              k,
              normalizeVillage(v),
            ]),
          );
        const fixCommands = () =>
          (p.commands ?? []).map((c: any) => ({
            ...c,
            units: normalizeUnits(c.units),
            loot: { ...emptyCost(), ...c.loot },
          }));
        // v2 scouts/rams/nobles/academy/loyalty · v3 farm · v4 stable/smithy/archer/mounted/heavy · v6 statue/paladin · v5 rally point (existing villages get one)/workshop/catapult.
        // Every step only ADDS missing fields (normalize*), so existing progress is always kept.
        if (version < 6)
          p = { ...p, villages: fixVillages(), commands: fixCommands() };
        if (version < 10)
          p = {
            ...p,
            villages: Object.fromEntries(
              Object.entries(p.villages ?? {}).map(([k, v]: [string, any]) => [
                k,
                v.owner && v.owner !== PLAYER && !rivalInfo(v.owner)
                  ? { ...v, owner: null }
                  : v,
              ]),
            ),
          }; // villages of the old clans become barbarian again
        if (version < 10)
          p = {
            ...p,
            worldClock: {
              age:
                ((Date.now() - (p.startedAt ?? Date.now())) *
                  (p.gameSpeed ?? 60)) /
                3_600_000,
              at: Date.now(),
            },
          }; // v10: bots follow the world's age (an old save has been aging since it began)
        if (version < 9) p = { ...p, villages: fixVillages() }; // v9: hiding place (rivals + their raids add new save fields that default safely)
        if (version < 8) p = { ...p, villages: fixVillages() }; // v8: support (stationed troops) + market
        if (version < 7)
          p = {
            ...p,
            intel: Object.fromEntries(
              Object.entries(p.intel ?? {}).map(([k, i]: [string, any]) => [
                k,
                { tier: 3, ...i },
              ]),
            ),
          }; // v7: scout tiers
        if (version < 11) {
          // v11: support whose origin village has changed owner since (it was conquered) is dropped, so it can no
          // longer "come home" to the wrong owner
          const vs: Record<string, any> = p.villages ?? {};
          p = {
            ...p,
            villages: Object.fromEntries(
              Object.entries(vs).map(([k, h]: [string, any]) => [
                k,
                {
                  ...h,
                  stationed: Object.fromEntries(
                    Object.entries(h.stationed ?? {}).filter(([o]) => {
                      const org = vs[o];
                      return !org || org.owner === h.owner;
                    }),
                  ),
                },
              ]),
            ),
          };
        }
        if (version < 12) {
          // v12: the built-in presets are ordinary, editable presets; rallies are a list
          p = {
            ...p,
            presets: [...DEFAULT_PRESETS, ...(p.presets ?? [])],
            rallies: Array.isArray(p.rallies) ? p.rallies : [],
          };
        }
        return p;
      },
    },
  ),
);
