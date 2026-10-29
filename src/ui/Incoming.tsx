import { UNITS, UNIT_IDS } from "../game/config/units";
import { settle, travelMs } from "../game/core/economy";
import { PLAYER } from "../game/core/world";
import type { Units, Village, WaveDraft } from "../game/core/types";
import { useGame } from "../game/store";
import { dur } from "./fmt";

interface Helper {
  h: Village;
  defenders: Units;
  ms: number;
  spare: number;
}

/** Raids on the way to your villages, and which of your other villages can still get support there in time. */
export default function Incoming({
  onSupport,
  onShow,
}: {
  onSupport: (helperId: string, targetId: string, seed: WaveDraft) => void;
  onShow: (x: number, y: number) => void;
}) {
  const { commands, villages } = useGame();
  useGame((s) => s.now);
  const now = Date.now();
  const raids = commands
    .filter(
      (c) =>
        c.kind === "raid" ||
        (c.kind === "expand" && villages[c.toId]?.owner === PLAYER),
    )
    .sort((a, b) => a.arriveAt - b.arriveAt);
  if (!raids.length) return null;
  return (
    <div className="panel incoming">
      <b>⚠ Incoming attacks ({raids.length})</b>
      {raids.map((c) => {
        const target = villages[c.toId];
        const helpers = Object.values(villages)
          .filter((h) => h.owner === PLAYER && h.id !== c.toId)
          .map((h) => {
            const hs = settle(h, now);
            const defenders = UNIT_IDS.reduce(
              (o, u) => ({
                ...o,
                [u]:
                  UNITS[u].role === "defense" || UNITS[u].role === "hybrid"
                    ? hs.units[u]
                    : 0,
              }),
              {} as Units,
            );
            if (UNIT_IDS.every((u) => defenders[u] <= 0)) return null;
            const ms = travelMs([h.x, h.y], c.toXY, defenders);
            return {
              h,
              defenders,
              ms,
              spare: c.arriveAt - (now + ms),
            } as Helper;
          })
          .filter((x): x is Helper => !!x);
        return (
          <div key={c.id} className="wcard">
            <div className="row">
              <span>
                {c.kind === "expand" ? "👑 NOBLE RUN" : "🚩"}{" "}
                <b>{c.clan ?? "Raiders"}</b> → {target?.name ?? c.toId} · lands
                in <b>{dur(c.arriveAt - now)}</b>
              </span>
              <button
                className="pin"
                title="Where they come from"
                onClick={() => onShow(c.fromXY[0], c.fromXY[1])}
              >
                📍 from {c.fromId}
              </button>
            </div>
            <small>
              {c.kind === "expand"
                ? `Four nobles under escort: every noble that survives the fight cuts this village's loyalty by 25 (it is at ${Math.round(target?.loyalty ?? 100)}). Beat the escort and the nobles die with it. Your last village can never be taken.`
                : "Their army is unknown until it arrives. Scout their villages to learn what they field."}
            </small>
            {helpers.length === 0 && (
              <div>
                <small>No other village has defenders to send.</small>
              </div>
            )}
            {helpers.map(({ h, defenders, ms, spare }) => (
              <div className="row" key={h.id}>
                <small className={spare > 0 ? "green" : "red"}>
                  {h.name}: 🛡 {dur(ms)} away →{" "}
                  {spare > 0 ? `✓ ${dur(spare)} to spare` : "✗ too late"}
                </small>
                {spare > 0 && (
                  <button
                    onClick={() =>
                      onSupport(h.id, c.toId, {
                        kind: "support",
                        units: defenders,
                        offset: 0,
                        cat: "wall",
                      })
                    }
                  >
                    Prepare support
                  </button>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
