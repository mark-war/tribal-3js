import { useState } from "react";
import { BUILDINGS, BUILDING_IDS } from "../game/config/buildings";
import { UNITS, UNIT_IDS } from "../game/config/units";
import {
  ATTACK_CLASSES,
  CLASS_ICON,
  attackShares,
  carryCapacity,
  defenseBonusFor,
  defenseRating,
  heroLevel,
  noblesNeeded,
  resolveScout,
  SCOUT_TIER_NAME,
  simulateWaves,
} from "../game/core/combat";
import {
  garrison,
  recallWindowMs,
  settle,
  travelMs,
} from "../game/core/economy";
import { PLAYER, rivalInfo, villageAt } from "../game/core/world";
import type { BuildingId, Units, UnitId, WaveDraft } from "../game/core/types";
import { useGame } from "../game/store";
import { clock, dur } from "./fmt";
import { kindIcon } from "./icons";

type Wave = WaveDraft & { id: string };
const uid = () => Math.random().toString(36).slice(2, 8);
const int = (x: unknown) => Math.max(0, Math.floor(Number(x) || 0));
const mk = (
  units: Partial<Units> = {},
  kind: Wave["kind"] = "attack",
  offset = 0,
  cat: BuildingId = "wall",
): Wave => ({ id: uid(), kind, units, offset, cat });
const parseTime = (s: string, now: number) => {
  if (!s) return NaN;
  const [h, m, sec] = s.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, sec || 0, 0);
  const t = d.getTime();
  return t < now - 1000 ? t + 86_400_000 : t;
};
const OFFENSE = UNIT_IDS.filter((u) => UNITS[u].role === "offense");
const total = (u: Units) => UNIT_IDS.reduce((s, k) => s + u[k], 0);

export default function WarTable({
  onClose,
  seed,
}: {
  onClose: () => void;
  seed?: WaveDraft | null;
}) {
  const {
    villages,
    activeId,
    target,
    selectTarget,
    intel,
    hero,
    commands,
    presets,
    plan,
    recall,
    withdraw,
    savePreset,
    deletePreset,
  } = useGame();
  useGame((s) => s.now); // live clock
  const now = Date.now();
  const v = settle(villages[activeId], now);
  const t = target ? (villages[target.id] ?? target) : null;
  const valid = !!t && t.id !== activeId;
  const ownT = !!t && t.owner === PLAYER; // your own village → the only mission is support
  const kindOf = (w: Wave): Wave["kind"] =>
    ownT ? "support" : w.kind === "support" ? "attack" : w.kind;
  const rival = t ? rivalInfo(t.owner) : null;
  const intelT = t ? intel[t.id] : undefined;
  const intelFull =
    intelT?.units && intelT.wall !== undefined
      ? {
          units: intelT.units,
          wall: intelT.wall,
          loyalty: intelT.loyalty,
          smithy: intelT.smithy,
        }
      : null;
  const enemyScouts = intelT?.units?.scout ?? intelT?.enemyScouts;

  const [waves, setWaves] = useState<Wave[]>(() => [
    seed ? mk(seed.units, seed.kind, seed.offset, seed.cat) : mk(),
  ]);
  const [mode, setMode] = useState<"asap" | "time">("asap");
  const [timeStr, setTimeStr] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cx, setCx] = useState("");
  const [cy, setCy] = useState("");
  const [presetName, setPresetName] = useState("");

  const unitsOf = (w: Wave): Units =>
    UNIT_IDS.reduce(
      (o, u) => ({
        ...o,
        [u]: kindOf(w) === "scout" && u !== "scout" ? 0 : int(w.units[u]),
      }),
      {} as Units,
    );
  const alloc = (u: UnitId) => waves.reduce((s, w) => s + unitsOf(w)[u], 0);
  const over = UNIT_IDS.some((u) => alloc(u) > v.units[u]);
  const remaining = UNIT_IDS.reduce(
    (o, u) => ({ ...o, [u]: Math.max(0, v.units[u] - alloc(u)) }),
    {} as Units,
  );
  const active = waves.filter((w) => total(unitsOf(w)) > 0);

  // ---- timing: every wave lands at T0 + its offset; departures are derived from travel time ----
  const tm = (w: Wave) =>
    valid ? travelMs([v.x, v.y], [t!.x, t!.y], unitsOf(w)) : 0;
  const earliest =
    now +
    (active.length
      ? Math.max(...active.map((w) => tm(w) - w.offset * 1000))
      : 0) +
    300;
  const T0 = mode === "asap" ? earliest : parseTime(timeStr, now);
  const timeOk = Number.isFinite(T0) && T0 >= earliest - 50;

  // ---- prediction from scouted intel, wave by wave in landing order ----
  const order = active
    .filter((w) => kindOf(w) === "attack")
    .sort((a, b) => a.offset - b.offset);
  const sim =
    intelFull && order.length
      ? simulateWaves(
          order.map(unitsOf),
          intelFull,
          v.buildings.smithy,
          heroLevel(hero.xp),
        )
      : null;
  const simOf = (w: Wave) => (sim ? sim[order.indexOf(w)] : undefined);
  const homeRating = defenseRating(
    UNIT_IDS.reduce(
      (o, u) => ({ ...o, [u]: remaining[u] + garrison(v)[u] - v.units[u] }),
      {} as Units,
    ),
    v.buildings.wall,
    defenseBonusFor(v.buildings.smithy),
  );
  const noblesSent = order.reduce((s, w) => s + unitsOf(w).noble, 0);
  const loyaltyKnown = intelT ? intelT.loyalty : 100;

  const setWave = (id: string, patch: Partial<Wave>) =>
    setWaves((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const setUnit = (id: string, u: UnitId, n: number) => {
    const others = waves
      .filter((w) => w.id !== id)
      .reduce((s, w) => s + unitsOf(w)[u], 0);
    setWave(id, {
      units: {
        ...waves.find((w) => w.id === id)!.units,
        [u]: Math.min(int(n), Math.max(0, v.units[u] - others)),
      },
    });
  };
  const fit = (ws: Wave[]): Wave[] => {
    // clamp a preset to what is actually at home
    const left = { ...v.units };
    return ws.map((w) => ({
      ...w,
      units: Object.fromEntries(
        UNIT_IDS.map((u) => {
          const n = Math.min(int(w.units[u]), left[u]);
          left[u] -= n;
          return [u, n];
        }),
      ) as Partial<Units>,
    }));
  };
  const have = (u: UnitId) => v.units[u];
  const BUILT_IN: { name: string; own?: boolean; build: () => Wave[] }[] = [
    {
      name: "🛡 Garrison",
      own: true,
      build: () => [
        mk(
          Object.fromEntries(
            UNIT_IDS.filter(
              (u) => UNITS[u].role === "defense" || UNITS[u].role === "hybrid",
            ).map((u) => [u, have(u)]),
          ),
          "support",
        ),
      ],
    },
    {
      name: "⚔ Strike",
      build: () => [mk(Object.fromEntries(OFFENSE.map((u) => [u, have(u)])))],
    },
    {
      name: "🐎 Raid",
      build: () => [mk({ light: have("light"), mounted: have("mounted") })],
    },
    {
      name: "🔍 Scout ×3",
      build: () => [mk({ scout: Math.min(3, have("scout")) }, "scout")],
    },
    {
      name: "👑 Noble train",
      build: () => {
        const n = Math.min(4, have("noble"));
        const escort = Math.min(have("axe"), n * 15); // every noble walks in with axemen: alone he dies on the base defense
        const clear = Object.fromEntries(
          OFFENSE.map((u) => [u, u === "axe" ? have(u) - escort : have(u)]),
        );
        return [
          mk(clear, "attack", 0),
          ...Array.from({ length: n }, (_, i) =>
            mk(
              { noble: 1, axe: Math.floor(escort / Math.max(1, n)) },
              "attack",
              0.5 + i * 0.3,
            ),
          ),
        ];
      },
    },
  ];

  const lookup = () => {
    const x = int(cx),
      y = int(cy);
    const found =
      Object.values(villages).find((q) => q.x === x && q.y === y) ??
      villageAt(x, y, now);
    if (!found) return setMsg({ ok: false, text: `No village at ${x}|${y}.` });
    selectTarget(found);
    setMsg(null);
  };

  const orders = active.map((w) => ({
    kind: kindOf(w),
    units: unitsOf(w),
    catTarget: w.cat,
    arriveAt: T0 + w.offset * 1000,
  }));
  const canSend =
    valid && v.buildings.rally >= 1 && active.length > 0 && !over && timeOk;
  const send = () => {
    const err = plan(orders);
    setMsg(
      err
        ? { ok: false, text: err }
        : { ok: true, text: `${orders.length} wave(s) committed.` },
    );
    if (!err) setWaves([mk()]);
  };

  return (
    <div className="modal war" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <b style={{ fontSize: 16 }}>
            ⚔ War Table — from {v.name} ({v.x}|{v.y})
          </b>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="wt">
          <div>
            <div className="wcard">
              <b>Target</b>
              <div
                className="row"
                style={{ justifyContent: "flex-start", gap: 6 }}
              >
                <input
                  type="number"
                  placeholder="x"
                  style={{ width: 60 }}
                  value={cx}
                  onChange={(e) => setCx(e.target.value)}
                />
                |
                <input
                  type="number"
                  placeholder="y"
                  style={{ width: 60 }}
                  value={cy}
                  onChange={(e) => setCy(e.target.value)}
                />
                <button onClick={lookup}>Set</button>
                <small>or pick one on the world map</small>
              </div>
              {t ? (
                <div>
                  {t.name} ({t.x}|{t.y}) — {t.points} pts{" "}
                  {ownT && (
                    <span className="green">(yours — send support)</span>
                  )}
                  {rival && (
                    <span
                      className="badge"
                      style={{ background: rival.color, marginLeft: 6 }}
                    >
                      {rival.name}
                      {rival.nemesis ? " 😈 nemesis" : ""}
                    </span>
                  )}
                </div>
              ) : (
                <div className="warn">No target picked.</div>
              )}
              {v.buildings.rally < 1 && (
                <div className="red">Build a Rally Point to send troops.</div>
              )}
              {t && !intelFull && (
                <div className="warn">
                  {intelT
                    ? "Intel is only a glimpse — no troops or wall yet. Send more scouts than they have."
                    : "No intel — send a scout wave first to see their troops and wall."}
                </div>
              )}
              {intelT && (
                <small>
                  📋 {SCOUT_TIER_NAME[intelT.tier]}, {dur(now - intelT.at)} old:{" "}
                  {intelT.wall !== undefined ? `wall ${intelT.wall}, ` : ""}
                  loyalty {Math.round(intelT.loyalty)}
                  {enemyScouts !== undefined
                    ? `, ${enemyScouts} enemy scouts`
                    : ""}
                  .
                </small>
              )}
            </div>

            <div className="wcard">
              <b>Presets</b>
              <div>
                {BUILT_IN.filter((p) => !!p.own === ownT).map((p) => (
                  <span
                    key={p.name}
                    className="chip"
                    onClick={() => setWaves(fit(p.build()))}
                  >
                    {p.name}
                  </span>
                ))}
                {presets.map((p) => (
                  <span
                    key={p.id}
                    className="chip"
                    onClick={() =>
                      setWaves(fit(p.waves.map((w) => ({ ...w, id: uid() }))))
                    }
                  >
                    ⭐ {p.name}
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        deletePreset(p.id);
                      }}
                    >
                      {" "}
                      ✕
                    </span>
                  </span>
                ))}
              </div>
              <div
                className="row"
                style={{ justifyContent: "flex-start", gap: 6 }}
              >
                <input
                  placeholder="save current as…"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                />
                <button
                  disabled={!presetName.trim() || !active.length}
                  onClick={() => {
                    savePreset(
                      presetName.trim(),
                      active.map(({ id, ...w }) => ({
                        ...w,
                        units: unitsOf({ id, ...w }),
                      })),
                    );
                    setPresetName("");
                  }}
                >
                  Save
                </button>
              </div>
            </div>

            {waves.map((w, i) => {
              const r = simOf(w);
              const u = unitsOf(w);
              return (
                <div className="wcard" key={w.id}>
                  <div className="row">
                    <b>Wave {i + 1}</b>
                    <span>
                      {ownT ? (
                        <b>🛡 Support</b>
                      ) : (
                        <select
                          value={w.kind === "support" ? "attack" : w.kind}
                          onChange={(e) =>
                            setWave(w.id, {
                              kind: e.target.value as Wave["kind"],
                            })
                          }
                        >
                          <option value="attack">Attack</option>
                          <option value="scout">Scout</option>
                        </select>
                      )}{" "}
                      lands +
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        style={{ width: 60 }}
                        value={w.offset}
                        onChange={(e) =>
                          setWave(w.id, {
                            offset: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                      />
                      s
                      {waves.length > 1 && (
                        <button
                          style={{ marginLeft: 6 }}
                          onClick={() =>
                            setWaves((ws) => ws.filter((x) => x.id !== w.id))
                          }
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="ugrid">
                    {UNIT_IDS.filter(
                      (k) =>
                        v.units[k] > 0 &&
                        (kindOf(w) !== "scout" || k === "scout"),
                    ).map((k) => (
                      <label key={k}>
                        <span>
                          {UNITS[k].name} <small>/{v.units[k]}</small>
                        </span>
                        <input
                          type="number"
                          min={0}
                          style={{ width: 58 }}
                          value={w.units[k] ?? 0}
                          onChange={(e) =>
                            setUnit(w.id, k, Number(e.target.value))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  {u.catapult > 0 && (
                    <div className="row">
                      <span>🎯 Catapults aim at</span>
                      <select
                        value={w.cat}
                        onChange={(e) =>
                          setWave(w.id, { cat: e.target.value as BuildingId })
                        }
                      >
                        {BUILDING_IDS.map((b) => (
                          <option key={b} value={b}>
                            {BUILDINGS[b].name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {total(u) > 0 && valid && (
                    <small>
                      🚶 {dur(tm(w))} · departs{" "}
                      {clock(T0 + w.offset * 1000 - tm(w))} · lands{" "}
                      <b>{clock(T0 + w.offset * 1000)}</b>
                      {kindOf(w) === "attack" &&
                        ` · 🎒 ${carryCapacity(u)} · mix ${ATTACK_CLASSES.filter(
                          (k) => attackShares(u)[k] > 0.005,
                        )
                          .map(
                            (k) =>
                              `${CLASS_ICON[k]}${Math.round(attackShares(u)[k] * 100)}%`,
                          )
                          .join(" ")}`}
                    </small>
                  )}
                  {kindOf(w) === "scout" &&
                    u.scout > 0 &&
                    (() => {
                      const e =
                        enemyScouts !== undefined
                          ? resolveScout(u.scout, enemyScouts)
                          : null;
                      return (
                        <div>
                          <small>
                            {e
                              ? e.success
                                ? `Expect: ${SCOUT_TIER_NAME[e.tier]} — ${e.lost} lost, they lose ${e.defenderLost}`
                                : "They would all be caught."
                              : "Their scouts are unknown — barbarians have none; send extra against players."}
                          </small>
                        </div>
                      );
                    })()}
                  {r && (
                    <div>
                      <small className={r.wins ? "green" : "red"}>
                        {r.conquered
                          ? "👑 village falls"
                          : r.wins
                            ? `⚔️ predicted win — ${total(r.attackerLeft)}/${total(u)} survive${u.noble > 0 ? ` · loyalty → ${Math.round(r.loyalty)}` : ""}`
                            : "💀 predicted defeat"}
                      </small>
                    </div>
                  )}
                </div>
              );
            })}
            <button
              onClick={() =>
                setWaves((ws) => [
                  ...ws,
                  mk({}, "attack", (ws.at(-1)?.offset ?? 0) + 0.5),
                ])
              }
            >
              ＋ Add wave
            </button>
          </div>

          <div>
            <div className="wcard">
              <b>Landing</b>
              <div
                className="row"
                style={{ justifyContent: "flex-start", gap: 10 }}
              >
                <label>
                  <input
                    type="radio"
                    checked={mode === "asap"}
                    onChange={() => setMode("asap")}
                  />{" "}
                  Earliest
                </label>
                <label>
                  <input
                    type="radio"
                    checked={mode === "time"}
                    onChange={() => setMode("time")}
                  />{" "}
                  At time
                </label>
                {mode === "time" && (
                  <input
                    type="time"
                    step={1}
                    value={timeStr}
                    onChange={(e) => setTimeStr(e.target.value)}
                  />
                )}
              </div>
              {valid && active.length > 0 && (
                <div>
                  First wave lands{" "}
                  <b>{Number.isFinite(T0) ? clock(T0) : "—"}</b>
                  {mode === "time" && !timeOk && (
                    <span className="red">
                      {" "}
                      — too early, earliest is {clock(earliest)}
                    </span>
                  )}
                </div>
              )}
              <small>
                Every wave lands at its own offset, so rams and nobles can
                arrive fractions of a second apart.
              </small>
            </div>

            <div className="wcard">
              <b>Check</b>
              <div>
                🛡 Home after sending:{" "}
                {ATTACK_CLASSES.map(
                  (k) => `${CLASS_ICON[k]}${Math.round(homeRating[k])}`,
                ).join("  ")}
              </div>
              {over && (
                <div className="red">Waves use more troops than you have.</div>
              )}
              {sim && (
                <div className={sim.some((r) => r.conquered) ? "green" : ""}>
                  Operation estimate:{" "}
                  {sim.some((r) => r.conquered)
                    ? "👑 village conquered"
                    : `${sim.filter((r) => r.wins).length}/${sim.length} waves win`}{" "}
                  <small>(based on intel — it may be out of date)</small>
                </div>
              )}
              {order.some(
                (w, i) => unitsOf(w).noble > 0 && sim && !sim[i].wins,
              ) && (
                <div className="warn">
                  A wave with Nobles is predicted to lose — they'd die for
                  nothing. Add rams or send them later.
                </div>
              )}
              {ownT &&
                t &&
                (() => {
                  const raid = commands
                    .filter((c) => c.kind === "raid" && c.toId === t.id)
                    .sort((a, b) => a.arriveAt - b.arriveAt)[0];
                  if (!raid || !active.length) return null;
                  const lastLand =
                    T0 + Math.max(...active.map((w) => w.offset)) * 1000;
                  const ok = lastLand <= raid.arriveAt - 300;
                  return (
                    <div className={ok ? "green" : "red"}>
                      🚩 A raid lands at <b>{clock(raid.arriveAt)}</b>. Your
                      support lands {clock(T0)} —{" "}
                      {ok
                        ? "✓ in time"
                        : "✗ too late, it would arrive after the raid"}
                      .
                    </div>
                  );
                })()}
              {noblesSent > 0 && (
                <div
                  className={
                    noblesSent < noblesNeeded(loyaltyKnown) ? "warn" : "green"
                  }
                >
                  👑 {noblesNeeded(loyaltyKnown)} noble
                  {noblesNeeded(loyaltyKnown) > 1 ? "s" : ""} must{" "}
                  <i>survive</i> to take a village at loyalty{" "}
                  {Math.round(loyaltyKnown)}
                  {intelT ? "" : " (assumed — scout to know)"}; you send{" "}
                  {noblesSent}.
                  {noblesSent < noblesNeeded(loyaltyKnown) &&
                    " It will survive this attack with loyalty left."}
                </div>
              )}
              <button
                style={{ width: "100%", marginTop: 6 }}
                disabled={!canSend}
                onClick={send}
              >
                ⚔ Commit orders
              </button>
              {msg && (
                <div className={msg.ok ? "green" : "red"}>{msg.text}</div>
              )}
            </div>

            <div className="wcard">
              <b>
                Orders in progress (
                {commands.filter((c) => c.kind !== "raid" && !c.clan).length})
              </b>
              {commands.filter((c) => c.kind !== "raid" && !c.clan).length ===
                0 && (
                <div>
                  <small>Nothing marching.</small>
                </div>
              )}
              {commands
                .filter((c) => c.kind !== "raid" && !c.clan)
                .map((c) => {
                  const out = c.kind !== "return" && c.kind !== "trade";
                  const left = c.departAt + recallWindowMs() - now;
                  const canRecall = out && now < c.arriveAt && left > 0;
                  return (
                    <div className="row" key={c.id}>
                      <span>
                        {kindIcon(c.kind)} {c.toId}
                        <small>
                          {" "}
                          ·{" "}
                          {now < c.departAt
                            ? `departs ${dur(c.departAt - now)}`
                            : `lands ${dur(c.arriveAt - now)}`}
                        </small>
                      </span>
                      {canRecall && (
                        <button
                          onClick={() => recall(c.id)}
                          title="Cancel: the troops turn around where they are"
                        >
                          ↩ Cancel · {dur(left)}
                        </button>
                      )}
                    </div>
                  );
                })}
              <small>
                Marches can be recalled during the first {dur(recallWindowMs())}{" "}
                after they depart.
              </small>
            </div>

            <div className="wcard">
              <b>Garrisons</b>
              {Object.values(villages)
                .filter(
                  (h) =>
                    h.id !== v.id &&
                    UNIT_IDS.some((u) => (h.stationed?.[v.id]?.[u] ?? 0) > 0),
                )
                .map((h) => (
                  <div className="row" key={h.id}>
                    <small>
                      🛡 Yours in {h.name}:{" "}
                      {UNIT_IDS.filter((u) => h.stationed[v.id][u] > 0)
                        .map((u) => `${UNITS[u].name} ${h.stationed[v.id][u]}`)
                        .join(", ")}
                    </small>
                    <button onClick={() => withdraw(h.id, v.id)}>↩ Home</button>
                  </div>
                ))}
              {Object.entries(v.stationed ?? {})
                .filter(([, st]) => UNIT_IDS.some((u) => st[u] > 0))
                .map(([oid, st]) => (
                  <div className="row" key={oid}>
                    <small>
                      🛡 Standing here from {villages[oid]?.name ?? oid}:{" "}
                      {UNIT_IDS.filter((u) => st[u] > 0)
                        .map((u) => `${UNITS[u].name} ${st[u]}`)
                        .join(", ")}
                    </small>
                    <button onClick={() => withdraw(v.id, oid)}>
                      ↩ Send home
                    </button>
                  </div>
                ))}
              {!Object.values(villages).some(
                (h) =>
                  h.id !== v.id &&
                  UNIT_IDS.some((u) => (h.stationed?.[v.id]?.[u] ?? 0) > 0),
              ) &&
                !Object.values(v.stationed ?? {}).some((st) =>
                  UNIT_IDS.some((u) => st[u] > 0),
                ) && (
                  <div>
                    <small>No support stationed anywhere.</small>
                  </div>
                )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
