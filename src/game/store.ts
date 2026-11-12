import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { BUILDINGS } from "./config/buildings";
import { UNIT_IDS, UNITS } from "./config/units";
import {
  ATTACK_CLASSES,
  CLASS_ICON,
  SCOUT_TIER_NAME,
  HERO_XP_CONQUEST,
  HERO_XP_WIN,
  NOBLE_LOYALTY_HIT,
  loyaltyHit,
  luckFor,
  HERO_XP_NEMESIS,
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
import {
  landScout,
  landStrike,
  mergeIntel,
  type Advice,
} from "./core/botbrain";
import {
  PROTECT_POINTS,
  protectionLeftHours,
  raidIntervalMs,
  retaliateDelayMs,
  stepRivals,
  type RivalMode,
  type RivalState,
} from "./core/rivals";
import { DEFAULT_PRESETS } from "./presets";
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
 * localStorage, but writing at most every 1.5 s. With 100 bots the save is big and the game changes it several times a second,
 * so saving on every change would waste time; the last state is also written when the page closes.
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
const SAVE_VERSION = 11;
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
  luck: boolean;
  setLuck: (on: boolean) => void; // luck on: every attack counts for 75%..125% of its strength
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
  /** Cancel the n-th construction in the active village (and later upgrades of that building); 90% comes back. */
  cancelBuild: (index: number) => void;
  /** Cancel the n-th training order in the active village; 90% comes back. */
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

export const useGame = create<GameState>()(
  persist(
    (set, get) => ({
      now: Date.now(),
      villages: { home: HOME },
      activeId: "home",
      target: null,
      commands: [],
      reports: [],
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
        set({ ...fresh, mode: s.mode, presets: s.presets }); // the new game is saved from this moment on
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
        const nv = tryBuild(s.villages[s.activeId], b, Date.now());
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
          (j, i) => i === index || (i > index && j.building === job.building),
        ); // later upgrades of the same building depend on this one
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

      recall: (id) => {
        const s = get();
        const now = Date.now();
        const c = s.commands.find((x) => x.id === id);
        if (
          !c ||
          c.kind === "return" ||
          c.kind === "trade" ||
          c.kind === "raid" ||
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
        if (!host || !origin || !stack || UNIT_IDS.every((u) => stack[u] <= 0))
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
        });
        const newsAll = rv.news.length
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
        const live = s.commands.filter(
          (c) =>
            !(
              c.kind === "raid" &&
              (s.villages[c.fromId]?.owner === PLAYER || c.fromId === c.toId)
            ) &&
            !(
              c.clan &&
              c.kind === "return" &&
              s.villages[c.toId]?.owner === PLAYER
            ) &&
            !(c.kind === "expand" && s.villages[c.fromId]?.owner === PLAYER),
        ); // raiders whose village you took never get home   // drop raids launched by a village that is yours
        const everything = rv.raids.length ? [...live, ...rv.raids] : live;
        const due = everything.filter((c) => c.arriveAt <= now);
        if (!due.length) {
          return set({
            now,
            rivals: rv.rivals,
            ...(Object.keys(rv.villages).length
              ? { villages: { ...s.villages, ...rv.villages } }
              : {}),
            ...(everything !== s.commands ? { commands: everything } : {}),
            ...(rv.news.length ? { news: newsAll } : {}),
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
        const villages = { ...s.villages, ...rv.villages };
        const commands = everything.filter((c) => c.arriveAt > now);
        const reports = [...s.reports];
        const intel = { ...s.intel };
        const rivalsNext = { ...rv.rivals };
        const statsNext = { ...applyBumps(s.stats) };
        const luckOf = (c: Command) => (s.luck ? luckFor(c.id) : 1); // luck: each attack counts for 75%..125%, fixed by its id
        const extraNews: { at: number; text: string }[] = []; // news made by marches that land this tick
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
        const say = (id: string, text: string, detail?: ReportDetail) =>
          reports.unshift({ id, at: now, text, detail });
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
            ),
          }; // it takes its next turn soon
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

          if (c.kind === "return") {
            if (
              c.clan &&
              (!villages[c.toId] || villages[c.toId].owner === PLAYER)
            )
              continue; // rival troops with nowhere to return to
            const home = settle(normalizeVillage(villages[c.toId]), now);
            UNIT_IDS.forEach((u) => (home.units[u] += c.units[u]));
            RES.forEach((r) => (home.resources[r] += c.loot[r]));
            villages[c.toId] = home;
            continue;
          }

          if (c.kind === "support") {
            // troops move in as a recallable garrison
            const host = settle(normalizeVillage(villages[c.toId]), now);
            if (c.clan ? host.owner !== c.clan : host.owner !== PLAYER) {
              goHome(c.units);
              continue;
            } // the village changed hands: they turn back
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
            // deliver, then the merchants walk home
            const dest = settle(normalizeVillage(villages[c.toId]), now);
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

          if (c.kind === "scout" && c.clan) {
            // a bot's scouts arrive (on a barbarian village, another bot, or YOU)
            const bot = CLANS.find((k) => k.name === c.clan);
            if (!bot) continue;
            const r = landScout(
              c,
              villages,
              now,
              bot,
              rivalsNext[bot.id]?.intel?.[c.toId],
            );
            Object.assign(villages, r.changed);
            for (const x of r.commands) commands.push(x);
            for (const [bid, tid, info] of r.intel) {
              const st = rivalsNext[bid] ?? {
                grudge: 0,
                nextRaidAt: now + raidIntervalMs(),
                raids: 0,
                updatedAt: now,
              };
              rivalsNext[bid] = {
                ...st,
                intel: mergeIntel(st.intel, tid, info, now),
              };
            }
            const n = r.scoutNote;
            if (n && villages[n.toId]?.owner === PLAYER) {
              // you notice scouts on YOUR village
              const village = villages[n.toId].name;
              say(
                c.id,
                r.commands.length
                  ? `🔍 ${n.botName}'s scouts looked over ${village}${n.killed ? ` (your scouts killed ${n.killed} of them)` : ""}`
                  : `🛡 Your scouts at ${village} caught all ${n.sent} of ${n.botName}'s scouts`,
              );
            }
            continue;
          }

          if (c.kind === "strike") {
            // a bot's army lands on a barbarian village or another bot
            const bot = CLANS.find((k) => k.name === c.clan);
            if (!bot) continue;
            const r = landStrike(c, villages, now, bot, s.luck);
            Object.assign(villages, r.changed);
            for (const x of r.commands) commands.push(x);
            for (const t of r.news) extraNews.push({ at: now, text: t });
            for (const [k, d] of r.bumps) bump(k, d);
            for (const [bid, tid, info] of r.intel) {
              const st = rivalsNext[bid] ?? {
                grudge: 0,
                nextRaidAt: now + raidIntervalMs(),
                raids: 0,
                updatedAt: now,
              };
              rivalsNext[bid] = {
                ...st,
                intel: mergeIntel(st.intel, tid, info, now),
              };
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

          if (c.kind === "expand") {
            // a bot's noble run on one of YOUR villages
            const bot = CLANS.find((k) => k.name === c.clan);
            const tv = villages[c.toId];
            if (!bot || !tv || tv.owner !== PLAYER) continue;
            const tgt = settle(normalizeVillage(tv), c.arriveAt);
            const defBefore = garrison(tgt);
            const wallBefore = tgt.buildings.wall;
            const loyaltyBefore = tgt.loyalty;
            const bonus = attackBonusFor(c.smithy ?? 0, c.units, 0) * luckOf(c);
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
              // only ONE noble works per attack
              hit = loyaltyHit(c.id);
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
            const detail: BattleDetail = {
              kind: "battle",
              luck: luckOf(c),
              perspective: "defense",
              outcome: conquered
                ? "conquered"
                : res.attackerWins
                  ? "win"
                  : "loss",
              attacker: {
                village: `${bot.name} (noble run)`,
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
              for (const v of Object.values(villages))
                if (v.stationed?.[tgt.id]) {
                  const rest = { ...v.stationed };
                  delete rest[tgt.id];
                  villages[v.id] = { ...v, stationed: rest };
                } // troops you had out from it are gone
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
                  : `🛡 ${tgt.name} held against ${bot.name}'s noble run`,
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
            const bonus = attackBonusFor(c.smithy ?? 0, c.units, 0) * luckOf(c);
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
              luck: luckOf(c),
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
                UNIT_IDS.filter((u) => target.units[u] > 0)
                  .map((u) => `${name(u)} ${target.units[u]}`)
                  .join(", ") || "none";
              detail.wall = target.buildings.wall;
              detail.units = { ...target.units };
              detail.rating = defenseRating(
                target.units,
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
                    units: { ...target.units },
                    wall: target.buildings.wall,
                    smithy: target.buildings.smithy,
                  }
                : {}),
              ...(r.tier >= 3 ? { buildings: { ...target.buildings } } : {}),
            };
            goHome({ ...emptyUnits(), scout: r.left });
            continue;
          }

          // ---- attack ----
          const heroLvl = heroLevel(heroXp);
          const bonus =
            attackBonusFor(c.smithy ?? 0, c.units, heroLvl) * luckOf(c);
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
          // fog of war: if your whole army died, you learn nothing about the defenders
          const known =
            res.attackerWins || UNIT_IDS.some((u) => res.attackerLeft[u] > 0);
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
              // only ONE noble works per attack; the others walk home with the army
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
            luck: luckOf(c),
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
            say(
              c.id,
              `👑 Conquered ${target.id}! Your army stays there as support${siege}${heroNote}`,
              detail,
            );
          } else {
            say(
              c.id,
              `${res.attackerWins ? "⚔️ Victory" : "💀 Defeat"} at ${target.id} — loot ${loot.wood + loot.clay + loot.iron}${loyaltyNote}${siege}${heroNote}`,
              detail,
            );
            goHome(survivors, loot);
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
          news: extraNews.length
            ? [...extraNews, ...newsAll].slice(0, 60)
            : newsAll,
          aiAdvice: adviceLeft,
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
        stats: s.stats,
        worldClock: s.worldClock,
        news: s.news,
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
        if (version < 11)
          p = { ...p, presets: [...DEFAULT_PRESETS, ...(p.presets ?? [])] }; // v11: the built-in presets are ordinary, editable presets now
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
        return p;
      },
    },
  ),
);
