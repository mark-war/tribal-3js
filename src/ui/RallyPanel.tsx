import { useState } from "react";
import { UNITS, UNIT_IDS } from "../game/config/units";
import { RALLY } from "../game/config/rally";
import { emptyUnits } from "../game/core/combat";
import { settle, travelMs } from "../game/core/economy";
import {
  rallyParticipants,
  RallyTimerKey,
  rallyTroops,
  troopCount,
  type Rally,
} from "../game/core/rally";
import type { Units, Village } from "../game/core/types";
import { PLAYER } from "../game/core/world";
import { useGame } from "../game/store";
import { dur } from "./fmt";

/** Number boxes for the troops a village sends (nobles can never join a rally). */
function UnitPicker({
  v,
  value,
  onChange,
}: {
  v: Village;
  value: Units;
  onChange: (u: Units) => void;
}) {
  const ids = UNIT_IDS.filter((u) => u !== "noble" && v.units[u] > 0);
  if (!ids.length) return <small>No troops at home to send.</small>;
  return (
    <div>
      <div className="row">
        <button
          onClick={() =>
            onChange(
              Object.fromEntries(
                UNIT_IDS.map((u) => [u, ids.includes(u) ? v.units[u] : 0]),
              ) as Units,
            )
          }
        >
          All
        </button>
        <button onClick={() => onChange(emptyUnits())}>Clear</button>
        <small>{troopCount(value)} troops selected</small>
      </div>
      {ids.map((u) => (
        <div className="row" key={u}>
          <span className="grow">
            {UNITS[u].name} <small>(home {v.units[u]})</small>
          </span>
          <input
            type="number"
            min={0}
            max={v.units[u]}
            style={{ width: 80 }}
            value={value[u] || ""}
            onChange={(e) =>
              onChange({
                ...value,
                [u]: Math.max(
                  0,
                  Math.min(v.units[u], Math.floor(Number(e.target.value) || 0)),
                ),
              })
            }
          />
        </div>
      ))}
    </div>
  );
}

/** One open rally: its timer, who is in, and a form to send troops from another village. */
function RallyCard({ r }: { r: Rally }) {
  const { villages, joinRally, cancelRally } = useGame();
  const mine = Object.values(villages).filter((v) => v.owner === PLAYER);
  const host = villages[r.hostId];
  const already = new Set([...r.joins, ...r.pending].map((j) => j.villageId));
  const candidates = mine.filter(
    (v) => v.id !== r.hostId && !already.has(v.id),
  );
  const [fromId, setFromId] = useState<string>("");
  const [units, setUnits] = useState<Units>(emptyUnits());
  const [msg, setMsg] = useState<string | null>(null);
  const from = candidates.find((v) => v.id === fromId);
  const fromS = from ? settle(from, Date.now()) : undefined;
  const left = r.startsAt - Date.now();
  const ms =
    fromS && host && troopCount(units) > 0
      ? travelMs([fromS.x, fromS.y], [host.x, host.y], units)
      : 0;
  const tName = villages[r.targetId]?.name ?? r.targetId;
  return (
    <div className="report info" style={{ marginBottom: 8 }}>
      <div className="row">
        <b className="grow">
          📯 {host?.name ?? r.hostId} → {tName} ({r.targetXY[0]}|{r.targetXY[1]}
          )
        </b>
        {host?.owner === PLAYER && (
          <button
            title="Cancel the rally: every village's troops walk home"
            onClick={() => cancelRally(r.id)}
          >
            ✕ Cancel
          </button>
        )}
      </div>
      <div>
        ⏱ Leaves in <b>{left > 0 ? dur(left) : "now"}</b> · 🏘 villages{" "}
        {rallyParticipants(r)}/{r.maxParticipants} · ⚔ troops {rallyTroops(r)}/
        {r.maxTroops}
      </div>
      <small>
        In:{" "}
        {r.joins
          .map((j) => villages[j.villageId]?.name ?? j.villageId)
          .join(", ") || "nobody yet"}
        {r.pending.length > 0 &&
          ` · on the way: ${r.pending.map((j) => villages[j.villageId]?.name ?? j.villageId).join(", ")}`}
      </small>

      {candidates.length > 0 && left > 0 && (
        <div style={{ marginTop: 6 }}>
          <div className="row">
            <span className="grow">Send troops from</span>
            <select
              value={fromId}
              onChange={(e) => {
                setFromId(e.target.value);
                setUnits(emptyUnits());
                setMsg(null);
              }}
            >
              <option value="">— pick a village —</option>
              {candidates.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.x}|{v.y})
                </option>
              ))}
            </select>
          </div>
          {fromS && (
            <>
              <UnitPicker v={fromS} value={units} onChange={setUnits} />
              {ms > 0 && (
                <div className={ms > left ? "red" : "green"}>
                  🚶 {dur(ms)} to get there, the rally leaves in{" "}
                  {dur(Math.max(0, left))}
                  {ms > left && ": too late"}
                </div>
              )}
              <button
                style={{ width: "100%", marginTop: 4 }}
                disabled={troopCount(units) < 1 || ms > left}
                onClick={() => {
                  const err = joinRally(r.id, fromS.id, units);
                  setMsg(err);
                  if (!err) {
                    setUnits(emptyUnits());
                    setFromId("");
                  }
                }}
              >
                Join with {troopCount(units)} troops
              </button>
            </>
          )}
          {msg && <div className="red">{msg}</div>}
        </div>
      )}
    </div>
  );
}

const TIMER_OPTIONS: { key: RallyTimerKey; label: string }[] = [
  { key: "30s", label: "30 seconds" },
  { key: "1m", label: "1 minute" },
  { key: "2m", label: "2 minutes" },
  { key: "5m", label: "5 minutes" },
  { key: "10m", label: "10 minutes" },
];

/** Start a rally against the selected target, and join or watch the ones that are open. */
export default function RallyPanel({ onClose }: { onClose: () => void }) {
  const { villages, target, activeId, rallies, startRally } = useGame();
  useGame((s) => s.now); // re-render on tick: the timers count down
  const mine = Object.values(villages).filter((v) => v.owner === PLAYER);
  const [hostId, setHostId] = useState(activeId);
  const [timerMin, setTimerMin] = useState<RallyTimerKey>(TIMER_OPTIONS[0].key);
  const [maxP, setMaxP] = useState<number>(RALLY.defaultParticipants);
  const [maxT, setMaxT] = useState<number>(RALLY.defaultTroops);
  const [units, setUnits] = useState<Units>(emptyUnits());
  const [msg, setMsg] = useState<string | null>(null);
  const hostV = villages[hostId];
  const host = hostV ? settle(hostV, Date.now()) : undefined;
  const t = target ? (villages[target.id] ?? target) : null;
  const hostBusy = rallies.some((r) => r.hostId === hostId);

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <b style={{ fontSize: 16 }}>📯 Rally</b>
          <span className="grow" />
          <button onClick={onClose}>✕</button>
        </div>
        <small>
          One village hosts. Your other villages send troops before the timer
          ends, then everything leaves as ONE army and fights ONE battle.
          Survivors and loot walk back to the villages they came from.
        </small>

        <h4 style={{ margin: "8px 0 4px" }}>Start a rally</h4>
        {!t || t.owner === PLAYER ? (
          <div className="red">
            Pick an enemy or barbarian village on the world map first.
          </div>
        ) : (
          <div>
            Target: <b>{t.name}</b> ({t.x}|{t.y})
          </div>
        )}
        <div className="row">
          <span className="grow">Host village</span>
          <select
            value={hostId}
            onChange={(e) => {
              setHostId(e.target.value);
              setUnits(emptyUnits());
              setMsg(null);
            }}
          >
            {mine.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.x}|{v.y})
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <span className="grow">Leaves in (game minutes)</span>
          <select
            value={timerMin}
            onChange={(e) => setTimerMin(e.target.value as RallyTimerKey)}
          >
            {TIMER_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <span className="grow">Max villages (host included)</span>
          <input
            type="number"
            min={2}
            max={RALLY.maxParticipantsLimit}
            style={{ width: 80 }}
            value={maxP}
            onChange={(e) => setMaxP(Number(e.target.value))}
          />
        </div>
        <div className="row">
          <span className="grow">Max troops in the rally</span>
          <input
            type="number"
            min={1}
            max={RALLY.maxTroopsLimit}
            style={{ width: 80 }}
            value={maxT}
            onChange={(e) => setMaxT(Number(e.target.value))}
          />
        </div>
        {host && (
          <>
            <b>The host sends</b>
            <UnitPicker v={host} value={units} onChange={setUnits} />
          </>
        )}
        <button
          style={{ width: "100%", marginTop: 6 }}
          disabled={
            !t || t.owner === PLAYER || hostBusy || troopCount(units) < 1
          }
          onClick={() => {
            if (!t) return;
            const err = startRally({
              hostId,
              targetId: t.id,
              timer: timerMin,
              maxParticipants: maxP,
              maxTroops: maxT,
              units,
            });
            setMsg(err);
            if (!err) setUnits(emptyUnits());
          }}
        >
          {hostBusy
            ? "This village already hosts a rally"
            : "📯 Start the rally"}
        </button>
        {msg && <div className="red">{msg}</div>}

        <h4 style={{ margin: "10px 0 4px" }}>
          Open rallies ({rallies.length})
        </h4>
        <div style={{ maxHeight: "40vh", overflow: "auto" }}>
          {rallies.length ? (
            rallies.map((r) => <RallyCard key={r.id} r={r} />)
          ) : (
            <small>No rally is open.</small>
          )}
        </div>
      </div>
    </div>
  );
}
