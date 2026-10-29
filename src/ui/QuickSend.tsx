import { useState } from "react";
import { BUILDINGS, BUILDING_IDS } from "../game/config/buildings";
import { UNITS, UNIT_IDS } from "../game/config/units";
import {
  ATTACK_CLASSES,
  CLASS_ICON,
  SCOUT_TIER_NAME,
  attackShares,
  carryCapacity,
  defenseBonusFor,
  defenseRating,
  emptyUnits,
  heroLevel,
  noblesNeeded,
  ramsToBreakWall,
  resolveScout,
  simulateWaves,
} from "../game/core/combat";
import { garrison, travelMs } from "../game/core/economy";
import { PLAYER } from "../game/core/world";
import type {
  BuildingId,
  Units,
  UnitId,
  Village,
  WaveDraft,
} from "../game/core/types";
import { useGame } from "../game/store";
import { clock, dur } from "./fmt";

const int = (x: unknown) => Math.max(0, Math.floor(Number(x) || 0));
const total = (u: Units) => UNIT_IDS.reduce((s, k) => s + u[k], 0);
const OFFENSE = UNIT_IDS.filter((u) => UNITS[u].role === "offense");
const DEFENDERS = UNIT_IDS.filter(
  (u) => UNITS[u].role === "defense" || UNITS[u].role === "hybrid",
);

/**
 * The quick version of the War Table, shown in the target panel. Same engine (store.plan):
 * same travel time, landing clock, prediction and recall. One wave, "earliest possible".
 * Enemy target → Scout / Attack. Your own village → Send support (a recallable garrison).
 */
export default function QuickSend({
  v,
  t,
  onWar,
}: {
  v: Village;
  t: Village;
  onWar: (seed: WaveDraft) => void;
}) {
  const { intel, hero, plan } = useGame();
  useGame((s) => s.now);
  const now = Date.now();
  const own = t.owner === PLAYER;
  const [sel, setSel] = useState<Partial<Units>>({});
  const [cat, setCat] = useState<BuildingId>("wall");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (t.id === v.id) return null;
  const picked = UNIT_IDS.reduce(
    (o, u) => ({ ...o, [u]: Math.min(v.units[u], int(sel[u])) }),
    {} as Units,
  );
  const strike: Units = { ...picked, scout: 0 }; // scouts have their own button
  const scouts: Units = { ...emptyUnits(), scout: picked.scout };
  const support: Units = picked; // everything selected goes along
  const hasStrike = total(strike) > 0;
  const hasScouts = scouts.scout > 0;
  const hasSupport = total(support) > 0;
  const ready = v.buildings.rally >= 1;
  const intelT = intel[t.id];
  const tm = (u: Units) => travelMs([v.x, v.y], [t.x, t.y], u);
  const intelFull =
    intelT?.units && intelT.wall !== undefined
      ? {
          units: intelT.units,
          wall: intelT.wall,
          loyalty: intelT.loyalty,
          smithy: intelT.smithy,
        }
      : null;
  const sim =
    intelFull && hasStrike
      ? simulateWaves(
          [strike],
          intelFull,
          v.buildings.smithy,
          heroLevel(hero.xp),
        )[0]
      : null;
  const enemyScouts = intelT?.units?.scout ?? intelT?.enemyScouts;
  const scoutEst =
    hasScouts && enemyScouts !== undefined
      ? resolveScout(scouts.scout, enemyScouts)
      : null;
  const leaving = own ? support : strike;
  const home = defenseRating(
    UNIT_IDS.reduce(
      (o, u) => ({ ...o, [u]: garrison(v)[u] - leaving[u] }),
      {} as Units,
    ),
    v.buildings.wall,
    defenseBonusFor(v.buildings.smithy),
  );
  const shares = attackShares(strike);

  const send = (kind: "attack" | "scout" | "support") => {
    const units =
      kind === "scout" ? scouts : kind === "support" ? support : strike;
    const err = plan([
      { kind, units, catTarget: cat, arriveAt: Date.now() + tm(units) + 300 },
    ]);
    setMsg(
      err
        ? { ok: false, text: err }
        : {
            ok: true,
            text: `${kind === "scout" ? "Scouts" : kind === "support" ? "Support" : "Army"} sent — lands ${clock(Date.now() + tm(units))}`,
          },
    );
    if (!err) setSel({});
  };

  return (
    <div style={{ marginTop: 6 }}>
      <div>
        {own ? (
          <>
            <span
              className="chip"
              onClick={() =>
                setSel(
                  Object.fromEntries(DEFENDERS.map((u) => [u, v.units[u]])),
                )
              }
            >
              🛡 Defenders
            </span>
            <span className="chip" onClick={() => setSel({ ...v.units })}>
              All
            </span>
          </>
        ) : (
          <>
            <span
              className="chip"
              onClick={() =>
                setSel(Object.fromEntries(OFFENSE.map((u) => [u, v.units[u]])))
              }
            >
              ⚔ Strike
            </span>
            <span
              className="chip"
              onClick={() =>
                setSel({ light: v.units.light, mounted: v.units.mounted })
              }
            >
              🐎 Raid
            </span>
            <span
              className="chip"
              onClick={() => setSel({ scout: Math.min(3, v.units.scout) })}
            >
              🔍 Scout ×3
            </span>
            <span className="chip" onClick={() => setSel({ ...v.units })}>
              All
            </span>
          </>
        )}
        <span className="chip" onClick={() => setSel({})}>
          Clear
        </span>
      </div>

      {UNIT_IDS.filter((u) => v.units[u] > 0).map((u: UnitId) => (
        <div className="row" key={u}>
          <span>
            {UNITS[u].name} <small>/{v.units[u]}</small>
          </span>
          <input
            type="number"
            min={0}
            max={v.units[u]}
            style={{ width: 56 }}
            value={sel[u] ?? 0}
            onChange={(e) => setSel({ ...sel, [u]: Number(e.target.value) })}
          />
        </div>
      ))}

      {!own && strike.catapult > 0 && (
        <div className="row">
          <span>🎯 Catapults aim at</span>
          <select
            value={cat}
            onChange={(e) => setCat(e.target.value as BuildingId)}
          >
            {BUILDING_IDS.map((id) => (
              <option key={id} value={id}>
                {BUILDINGS[id].name}
              </option>
            ))}
          </select>
        </div>
      )}

      {own && hasSupport && (
        <div className="ex">
          <div>
            <small>
              🛡 🚶 {dur(tm(support))} · lands{" "}
              <b>{clock(now + tm(support) + 300)}</b>
            </small>
          </div>
          <div>
            <small>
              They defend {t.name} and keep using <b>this</b> village's farm.
              Send them home any time from the War Table (Garrisons).
            </small>
          </div>
          <div>
            <small>
              🛡 Left here after sending:{" "}
              {ATTACK_CLASSES.map(
                (k) => `${CLASS_ICON[k]}${Math.round(home[k])}`,
              ).join("  ")}
            </small>
          </div>
        </div>
      )}

      {!own && (hasStrike || hasScouts) && (
        <div className="ex">
          {hasStrike && (
            <div>
              <small>
                ⚔ 🚶 {dur(tm(strike))} · lands{" "}
                <b>{clock(now + tm(strike) + 300)}</b> · 🎒{" "}
                {carryCapacity(strike)} · mix{" "}
                {ATTACK_CLASSES.filter((k) => shares[k] > 0.005)
                  .map((k) => `${CLASS_ICON[k]}${Math.round(shares[k] * 100)}%`)
                  .join(" ")}
              </small>
            </div>
          )}
          {hasScouts && (
            <div>
              <small>
                🔍 🚶 {dur(tm(scouts))} · back with intel at{" "}
                {clock(now + 2 * tm(scouts) + 300)} ·{" "}
                {scoutEst
                  ? scoutEst.success
                    ? `expect ${SCOUT_TIER_NAME[scoutEst.tier]}, ${scoutEst.lost} lost`
                    : "they would all be caught"
                  : "their scouts are unknown"}
              </small>
            </div>
          )}
          {sim && (
            <div>
              <small className={sim.wins ? "green" : "red"}>
                {sim.conquered
                  ? "👑 village falls"
                  : sim.wins
                    ? `Predicted win — ${total(sim.attackerLeft)}/${total(strike)} survive${strike.noble > 0 ? ` · loyalty → ${Math.round(sim.loyalty)}` : ""}`
                    : "Predicted defeat"}
              </small>
            </div>
          )}
          {strike.noble > 0 && (
            <div
              className={
                strike.noble < noblesNeeded(intelT?.loyalty ?? 100)
                  ? "warn"
                  : "green"
              }
            >
              <small>
                👑 {noblesNeeded(intelT?.loyalty ?? 100)} nobles must survive to
                take it at loyalty {Math.round(intelT?.loyalty ?? 100)}
                {intelT ? "" : " (assumed)"}; you send {strike.noble}. For
                several waves use the War Table.
              </small>
            </div>
          )}
          {!intelFull && hasStrike && (
            <div className="warn">
              <small>
                {intelT
                  ? "Intel is only a glimpse — no troops or wall. Send more scouts."
                  : "No intel — scout first to see their troops and wall."}
              </small>
            </div>
          )}
          {intelT && (
            <div>
              <small>
                📋 {SCOUT_TIER_NAME[intelT.tier]} · {dur(now - intelT.at)} old
                {intelT.wall !== undefined && (
                  <>
                    {" "}
                    · 🧱 wall {intelT.wall}
                    {intelT.wall >= 2 &&
                      ` — ≈${ramsToBreakWall(intelT.wall)} rams to cut it to level ${intelT.wall - Math.floor(intelT.wall / 2)} for the fight`}
                  </>
                )}
              </small>
            </div>
          )}
          {hasStrike && (
            <div>
              <small>
                🛡 Home after sending:{" "}
                {ATTACK_CLASSES.map(
                  (k) => `${CLASS_ICON[k]}${Math.round(home[k])}`,
                ).join("  ")}
              </small>
            </div>
          )}
        </div>
      )}

      <div className="row">
        {own ? (
          <button
            disabled={!ready || !hasSupport}
            onClick={() => send("support")}
          >
            🛡 Send support
          </button>
        ) : (
          <>
            <button
              disabled={!ready || !hasScouts}
              onClick={() => send("scout")}
            >
              🔍 Scout
            </button>
            <button
              disabled={!ready || !hasStrike}
              onClick={() => send("attack")}
            >
              ⚔ Attack
            </button>
          </>
        )}
        <button
          onClick={() =>
            onWar(
              own
                ? { kind: "support", units: support, offset: 0, cat }
                : {
                    kind: hasStrike || !hasScouts ? "attack" : "scout",
                    units: hasStrike || !hasScouts ? strike : scouts,
                    offset: 0,
                    cat,
                  },
            )
          }
        >
          War Table ▸
        </button>
      </div>
      {msg && (
        <div className={msg.ok ? "green" : "red"}>
          <small>{msg.text}</small>
        </div>
      )}
      <small>
        {own
          ? "Support stays in that village as a garrison until you send it home."
          : "Scouts have their own button. For several waves or an exact landing time, use the War Table."}
      </small>
    </div>
  );
}
