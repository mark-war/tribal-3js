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
import { resolveWaves } from "../game/presets";
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
    updatePreset,
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
  const [loadedId, setLoadedId] = useState<string | null>(null); // the preset being edited
  const [editName, setEditName] = useState("");

  const resolved = resolveWaves(waves, v.units); // "all" (∞) amounts and noble escorts turned into real numbers
  const unitsOf = (w: Wave): Units => {
    const r = resolved[waves.indexOf(w)] ?? ({} as Units);
    return UNIT_IDS.reduce(
      (o, u) => ({
        ...o,
        [u]: kindOf(w) === "scout" && u !== "scout" ? 0 : int(r[u]),
      }),
      {} as Units,
    );
  };
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
    // n = -1 means "all I have"
    const fixedOthers = waves
      .filter((w) => w.id !== id)
      .reduce((s, w) => s + Math.max(0, w.units[u] ?? 0), 0);
    setWave(id, {
      units: {
        ...waves.find((w) => w.id === id)!.units,
        [u]:
          n < 0 ? -1 : Math.min(int(n), Math.max(0, v.units[u] - fixedOthers)),
      },
    });
  };
  const draftWaves = (): WaveDraft[] =>
    waves
      .filter((w) => UNIT_IDS.some((u) => (w.units[u] ?? 0) !== 0))
      .map(({ id, ...w }) => ({
        ...w,
        kind: kindOf({ id, ...w }),
        units: Object.fromEntries(
          UNIT_IDS.filter((u) => (w.units[u] ?? 0) !== 0).map((u) => [
            u,
            w.units[u],
          ]),
        ) as Partial<Units>,
      }));
  const loaded = presets.find((p) => p.id === loadedId) ?? null;

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
              <b>Presets</b>{" "}
              <small>
                click to load · ∞ = "all I have", so they stay up to date as
                your army grows
              </small>
              <div>
                {presets
                  .filter(
                    (p) => p.waves.every((w) => w.kind === "support") === ownT,
                  )
                  .map((p) => (
                    <span
                      key={p.id}
                      className={`chip${loadedId === p.id ? " on" : ""}`}
                      onClick={() => {
                        setWaves(p.waves.map((w) => ({ ...w, id: uid() })));
                        setLoadedId(p.id);
                        setEditName(p.name);
                      }}
                    >
                      {p.name}
                    </span>
                  ))}
              </div>
              {loaded && (
                <div
                  className="row"
                  style={{
                    justifyContent: "flex-start",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <span>✏️ Editing</span>
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    style={{ width: 130 }}
                  />
                  <button
                    disabled={!draftWaves().length}
                    title="Replace this preset with the waves below"
                    onClick={() =>
                      updatePreset(loaded.id, {
                        name: editName.trim() || loaded.name,
                        waves: draftWaves(),
                      })
                    }
                  >
                    💾 Update
                  </button>
                  <button
                    onClick={() => {
                      deletePreset(loaded.id);
                      setLoadedId(null);
                    }}
                  >
                    🗑 Delete
                  </button>
                  <button onClick={() => setLoadedId(null)}>Done</button>
                </div>
              )}
              <div
                className="row"
                style={{ justifyContent: "flex-start", gap: 6 }}
              >
                <input
                  placeholder="save the waves below as a new preset…"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                />
                <button
                  disabled={!presetName.trim() || !draftWaves().length}
                  onClick={() => {
                    savePreset(presetName.trim(), draftWaves());
                    setPresetName("");
                  }}
                >
                  Save new
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
                        (v.units[k] > 0 || (w.units[k] ?? 0) !== 0) &&
                        (kindOf(w) !== "scout" || k === "scout"),
                    ).map((k) => {
                      const raw = w.units[k] ?? 0;
                      return (
                        <label key={k}>
                          <span>
                            {UNITS[k].name} <small>/{v.units[k]}</small>
                          </span>
                          <input
                            type="number"
                            min={0}
                            style={{ width: 58 }}
                            value={raw < 0 ? u[k] : raw}
                            disabled={raw < 0}
                            onChange={(e) =>
                              setUnit(w.id, k, Number(e.target.value))
                            }
                          />
                          <button
                            type="button"
                            className={raw < 0 ? "on" : ""}
                            style={{ padding: "0 5px" }}
                            title="All I have (the preset stays up to date as your army grows)"
                            onClick={() =>
                              setUnit(w.id, k, raw < 0 ? u[k] : -1)
                            }
                          >
                            ∞
                          </button>
                        </label>
                      );
                    })}
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
              {noblesSent > 0 &&
                (() => {
                  const need = noblesNeeded(loyaltyKnown);
                  const waves = order.filter(
                    (w) => unitsOf(w).noble > 0,
                  ).length;
                  return (
                    <div
                      className={
                        waves < need.min
                          ? "warn"
                          : waves >= need.max
                            ? "green"
                            : ""
                      }
                    >
                      👑 One noble works per attack and cuts 20–35 loyalty. At
                      loyalty {Math.round(loyaltyKnown)}
                      {intelT ? "" : " (assumed — scout to know)"} you need{" "}
                      {need.min === need.max
                        ? need.min
                        : `${need.min}–${need.max}`}{" "}
                      noble attacks; you have {waves}.
                      {noblesSent > waves &&
                        " Extra nobles in the same wave only come home: give each noble its own wave."}
                      {waves < need.min &&
                        " It will survive this operation with loyalty left."}
                    </div>
                  );
                })()}
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
