import { useState } from "react";
import { BUILDINGS } from "../game/config/buildings";
import {
  MERCHANT_CAPACITY,
  RES,
  capacity,
  merchantsFree,
  settle,
  tradeMs,
} from "../game/core/economy";
import { PLAYER } from "../game/core/world";
import type { Cost } from "../game/core/types";
import { useGame } from "../game/store";
import { clock, dur } from "./fmt";

const ICON = { wood: "🪵", clay: "🧱", iron: "⛏️" } as const;
const int = (x: unknown) => Math.max(0, Math.floor(Number(x) || 0));

/** Send resources between your villages. Merchants (1 per Market level) carry 1000 each and are busy until they walk home. */
export default function Market({
  onClose,
  to,
}: {
  onClose: () => void;
  to?: string | null;
}) {
  const { villages, activeId, commands, trade } = useGame();
  useGame((s) => s.now);
  const now = Date.now();
  const v = settle(villages[activeId], now);
  const others = Object.values(villages).filter(
    (x) => x.owner === PLAYER && x.id !== activeId,
  );
  const [dest, setDest] = useState<string>(
    to && others.some((o) => o.id === to) ? to : (others[0]?.id ?? ""),
  );
  const [cargo, setCargo] = useState<Cost>({ wood: 0, clay: 0, iron: 0 });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const d = villages[dest];
  const dSet = d ? settle(d, now) : null;
  const free = merchantsFree(v, commands);
  const room = free * MERCHANT_CAPACITY;
  const total = RES.reduce((s, r) => s + cargo[r], 0);
  const need = Math.ceil(total / MERCHANT_CAPACITY);
  const travel = d ? tradeMs([v.x, v.y], [d.x, d.y]) : 0;
  const cap = dSet ? capacity(dSet) : 0;
  const overflow = dSet
    ? RES.reduce(
        (s, r) => s + Math.max(0, dSet.resources[r] + cargo[r] - cap),
        0,
      )
    : 0;
  const setR = (r: keyof Cost, n: number) => {
    const others2 = total - cargo[r];
    setCargo({
      ...cargo,
      [r]: Math.min(
        int(n),
        Math.floor(v.resources[r]),
        Math.max(0, room - others2),
      ),
    });
  };
  const mine = commands.filter(
    (c) =>
      (c.merchants ?? 0) > 0 &&
      (c.kind === "return" ? c.toId : c.fromId) === v.id,
  );
  const reqs = BUILDINGS.market.requires ?? [];

  const send = () => {
    const err = trade(dest, cargo);
    setMsg(
      err
        ? { ok: false, text: err }
        : {
            ok: true,
            text: `${need} merchant${need > 1 ? "s" : ""} on the road — arrive ${clock(now + travel)}`,
          },
    );
    if (!err) setCargo({ wood: 0, clay: 0, iron: 0 });
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <b style={{ fontSize: 16 }}>
            🏪 Market — {v.name} ({v.x}|{v.y})
          </b>
          <button onClick={onClose}>✕</button>
        </div>

        {v.buildings.market < 1 ? (
          <div className="wcard">
            <div className="warn">This village has no Market yet.</div>
            <small>
              The Market requires:{" "}
              {reqs
                .map(
                  (r) =>
                    `${BUILDINGS[r.building].name} ${r.level} (you: ${v.buildings[r.building]})`,
                )
                .join(", ")}
              .
            </small>
          </div>
        ) : others.length === 0 ? (
          <div className="wcard">
            <div className="warn">
              You need a second village to trade with. Conquer one!
            </div>
          </div>
        ) : (
          <div className="rep">
            <div className="wcard">
              <b>Caravan</b>
              <div>
                <small>
                  Market level {v.buildings.market} · merchants {free}/
                  {v.buildings.market} free · {MERCHANT_CAPACITY} each (room for{" "}
                  {room})
                </small>
              </div>
              <div className="row">
                <span>To</span>
                <select value={dest} onChange={(e) => setDest(e.target.value)}>
                  {others.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.x}|{o.y})
                    </option>
                  ))}
                </select>
              </div>
              {RES.map((r) => (
                <div className="row" key={r}>
                  <span>
                    {ICON[r]} {r} <small>/{Math.floor(v.resources[r])}</small>
                  </span>
                  <span>
                    <input
                      type="number"
                      min={0}
                      style={{ width: 80 }}
                      value={cargo[r]}
                      onChange={(e) => setR(r, Number(e.target.value))}
                    />
                    <button
                      style={{ marginLeft: 4 }}
                      onClick={() => setR(r, 1e9)}
                    >
                      max
                    </button>
                  </span>
                </div>
              ))}
              <button onClick={() => setCargo({ wood: 0, clay: 0, iron: 0 })}>
                Clear
              </button>
              <div style={{ marginTop: 6 }}>
                {total > 0 && (
                  <div>
                    {total} resources · {need} merchant{need > 1 ? "s" : ""} ·
                    🚶 {dur(travel)} · arrive <b>{clock(now + travel)}</b>
                  </div>
                )}
                {overflow > 0 && (
                  <div className="warn">
                    <small>
                      ⚠ {Math.round(overflow)} would be lost: {d?.name}'s
                      warehouse holds {cap} of each.
                    </small>
                  </div>
                )}
              </div>
              <button
                style={{ width: "100%", marginTop: 6 }}
                disabled={total <= 0 || need > free}
                onClick={send}
              >
                🏪 Send caravan
              </button>
              {msg && (
                <div className={msg.ok ? "green" : "red"}>
                  <small>{msg.text}</small>
                </div>
              )}
            </div>
            <div className="wcard">
              <b>Merchants on the road ({mine.length})</b>
              {mine.length === 0 && (
                <div>
                  <small>All merchants are home.</small>
                </div>
              )}
              {mine.map((c) => (
                <div key={c.id}>
                  <small>
                    {c.kind === "trade"
                      ? `→ ${villages[c.toId]?.name ?? c.toId}: ${RES.map((r) => `${ICON[r]}${c.loot[r]}`).join(" ")} · arrives in ${dur(c.arriveAt - now)}`
                      : `🏠 ${c.merchants} merchant(s) walking home · ${dur(c.arriveAt - now)}`}
                  </small>
                </div>
              ))}
              <small>
                Merchants can't be recalled. Anything above the destination's
                warehouse capacity is lost.
              </small>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
