import { Fragment, useState } from "react";
import { UNITS, UNIT_IDS } from "../game/config/units";
import { RALLY } from "../game/config/rally";
import { emptyUnits } from "../game/core/combat";
import { settle, travelMs } from "../game/core/economy";
import {
  rallyParticipants,
  rallyTroops,
  troopCount,
  type Rally,
  type RallyTimerKey,
} from "../game/core/rally";
import type { UnitId, Units, Village } from "../game/core/types";
import { PLAYER } from "../game/core/world";
import { useGame } from "../game/store";
import { dur } from "./fmt";

/**
 * Number boxes for the troops a village sends (nobles can never join a rally).
 * `only` limits the list to some unit types, for example the ones that can still make it in time.
 */
function UnitPicker({
  v,
  value,
  onChange,
  only,
}: {
  v: Village;
  value: Units;
  onChange: (u: Units) => void;
  only?: UnitId[];
}) {
  const ids = UNIT_IDS.filter(
    (u) => u !== "noble" && v.units[u] > 0 && (!only || only.includes(u)),
  );
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

/** How long one unit of this type needs to walk from `from` to `host`. */
const unitEta = (from: Village, host: Village, u: UnitId) =>
  travelMs([from.x, from.y], [host.x, host.y], { ...emptyUnits(), [u]: 1 });

/** One open rally: its timer, who is in, and a table of the villages that can still make it in time. */
function RallyCard({ r }: { r: Rally }) {
  const { villages, joinRally, cancelRally } = useGame();
  const mine = Object.values(villages).filter((v) => v.owner === PLAYER);
  const host = villages[r.hostId];
  const [open, setOpen] = useState<string | null>(null); // the village whose troop picker is open
  const [picks, setPicks] = useState<Record<string, Units>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const now = Date.now();
  const left = r.startsAt - now;
  const room = Math.max(0, r.maxTroops - rallyTroops(r)); // troops the rally can still take
  const full = rallyParticipants(r) >= r.maxParticipants;
  const already = new Set([...r.joins, ...r.pending].map((j) => j.villageId));
  const tName = villages[r.targetId]?.name ?? r.targetId;

  // The villages that can still join: not in yet, a Rally Point, and at least one unit type fast enough to arrive before
  // the rally leaves. A village that can only make it with SOME of its units is listed with just those units.
  const rows =
    host && !full && room > 0 && left > 0
      ? mine
          .filter((v) => v.id !== r.hostId && !already.has(v.id))
          .map((v) => {
            const s = settle(v, now);
            if (s.buildings.rally < 1) return null;
            const fits = UNIT_IDS.filter(
              (u) =>
                u !== "noble" && s.units[u] > 0 && unitEta(s, host, u) <= left,
            );
            if (!fits.length) return null;
            const slow = UNIT_IDS.filter(
              (u) => u !== "noble" && s.units[u] > 0 && !fits.includes(u),
            ).reduce((n, u) => n + s.units[u], 0);
            const all = Object.fromEntries(
              UNIT_IDS.map((u) => [u, fits.includes(u) ? s.units[u] : 0]),
            ) as Units;
            return {
              s,
              fits,
              slow,
              fitTroops: troopCount(all),
              fields: Math.hypot(s.x - host.x, s.y - host.y),
              eta: travelMs([s.x, s.y], [host.x, host.y], all),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .sort((a, b) => a.eta - b.eta)
      : [];

  /** Everything that makes it in time, up to what the rally can still take. */
  const sendAll = (s: Village, fits: UnitId[]) => {
    let cap = room;
    const u2 = emptyUnits();
    for (const u of fits) {
      const n = Math.min(s.units[u], cap);
      u2[u] = n;
      cap -= n;
    }
    return u2;
  };
  const join = (s: Village, units: Units) => {
    const err = joinRally(r.id, s.id, units);
    setMsg(err);
    if (!err) {
      setOpen(null);
      setPicks((p) => ({ ...p, [s.id]: emptyUnits() }));
    }
  };

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

      {left > 0 && (
        <div style={{ marginTop: 6 }}>
          <b>Villages that can still join</b>
          {full || room <= 0 ? (
            <div>
              <small>The rally is full.</small>
            </div>
          ) : rows.length ? (
            <table style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Village</th>
                  <th>Fields</th>
                  <th>Arrives in</th>
                  <th>Can send</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ s, fits, slow, fitTroops, fields, eta }) => {
                  const pick = picks[s.id] ?? emptyUnits();
                  const picked = troopCount(pick);
                  const pickEta =
                    picked > 0
                      ? travelMs([s.x, s.y], [host!.x, host!.y], pick)
                      : 0;
                  return (
                    <Fragment key={s.id}>
                      <tr>
                        <td>
                          {s.name}{" "}
                          <small>
                            ({s.x}|{s.y})
                          </small>
                        </td>
                        <td style={{ textAlign: "center" }}>
                          {fields.toFixed(1)}
                        </td>
                        <td style={{ textAlign: "center" }}>{dur(eta)}</td>
                        <td style={{ textAlign: "center" }}>
                          {Math.min(fitTroops, room)}
                          {slow > 0 && (
                            <small title="These units are too slow to arrive before the rally leaves">
                              {" "}
                              (+{slow} too slow)
                            </small>
                          )}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button
                            title="Send everything that makes it in time"
                            onClick={() => join(s, sendAll(s, fits))}
                          >
                            Send all
                          </button>{" "}
                          <button
                            onClick={() => setOpen(open === s.id ? null : s.id)}
                          >
                            {open === s.id ? "Close" : "Choose"}
                          </button>
                        </td>
                      </tr>
                      {open === s.id && (
                        <tr>
                          <td colSpan={5}>
                            <UnitPicker
                              v={s}
                              only={fits}
                              value={pick}
                              onChange={(u) =>
                                setPicks((p) => ({ ...p, [s.id]: u }))
                              }
                            />
                            {picked > 0 && (
                              <div className="green">
                                🚶 {dur(pickEta)} to get there
                              </div>
                            )}
                            <button
                              style={{ width: "100%", marginTop: 4 }}
                              disabled={picked < 1 || picked > room}
                              onClick={() => join(s, pick)}
                            >
                              Join with {picked} troops
                              {picked > room
                                ? ` (the rally has room for ${room})`
                                : ""}
                            </button>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div>
              <small>
                No village of yours can make it before the rally leaves (each
                needs a Rally Point and at least one unit type that is fast
                enough).
              </small>
            </div>
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
  const [timerKey, setTimerKey] = useState<RallyTimerKey>(TIMER_OPTIONS[0].key);
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
          <span className="grow">Leaves in</span>
          <select
            value={timerKey}
            onChange={(e) => setTimerKey(e.target.value as RallyTimerKey)}
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
              timerKey: timerKey,
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
