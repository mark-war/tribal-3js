import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { BUILDINGS, BUILDING_IDS } from "../game/config/buildings";
import { UNITS, UNIT_IDS } from "../game/config/units";
import {
  RES,
  buildCost,
  buildReqMet,
  buildTimeMs,
  canAfford,
  capacity,
  capacityAt,
  meetsReq,
  prodPerHour,
  recruitTimeMs,
  settle,
  garrison,
  paladinCount,
  popCap,
  popCapAt,
  popBreakdown,
  popFree,
  popUsed,
  hidingProtect,
  worldAgeHours,
  recallWindowMs,
} from "../game/core/economy";
import { PLAYER, nemesisClan, rivalInfo } from "../game/core/world";
import { protectionLeftHours, type RivalMode } from "../game/core/rivals";
import type {
  BuildingId,
  Cost,
  Units,
  UnitId,
  UnitRole,
  Report,
  Village,
  WaveDraft,
} from "../game/core/types";
import {
  ATTACK_CLASSES,
  CLASS_ICON,
  CLASS_NAME,
  HERO_ATTACK_PER_LEVEL,
  HERO_XP_LEVELS,
  wallFlat,
  wallMult,
  attackBonusFor,
  attackShares,
  carryCapacity,
  defenseBonusFor,
  defenseRating,
  heroLevel,
  pips,
  ramsToBreakWall,
  resolveBattle,
  tier,
} from "../game/core/combat";
import { useGame } from "../game/store";
import Help from "./Help";
import Incoming from "./Incoming";
import Market from "./Market";
import NewGame from "./NewGame";
import Ranking from "./Ranking";
import QuickSend from "./QuickSend";
import { kindIcon } from "./icons";
import ReportView from "./ReportView";
import WarTable from "./WarTable";

type Req = { building: BuildingId; level: number };
type TipState = { x: number; y: number; node: ReactNode } | null;
const PRODUCES: Partial<Record<BuildingId, "wood" | "clay" | "iron">> = {
  timber: "wood",
  clay: "clay",
  iron: "iron",
};
const ROLES: [UnitRole, string][] = [
  ["defense", "🛡 Defensive"],
  ["hybrid", "⚖ All-round"],
  ["offense", "⚔ Offensive"],
  ["special", "✦ Special"],
];
const ICON = { wood: "🪵", clay: "🧱", iron: "⛏️" } as const;

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
};
const pct = (finishesAt: number, dur: number) =>
  Math.max(0, Math.min(100, 100 * (1 - (finishesAt - Date.now()) / dur)));

function Reqs({ reqs, v }: { reqs?: Req[]; v: Village }) {
  if (!reqs?.length) return <div className="green">✓ No requirements</div>;
  return (
    <>
      {reqs.map((r) => {
        const ok = v.buildings[r.building] >= r.level;
        return (
          <div key={r.building} className={ok ? "green" : "red"}>
            {ok ? "✓" : "✗"} {BUILDINGS[r.building].name} level {r.level}{" "}
            <small>(you: {v.buildings[r.building]})</small>
          </div>
        );
      })}
    </>
  );
}
function CostLine({ cost, have }: { cost: Cost; have: Cost }) {
  return (
    <span>
      {RES.map((r) => (
        <span
          key={r}
          className={have[r] >= cost[r] ? "" : "red"}
          style={{ marginRight: 8 }}
        >
          {ICON[r]}
          {cost[r]}
        </span>
      ))}
    </span>
  );
}
function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: [T, string][];
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="tabs">
      {tabs.map(([k, l]) => (
        <button
          key={k}
          className={k === value ? "on" : ""}
          onClick={() => onChange(k)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export default function Hud() {
  const {
    mode,
    setMode,
    villages,
    activeId,
    setActive,
    view,
    setView,
    build,
    recruit,
    target,
    commands,
    reports,
    selectedBuilding,
    selectBuilding,
    hero,
    focusOn,
    rivalMode,
    setRivalMode,
    selectTarget,
    renameVillage,
    cancelBuild,
    cancelRecruit,
    recall,
    gameSpeed,
    setGameSpeed,
    cursor,
    picked,
    rivals,
    aiEnabled,
    setAi,
    aiStatus,
  } = useGame();
  useGame((s) => s.now); // re-render on tick
  const [left, setLeft] = useState<"buildings" | "army">("buildings");
  const [right, setRight] = useState<"target" | "reports">("target");
  const [helpOpen, setHelpOpen] = useState(false);
  const [warOpen, setWarOpen] = useState(false);
  const [rankOpen, setRankOpen] = useState(false);
  const [newGameOpen, setNewGameOpen] = useState(false);
  const [gx, setGx] = useState("");
  const [gy, setGy] = useState("");
  const [marketOpen, setMarketOpen] = useState(false);
  const [marketTo, setMarketTo] = useState<string | null>(null);
  const [warSeed, setWarSeed] = useState<WaveDraft | null>(null);
  const [openReport, setOpenReport] = useState<Report | null>(null);
  const [amt, setAmt] = useState<Partial<Record<UnitId, number>>>({});
  const [tip, setTip] = useState<TipState>(null);
  const [seenId, setSeenId] = useState<string | null>(reports[0]?.id ?? null);
  const [toast, setToast] = useState<string | null>(null);
  const lastToast = useRef(reports[0]?.id);
  const [helpSeed, setHelpSeed] = useState<{
    attacker?: Partial<Units>;
    defender?: Partial<Units>;
    wall?: number;
    defSmithy?: number;
  } | null>(null);

  useEffect(() => {
    if (right === "reports") setSeenId(reports[0]?.id ?? null);
  }, [right, reports]);
  useEffect(() => {
    const r = reports[0];
    if (!r || r.id === lastToast.current) return;
    lastToast.current = r.id;
    setToast(r.text);
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [reports]);

  const v = settle(villages[activeId], Date.now());
  const cap = capacity(v);
  const pcap = popCap(v);
  const pb = popBreakdown(v, commands, villages);
  const mineCmds = commands.filter((c) => c.kind !== "raid" && !c.clan);
  const protLeft = protectionLeftHours(
    worldAgeHours(),
    Object.values(villages)
      .filter((x) => x.owner === PLAYER)
      .reduce((n, x) => n + x.points, 0),
  );
  const used = popUsed(v, commands, villages);
  const free = popFree(v, commands, villages);
  const mine = Object.values(villages).filter((x) => x.owner === PLAYER);
  const t = target ? (villages[target.id] ?? target) : null;
  const idx = reports.findIndex((r) => r.id === seenId);
  const unread = seenId == null || idx < 0 ? reports.length : idx;

  // ---- strategy helpers: own weak spot, attack mix, and a prediction from the last scout report ----
  const paladinExists = paladinCount(villages, commands) > 0;
  const hl = heroLevel(hero.xp);
  const rating = defenseRating(
    garrison(v),
    v.buildings.wall,
    defenseBonusFor(v.buildings.smithy),
  ); // own troops + support standing here
  const weakest = ATTACK_CLASSES.reduce((a, b) =>
    rating[a] <= rating[b] ? a : b,
  );

  // Fixed-position tooltip: works inside scrolling panels (absolute tooltips would be clipped).
  const showTip = (node: ReactNode) => ({
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      const x = r.left > window.innerWidth / 2 ? r.left - 258 : r.right + 8;
      setTip({ x, y: Math.min(r.top, window.innerHeight - 220), node });
    },
    onMouseLeave: () => setTip(null),
  });

  const nextLevel = (id: BuildingId) =>
    v.buildings[id] + v.buildQueue.filter((j) => j.building === id).length + 1;
  const buildTip = (id: BuildingId) => {
    const d = BUILDINGS[id];
    const lvl = nextLevel(id);
    const c = buildCost(id, lvl);
    return (
      <>
        <b>{d.name}</b>
        <div style={{ opacity: 0.8, margin: "2px 0 6px" }}>{d.desc}</div>
        <b>Requirements</b>
        <Reqs reqs={d.requires} v={v} />
        {d.requires && v.buildings[id] > 0 && (
          <small style={{ opacity: 0.7 }}>
            Already built — upgrades aren't blocked.
          </small>
        )}
        {lvl <= d.maxLevel && (
          <>
            <div style={{ marginTop: 6 }}>
              <b>Level {lvl}</b>
            </div>
            <CostLine cost={c} have={v.resources} />
            <div>⏱ {fmt(buildTimeMs(id, lvl, v.buildings.main))}</div>
            {id === "farm" && (
              <div>
                👥 cap {popCapAt(lvl - 1)} → {popCapAt(lvl)}
              </div>
            )}
            {id === "smithy" && (
              <div>
                ⚔ attack bonus +{2 * (lvl - 1)}% → +{2 * lvl}%
              </div>
            )}
          </>
        )}
      </>
    );
  };
  const unitTip = (u: UnitId) => {
    const d = UNITS[u];
    return (
      <>
        <b>{d.name}</b>
        <div>
          {CLASS_ICON[d.klass]} attacks as <b>{CLASS_NAME[d.klass]}</b> · 🎒
          carries {d.carry} · 🚶 {d.minutesPerField} min/field
        </div>
        <div>
          ⚔ Attack {d.attack}{" "}
          <span className="pips">{pips(tier(d.attack))}</span>
        </div>
        {ATTACK_CLASSES.map((k) => (
          <div key={k}>
            🛡 vs {CLASS_ICON[k]} {CLASS_NAME[k]} {d.defense[k]}{" "}
            <span className="pips">{pips(tier(d.defense[k]))}</span>
          </div>
        ))}
        <div>👥 {d.pop} population</div>
        <div style={{ marginTop: 6 }}>
          <b>Requirements</b>
        </div>
        <Reqs reqs={d.requires} v={v} />
        <div style={{ marginTop: 6 }}>
          Each: <CostLine cost={d.cost} have={v.resources} />
        </div>
        <div>
          ⏱ {fmt(recruitTimeMs(u, v.buildings[UNITS[u].trainedAt]))} each
        </div>
        {u === "noble" && (
          <small style={{ opacity: 0.8 }}>
            Each survivor of a won attack lowers loyalty by 25.
          </small>
        )}
      </>
    );
  };
  const maxAfford = (u: UnitId) => {
    const m = Math.min(
      ...RES.map((r) => Math.floor(v.resources[r] / UNITS[u].cost[r])),
      Math.floor(free / UNITS[u].pop),
    );
    return u === "paladin" ? Math.min(m, paladinExists ? 0 : 1) : m; // only one hero, ever
  };

  const sb = selectedBuilding;
  const sbPending = sb
    ? v.buildQueue.filter((j) => j.building === sb).length
    : 0;

  return (
    <div className="hud">
      <div className="panel top">
        <select value={activeId} onChange={(e) => setActive(e.target.value)}>
          {mine.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} ({x.x}|{x.y})
            </option>
          ))}
        </select>
        <button
          title="Rename this village"
          onClick={() => {
            const n = window.prompt("Name for this village", v.name);
            if (n && n.trim()) renameVillage(activeId, n);
          }}
        >
          ✏️
        </button>
        {RES.map((r) => (
          <span
            key={r}
            title={`+${Math.round(prodPerHour(v.buildings[r === "wood" ? "timber" : r]))}/h`}
          >
            {ICON[r]} {Math.floor(v.resources[r])}
          </span>
        ))}
        <span>/ {cap}</span>
        <span
          className={used >= pcap * 0.95 ? "red" : ""}
          title="Population: units at home, in training and away"
        >
          👥 {used}/{pcap}
        </span>
        {v.loyalty < 100 && <span>👑 loyalty {Math.floor(v.loyalty)}</span>}
        <span style={{ flex: 1 }} />
        <select
          title="Game speed: real time is 1×"
          value={gameSpeed}
          onChange={(e) => setGameSpeed(Number(e.target.value))}
        >
          <option value={1}>⏱ Real time</option>
          <option value={10}>⏱ ×10</option>
          <option value={60}>⏱ ×60</option>
          <option value={600}>⏱ ×600</option>
        </select>
        <select
          title="How hostile the rival clans are"
          value={rivalMode}
          onChange={(e) => setRivalMode(e.target.value as RivalMode)}
        >
          <option value="off">🚫 Rivals off</option>
          <option value="peace">😴 Peaceful</option>
          <option value="retaliate">🛡 Hit back only</option>
          <option value="raids">⚔ Raids</option>
          <option value="war">👑 War (like players)</option>
        </select>
        <button
          title={`AI advisor for the bots (Groq): ${aiStatus}. Needs GROQ_API_KEY in .env.local; the bots work without it.`}
          onClick={() => setAi(!aiEnabled)}
        >
          🧠 {aiEnabled ? "AI on" : "AI off"}
        </button>
        {protLeft > 0 && (
          <span title="Beginner protection: bots can't attack you and you can't attack them (barbarians are fine). It ends after 24 game hours or at 800 points.">
            🛡 Protected {Math.ceil(protLeft)}h
          </span>
        )}
        {view === "world" && cursor && (
          <span title="Tile under the mouse">
            🧭 {cursor.x}|{cursor.y}
          </span>
        )}
        {picked && (
          <span title="Last tile you clicked">
            📍 {picked.x}|{picked.y}
          </span>
        )}
        <span title="Jump to a tile">
          <input
            type="number"
            placeholder="x"
            style={{ width: 52 }}
            value={gx}
            onChange={(e) => setGx(e.target.value)}
          />
          |
          <input
            type="number"
            placeholder="y"
            style={{ width: 52 }}
            value={gy}
            onChange={(e) => setGy(e.target.value)}
          />{" "}
          <button
            onClick={() =>
              gx !== "" && gy !== "" && focusOn(Number(gx), Number(gy))
            }
          >
            Go
          </button>
        </span>
        {rivalMode !== "off" && (
          <span title="Barbarian villages the bots have conquered with noble runs">
            🏰 +
            {Object.entries(rivals).reduce(
              (t, [k, r]) => t + (k === "_world" ? 0 : (r.held ?? 0)),
              0,
            )}
          </span>
        )}
        <button onClick={() => setRankOpen(true)}>🏆 Ranking</button>
        <button
          onClick={() => {
            setMarketTo(null);
            setMarketOpen(true);
          }}
        >
          🏪 Market
        </button>
        <button
          onClick={() => {
            setWarSeed(null);
            setWarOpen(true);
          }}
        >
          ⚔ War Table
        </button>
        <button onClick={() => setHelpOpen(true)}>? Help</button>
        <button
          title="Erase this game and start again"
          onClick={() => setNewGameOpen(true)}
        >
          🆕 New game
        </button>
        <button onClick={() => setMode(mode === "3d" ? "2d" : "3d")}>
          {mode === "3d" ? "Switch to 2D" : "Switch to 3D"}
        </button>
        <button
          onClick={() => setView(view === "village" ? "world" : "village")}
        >
          {view === "village" ? "World map" : "Village"}
        </button>
      </div>

      {toast && (
        <div
          className="toast"
          onClick={() => {
            setOpenReport(reports[0] ?? null);
            setToast(null);
          }}
          title="Click for the full report"
        >
          📜 {toast}
        </div>
      )}

      <div className="panel side">
        <Tabs
          tabs={[
            ["buildings", "Buildings"],
            ["army", "Army"],
          ]}
          value={left}
          onChange={setLeft}
        />

        {left === "buildings" && (
          <>
            {BUILDING_IDS.map((id) => {
              const d = BUILDINGS[id];
              const lvl = nextLevel(id) - 1;
              const maxed = lvl >= d.maxLevel;
              const reqOk = buildReqMet(v, id);
              const c = buildCost(id, lvl + 1);
              const pend = lvl - v.buildings[id];
              return (
                <div
                  className={
                    "row item" + (selectedBuilding === id ? " sel" : "")
                  }
                  key={id}
                >
                  <span
                    className="grow"
                    style={{ cursor: "pointer" }}
                    onClick={() => selectBuilding(id)}
                  >
                    {d.name} <b>Lv{v.buildings[id]}</b>
                    <small>/{d.maxLevel}</small>
                    {pend > 0 && <small> (+{pend})</small>}
                  </span>
                  <span
                    className={"ico" + (reqOk ? "" : " bad")}
                    {...showTip(buildTip(id))}
                  >
                    ⓘ
                  </span>
                  {maxed ? (
                    <small>max</small>
                  ) : !reqOk ? (
                    <button disabled>🔒</button>
                  ) : (
                    <button
                      disabled={
                        !canAfford(v.resources, c) || v.buildQueue.length >= 3
                      }
                      onClick={() => build(id)}
                    >
                      ↑ {lvl + 1}
                    </button>
                  )}
                </div>
              );
            })}
            {v.buildQueue.length > 0 && (
              <>
                <hr />
                <b>Construction ({v.buildQueue.length}/3)</b>
              </>
            )}
            {v.buildQueue.map((j, i) => (
              <div key={i}>
                <div className="row">
                  <span>
                    {BUILDINGS[j.building].name} → {j.level}{" "}
                    <small>({fmt(j.finishesAt - Date.now())})</small>
                  </span>
                  <button
                    title="Cancel this construction (90% of the cost comes back; later upgrades of it are cancelled too)"
                    onClick={() => cancelBuild(i)}
                  >
                    ✕
                  </button>
                </div>
                <div className="bar">
                  <i
                    style={{
                      width: `${pct(j.finishesAt, buildTimeMs(j.building, j.level, v.buildings.main))}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </>
        )}

        {left === "army" && (
          <>
            <div className={"row" + (free <= 0 ? " red" : "")}>
              <small>
                Population {used}/{pcap} — upgrade the Farm to raise it.
                <br />
                At home {pb.home} · training {pb.training} · marching{" "}
                {pb.marching} · stationed in other villages {pb.stationedOut}
                {pb.hostedHere > 0 && (
                  <>
                    {" "}
                    · support hosted here {pb.hostedHere} (uses its own farm,
                    not this one)
                  </>
                )}
              </small>
            </div>
            <div className="ex" style={{ margin: "4px 0" }}>
              <small>🛡 Your defense if attacked by:</small>
              {ATTACK_CLASSES.map((k) => (
                <div key={k} className={"row" + (k === weakest ? " red" : "")}>
                  <span>
                    {CLASS_ICON[k]} {CLASS_NAME[k]}
                  </span>
                  <b>{Math.round(rating[k])}</b>
                </div>
              ))}
              <small>
                Weakest: {CLASS_NAME[weakest]}. Train units that defend well
                against it.
              </small>
              <div>
                <small>
                  {v.buildings.wall > 0
                    ? `🧱 Wall ${v.buildings.wall}: your defenders ×${wallMult(v.buildings.wall).toFixed(2)} (+${Math.round((wallMult(v.buildings.wall) - 1) * 100)}%), and the wall itself fights with ${Math.round(wallFlat(v.buildings.wall) * wallMult(v.buildings.wall))} even if nobody is home`
                    : "🧱 No wall — raise one to protect an empty village."}
                </small>
              </div>
              {paladinExists && (
                <div>
                  <small>
                    🦸 Paladin level {hl}: +
                    {Math.round(hl * HERO_ATTACK_PER_LEVEL * 100)}% attack to
                    armies he leads · XP {hero.xp}
                    {HERO_XP_LEVELS[hl] ? `/${HERO_XP_LEVELS[hl]}` : " (max)"}
                  </small>
                </div>
              )}
            </div>
            {ROLES.map(([role, label]) => (
              <div key={role}>
                <div className="grp">{label}</div>
                {UNIT_IDS.filter((u) => UNITS[u].role === role).map((u) => {
                  const ok = meetsReq(v, u);
                  const n =
                    amt[u] ?? (u === "noble" || u === "paladin" ? 1 : 5);
                  const mx = maxAfford(u);
                  return (
                    <div className="row item" key={u}>
                      <span className="grow">
                        {UNITS[u].name} <b>{v.units[u]}</b>
                      </span>
                      <span
                        className={"ico" + (ok ? "" : " bad")}
                        {...showTip(unitTip(u))}
                      >
                        ⓘ
                      </span>
                      {ok ? (
                        <>
                          <input
                            type="number"
                            min={1}
                            style={{ width: 46 }}
                            value={n}
                            onChange={(e) =>
                              setAmt({ ...amt, [u]: Number(e.target.value) })
                            }
                          />
                          <button
                            title="Set to the most you can afford"
                            onClick={() =>
                              setAmt({ ...amt, [u]: Math.max(1, mx) })
                            }
                          >
                            max
                          </button>
                          <button
                            disabled={n < 1 || n > mx}
                            onClick={() => recruit(u, Math.floor(n))}
                          >
                            +
                          </button>
                        </>
                      ) : (
                        <button disabled>🔒</button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {v.recruitQueue.length > 0 && (
              <>
                <hr />
                <b>Training</b>
              </>
            )}
            {v.recruitQueue.map((j, i) => (
              <div key={i}>
                <div className="row">
                  <span>
                    {j.count}× {UNITS[j.unit].name}{" "}
                    <small>({fmt(j.finishesAt - Date.now())})</small>
                  </span>
                  <button
                    title="Cancel this training order (90% of the cost comes back)"
                    onClick={() => cancelRecruit(i)}
                  >
                    ✕
                  </button>
                </div>
                <div className="bar">
                  <i
                    style={{
                      width: `${pct(j.finishesAt, recruitTimeMs(j.unit, v.buildings[UNITS[j.unit].trainedAt]) * j.count)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="panel right">
        <Tabs
          tabs={[
            ["target", "Target"],
            ["reports", unread ? `Reports (${unread})` : "Reports"],
          ]}
          value={right}
          onChange={setRight}
        />

        {right === "target" && (
          <>
            {t ? (
              <>
                <div>
                  <b>{t.name}</b> ({t.x}|{t.y}) — {t.points} pts
                </div>
                {(() => {
                  const r = rivalInfo(t.owner);
                  return r ? (
                    <div>
                      <span className="badge" style={{ background: r.color }}>
                        {r.name}
                      </span>
                      {r.nemesis && (
                        <span className="warn">
                          {" "}
                          😈 your nemesis: stronger, richer, worth taking
                        </span>
                      )}
                    </div>
                  ) : null;
                })()}
                <small>
                  {t.owner === PLAYER
                    ? "Your village"
                    : "Send scouts to see defenses"}
                </small>
                {v.buildings.rally < 1 && (
                  <div className="red">
                    <small>Build a Rally Point to send troops.</small>
                  </div>
                )}
                {t.owner === PLAYER && t.id !== activeId && (
                  <>
                    <button
                      style={{ marginTop: 6, width: "100%" }}
                      onClick={() => setActive(t.id)}
                    >
                      Switch to this village
                    </button>
                    <button
                      style={{ marginTop: 4, width: "100%" }}
                      onClick={() => {
                        setMarketTo(t.id);
                        setMarketOpen(true);
                      }}
                    >
                      🏪 Send resources
                    </button>
                  </>
                )}
                <QuickSend
                  key={t.id}
                  v={v}
                  t={t}
                  onWar={(seed) => {
                    setWarSeed(seed);
                    setWarOpen(true);
                  }}
                />
              </>
            ) : (
              <div>Click a village on the world map</div>
            )}
            <hr />
            <b>Marching ({mineCmds.length})</b>
            {mineCmds.map((c) => (
              <div key={c.id}>
                <div className="row">
                  <span>
                    {kindIcon(c.kind)} {c.toId}
                    <small>
                      {" "}
                      ·{" "}
                      {Date.now() < c.departAt
                        ? `leaves in ${fmt(c.departAt - Date.now())}`
                        : fmt(c.arriveAt - Date.now())}
                    </small>
                  </span>
                  {c.kind !== "return" &&
                    c.kind !== "trade" &&
                    Date.now() < c.arriveAt &&
                    Date.now() - c.departAt <= recallWindowMs() && (
                      <button
                        title="Cancel: the troops turn around where they are (possible during the first 10 game minutes)"
                        onClick={() => recall(c.id)}
                      >
                        ↩ Cancel
                      </button>
                    )}
                </div>
                <div className="bar">
                  <i
                    style={{
                      width: `${pct(c.arriveAt, c.arriveAt - c.departAt)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </>
        )}

        {right === "reports" &&
          (reports.length ? (
            reports.map((r) => {
              const d = r.detail;
              const tone =
                d?.kind === "battle"
                  ? (
                      d.perspective === "defense"
                        ? d.outcome !== "loss"
                        : d.outcome === "loss"
                    )
                    ? "loss"
                    : "win"
                  : d?.kind === "scout"
                    ? d.success
                      ? "info"
                      : "loss"
                    : "";
              return (
                <div
                  key={r.id}
                  className={"report " + tone}
                  onClick={() => setOpenReport(r)}
                  title="Click for the full report"
                >
                  <div style={{ wordBreak: "break-word" }}>{r.text}</div>
                  <small>
                    {fmt(Date.now() - r.at)} ago{d ? " · 🔎 details" : ""}
                  </small>
                </div>
              );
            })
          ) : (
            <div>No reports yet.</div>
          ))}
      </div>

      {view === "village" && sb && (
        <div className="panel card">
          <div className="row">
            <b>
              {BUILDINGS[sb].name} — level {v.buildings[sb]}
              <small> / {BUILDINGS[sb].maxLevel}</small>
              {sbPending > 0 && ` (+${sbPending} queued)`}
            </b>
            <button onClick={() => selectBuilding(null)}>✕</button>
          </div>
          <div style={{ opacity: 0.85, marginBottom: 6 }}>
            {BUILDINGS[sb].desc}
          </div>
          {PRODUCES[sb] && (
            <div>
              {ICON[PRODUCES[sb]!]} {Math.round(prodPerHour(v.buildings[sb]))}/h
              → {Math.round(prodPerHour(nextLevel(sb)))}/h
            </div>
          )}
          {sb === "farm" && (
            <div>
              👥 Population cap {popCapAt(v.buildings.farm)} →{" "}
              {popCapAt(nextLevel(sb))} (using {used})
            </div>
          )}
          {sb === "smithy" && (
            <div>
              ⚔ Attack bonus +{2 * v.buildings.smithy}% → +{2 * nextLevel(sb)}%
            </div>
          )}
          {sb === "hiding" && (
            <div>
              🕳 Raiders can't touch {hidingProtect(v.buildings.hiding)} of each
              resource → {hidingProtect(nextLevel(sb))}
            </div>
          )}
          {sb === "warehouse" && (
            <div>
              Capacity {capacityAt(v.buildings.warehouse)} →{" "}
              {capacityAt(nextLevel(sb))}
            </div>
          )}
          <div style={{ marginTop: 6 }}>
            <b>Requirements</b>
          </div>
          <Reqs reqs={BUILDINGS[sb].requires} v={v} />
          {nextLevel(sb) <= BUILDINGS[sb].maxLevel ? (
            <>
              <div style={{ marginTop: 6 }}>
                Level {nextLevel(sb)}:{" "}
                <CostLine
                  cost={buildCost(sb, nextLevel(sb))}
                  have={v.resources}
                />{" "}
                ⏱ {fmt(buildTimeMs(sb, nextLevel(sb), v.buildings.main))}
              </div>
              <button
                style={{ marginTop: 6, width: "100%" }}
                onClick={() => build(sb)}
                disabled={
                  !buildReqMet(v, sb) ||
                  !canAfford(v.resources, buildCost(sb, nextLevel(sb))) ||
                  v.buildQueue.length >= 3
                }
              >
                {buildReqMet(v, sb)
                  ? `Upgrade to level ${nextLevel(sb)}`
                  : "🔒 Requirements not met"}
              </button>
            </>
          ) : (
            <div style={{ marginTop: 6 }}>Max level reached.</div>
          )}
        </div>
      )}

      <Incoming
        onShow={(x, y) => focusOn(x, y)}
        onSupport={(helperId, targetId, seed) => {
          setActive(helperId);
          if (villages[targetId]) selectTarget(villages[targetId]);
          setWarSeed(seed);
          setWarOpen(true);
        }}
      />
      {openReport && (
        <ReportView
          report={openReport}
          onClose={() => setOpenReport(null)}
          onGoto={(x, y) => {
            focusOn(x, y);
            setOpenReport(null);
          }}
          onLoadSim={(seed) => {
            setHelpSeed(seed);
            setOpenReport(null); // close the report
            setHelpOpen(true); // open Help → Simulator
          }}
        />
      )}
      {newGameOpen && <NewGame onClose={() => setNewGameOpen(false)} />}
      {rankOpen && (
        <Ranking
          onClose={() => setRankOpen(false)}
          onGoto={(x, y) => {
            focusOn(x, y);
            setRankOpen(false);
          }}
        />
      )}
      {marketOpen && (
        <Market to={marketTo} onClose={() => setMarketOpen(false)} />
      )}
      {warOpen && <WarTable seed={warSeed} onClose={() => setWarOpen(false)} />}
      {helpOpen && (
        <Help
          onClose={() => {
            setHelpOpen(false);
            setHelpSeed(null);
          }}
          seed={helpSeed ?? undefined}
        />
      )}

      {tip && (
        <div className="tip" style={{ left: tip.x, top: tip.y }}>
          {tip.node}
        </div>
      )}
    </div>
  );
}
