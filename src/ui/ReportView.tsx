import { BUILDINGS, BUILDING_IDS } from "../game/config/buildings";
import { UNITS, UNIT_IDS } from "../game/config/units";
import {
  ATTACK_CLASSES,
  CLASS_ICON,
  CLASS_NAME,
  SCOUT_KILL,
  SCOUT_TIER_NAME,
  noblesNeeded,
} from "../game/core/combat";
import { RES } from "../game/core/economy";
import type {
  BattleDetail,
  Report,
  ScoutDetail,
  Units,
} from "../game/core/types";

const ICON = { wood: "🪵", clay: "🧱", iron: "⛏️" } as const;
const sum = (u: Units) => UNIT_IDS.reduce((s, k) => s + u[k], 0);
const xy = (p: [number, number]) => `${Math.round(p[0])}|${Math.round(p[1])}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Units before / lost / left. `left` undefined = unknown. */
function Roster({
  start,
  left,
  label,
}: {
  start: Units;
  left?: Units;
  label: string;
}) {
  const rows = UNIT_IDS.filter((u) => start[u] > 0);
  if (!rows.length)
    return (
      <div>
        <small>No units.</small>
      </div>
    );
  const lost = left ? sum(start) - sum(left) : undefined;
  return (
    <table>
      <thead>
        <tr>
          <th>Unit</th>
          <th>{label}</th>
          <th>Lost</th>
          <th>Left</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((u) => {
          const l = left?.[u];
          return (
            <tr key={u}>
              <td>{UNITS[u].name}</td>
              <td>{start[u]}</td>
              <td className={l !== undefined && start[u] - l > 0 ? "red" : ""}>
                {l === undefined ? "?" : start[u] - l}
              </td>
              <td>{l ?? "?"}</td>
            </tr>
          );
        })}
        <tr>
          <td>
            <b>Total</b>
          </td>
          <td>
            <b>{sum(start)}</b>
          </td>
          <td className={lost ? "red" : ""}>
            <b>{lost ?? "?"}</b>
          </td>
          <td>
            <b>{left ? sum(left) : "?"}</b>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function Pin({
  p,
  onGoto,
}: {
  p: [number, number];
  onGoto: (x: number, y: number) => void;
}) {
  return (
    <button
      className="pin"
      title="Show on the world map"
      onClick={() => onGoto(Math.round(p[0]), Math.round(p[1]))}
    >
      📍 {xy(p)}
    </button>
  );
}

function Battle({
  d,
  onGoto,
  onLoadSim,
}: {
  d: BattleDetail;
  onGoto: (x: number, y: number) => void;
  onLoadSim?: (seed: {
    attacker?: Partial<Units>;
    defender?: Partial<Units>;
    wall?: number;
    defSmithy?: number;
  }) => void;
}) {
  const defending = d.perspective === "defense";
  const p = d.powers;
  const known = d.defender.known;
  const bonusPct = Math.round((d.attacker.bonus - 1) * 100);
  const ratio =
    p.defense !== undefined
      ? Math.min(p.attack, p.defense) / Math.max(p.attack, p.defense, 1)
      : undefined;
  const winnerLoss = ratio !== undefined ? Math.pow(ratio, 1.5) : undefined;
  const win = d.outcome !== "loss";
  const banner =
    d.outcome === "conquered"
      ? { c: "#ffd54f", t: "👑 Village conquered" }
      : win
        ? { c: "#9f9", t: "⚔️ Victory" }
        : { c: "#ff8a80", t: "💀 Defeat" };
  const nobleUsed = d.loyalty?.nobles ?? 0;
  const luckNote =
    d.luck !== undefined
      ? ` | ${d.luck >= 0 ? "🍀" : "☘"} luck ${d.luck >= 0 ? "+" : ""}${Math.round(d.luck * 100)}%`
      : "";

  return (
    <>
      <div
        className="banner"
        style={{ borderColor: banner.c, color: banner.c }}
      >
        {defending
          ? d.outcome === "conquered"
            ? "💔 Village lost"
            : win
              ? "You were attacked — you lost"
              : "You were attacked — you held"
          : banner.t}
      </div>
      <div style={{ margin: "6px 0" }}>
        <b>{d.attacker.village}</b> <Pin p={d.attacker.xy} onGoto={onGoto} /> →{" "}
        <b>{d.defender.village}</b> <Pin p={d.defender.xy} onGoto={onGoto} />
      </div>

      <div className="rep">
        <div className="wcard">
          <b>{defending ? "Attacker" : "Your army"}</b>
          <Roster start={d.attacker.sent} left={d.attacker.left} label="Sent" />
          {nobleUsed > 0 && (
            <small>
              Nobles are used up when they hit loyalty ({nobleUsed} used).
            </small>
          )}
        </div>
        <div className="wcard">
          <b>{defending ? "Your garrison" : "Defenders"}</b>
          {known && d.defender.before ? (
            <Roster
              start={d.defender.before}
              left={d.defender.left}
              label="Before"
            />
          ) : (
            <div className="warn">
              <small>
                None of your units came back, so you learned nothing about the
                defenders.
              </small>
            </div>
          )}
          {known && d.defender.before && sum(d.defender.before) === 0 && (
            <small> (nobody was home)</small>
          )}
        </div>
      </div>

      <div className="wcard">
        <b>How it was decided</b>
        <ul>
          <li>
            ⚔ {defending ? "Their attack" : "Attack"} power{" "}
            <b>{Math.round(p.attack)}</b>
            {bonusPct > 0 && (
              <>
                {" "}
                (includes +{bonusPct}% from the Smithy
                {d.attacker.heroLevel > 0 && d.attacker.sent.paladin > 0
                  ? " and your Paladin"
                  : ""}
                )
              </>
            )}
            . Attack mix:{" "}
            {ATTACK_CLASSES.filter((k) => p.shares[k] > 0.005)
              .map((k) => `${CLASS_ICON[k]} ${pct(p.shares[k])}`)
              .join("  ")}
          </li>
          {known && p.rating && p.defense !== undefined && (
            <>
              <li>
                🛡 {defending ? "Your" : "Their"} defense against each class:{" "}
                {ATTACK_CLASSES.map((k) => (
                  <span key={k} style={{ marginRight: 10 }}>
                    {CLASS_ICON[k]} {CLASS_NAME[k]} {Math.round(p.rating![k])}
                  </span>
                ))}
              </li>
              {known &&
                d.defender.bonus !== undefined &&
                d.defender.bonus > 1 && (
                  <li>
                    🔨 {defending ? "Your" : "Their"} Smithy sharpened every
                    defender by +{Math.round((d.defender.bonus - 1) * 100)}%
                    (the village's own Smithy counts, support included).
                  </li>
                )}
              <li>
                Weighted by {defending ? "their" : "your"} mix,{" "}
                {defending ? "your" : "their"} defense power was{" "}
                <b>{Math.round(p.defense)}</b>.
              </li>
            </>
          )}
          {known && d.wall.before !== undefined && (
            <li>
              🧱 Wall {d.wall.before}
              {p.effWall !== d.wall.before
                ? ` → counted as ${p.effWall} during the fight (${defending ? "their" : "your"} ${d.wall.rams} rams weakened it)`
                : ""}
              {d.wall.after !== undefined && d.wall.after !== d.wall.before
                ? ` → ${d.wall.after} afterwards (the surviving rams tore it down)`
                : " (unchanged afterwards)"}
              .
              {!defending && d.wall.rams === 0 && d.wall.before > 0 && (
                <span className="warn">
                  {" "}
                  You brought no rams, so the full wall counted.
                </span>
              )}
            </li>
          )}
          {d.outcome === "loss" && d.attacker.sent.noble > 0 && (
            <li className="warn">
              👑 Nobles only lower loyalty when their wave <i>wins</i>. This
              wave lost
              {d.wall.after
                ? `, and the wall (${d.wall.after}) was still standing — bring rams`
                : ""}
              , so loyalty did not change.
            </li>
          )}
          {winnerLoss !== undefined && (
            <li>
              {defending
                ? win
                  ? `They won, so every defender fell (support standing there too); they lost about ${pct(winnerLoss)} of their army.`
                  : `You held: you lost about ${pct(winnerLoss)} of your garrison; their whole army fell.`
                : win
                  ? `You won, so you lost about ${pct(winnerLoss)} of your army (they lost everyone).`
                  : `You lost, so your whole army fell; they lost about ${pct(winnerLoss)} of their garrison.`}
              {d.wall.before !== undefined && d.wall.before > 0 && (
                <small>
                  {" "}
                  The wall fought too: it counts as a defender even with nobody
                  home.
                </small>
              )}
            </li>
          )}
          {luckNote && <li>{luckNote}</li>}
        </ul>
      </div>

      <div className="rep">
        <div className="wcard">
          <b>{defending ? "Looted from you" : "Spoils"}</b>
          {win && d.outcome !== "conquered" ? (
            <div>
              {RES.map((r) => (
                <span key={r} style={{ marginRight: 10 }}>
                  {ICON[r]} {d.loot[r]}
                </span>
              ))}
              <br />
              <small>of {d.carry} carrying capacity</small>
            </div>
          ) : (
            <div>
              <small>
                {d.outcome === "conquered"
                  ? "No loot — you took the village."
                  : "None."}
              </small>
            </div>
          )}
        </div>
        <div className="wcard">
          <b>Effects</b>
          {d.loyalty && (
            <div>
              👑 Loyalty {Math.round(d.loyalty.before)} →{" "}
              {Math.round(d.loyalty.after)} ({d.loyalty.nobles} noble
              {d.loyalty.nobles > 1 ? "s" : ""})
              {d.loyalty.after >= 1 && (
                <span className="warn">
                  {" "}
                  — {noblesNeeded(d.loyalty.after)} more needed
                </span>
              )}
            </div>
          )}
          {d.siege && (
            <div>
              🏚 {BUILDINGS[d.siege.building].name} {d.siege.before} →{" "}
              {d.siege.after}
            </div>
          )}
          {d.hero && (
            <div>
              🦸{" "}
              {d.hero.fell
                ? "The Paladin fell."
                : `+${d.hero.xp} xp${d.hero.levelUp ? ` — reached level ${d.hero.levelUp}!` : ""}`}
            </div>
          )}
          {!d.loyalty && !d.siege && !d.hero && (
            <div>
              <small>No other effects.</small>
            </div>
          )}
        </div>
      </div>

      {known && d.defender.before && onLoadSim && (
        <button
          style={{ marginTop: 8, width: "100%" }}
          onClick={() =>
            onLoadSim({
              attacker: d.attacker.sent, // optional but handy
              defender: d.defender.before!,
              wall: d.wall.before ?? 0,
              // defSmithy is not stored in the report, so leave it out
            })
          }
        >
          🧪 Load into Simulator
        </button>
      )}
    </>
  );
}

function Scout({
  d,
  onGoto,
  onLoadSim,
}: {
  d: ScoutDetail;
  onGoto: (x: number, y: number) => void;
  onLoadSim?: (seed: {
    attacker?: Partial<Units>;
    defender?: Partial<Units>;
    wall?: number;
    defSmithy?: number;
  }) => void;
}) {
  if (!d.success)
    return (
      <>
        <div
          className="banner"
          style={{ borderColor: "#ff8a80", color: "#ff8a80" }}
        >
          🔍 Scouts intercepted
        </div>
        <p>
          All {d.sent} scouts sent to <b>{d.village}</b> ({xy(d.xy)}) were
          caught by its own scouts. You learned nothing.{" "}
          <Pin p={d.xy} onGoto={onGoto} />
        </p>
      </>
    );
  const tier = d.tier ?? 3;
  const locked = (what: string, need: string) => (
    <div className="warn">
      <small>
        🔒 {what} hidden — {need}
      </small>
    </div>
  );
  return (
    <>
      <div
        className="banner"
        style={{ borderColor: "#4dd0e1", color: "#4dd0e1" }}
      >
        🔍 {SCOUT_TIER_NAME[tier]} — {d.village} ({xy(d.xy)})
      </div>
      <Pin p={d.xy} onGoto={onGoto} />{" "}
      <small>
        {d.sent} scouts sent{d.lost > 0 ? `, ${d.lost} lost` : ", none lost"}.
        {d.enemyScouts !== undefined &&
          ` Enemy scouts: ${d.enemyScouts}${d.enemyLost ? ` (you killed ${d.enemyLost})` : ""}.`}
      </small>
      {tier < 3 && (
        <div className="ex">
          <small>
            To see more next time, bring more survivors than they have scouts:
            Recon needs at least half their number alive, a Full report needs as
            many as they have. Every enemy scout kills about{" "}
            {Math.round(SCOUT_KILL * 10) / 10} of yours, so send roughly 1.6×
            their scouts.
          </small>
        </div>
      )}
      <div className="rep" style={{ marginTop: 6 }}>
        <div className="wcard">
          <b>Troops in the village</b>
          {d.units ? (
            <>
              {sum(d.units) ? (
                <table>
                  <tbody>
                    {UNIT_IDS.filter((u) => d.units![u] > 0).map((u) => (
                      <tr key={u}>
                        <td>{UNITS[u].name}</td>
                        <td>{d.units![u]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div>Nobody is home.</div>
              )}
              {d.rating && (
                <div style={{ marginTop: 6 }}>
                  🛡{" "}
                  {ATTACK_CLASSES.map((k) => (
                    <span key={k} style={{ marginRight: 10 }}>
                      {CLASS_ICON[k]} {Math.round(d.rating![k])}
                    </span>
                  ))}
                </div>
              )}
              <small>🧱 Wall {d.wall}</small>
            </>
          ) : (
            locked("Troops and wall", "you need Recon")
          )}
          <div>
            <small>👑 Loyalty {Math.round(d.loyalty ?? 0)}</small>
          </div>
        </div>
        <div className="wcard">
          <b>Resources</b>
          <div>
            {RES.map((r) => (
              <span key={r} style={{ marginRight: 10 }}>
                {ICON[r]} {Math.floor(d.resources![r])}
              </span>
            ))}
          </div>
          <b style={{ display: "block", marginTop: 8 }}>Buildings</b>
          {d.buildings ? (
            <table>
              <tbody>
                {BUILDING_IDS.filter((b) => (d.buildings![b] ?? 0) > 0).map(
                  (b) => (
                    <tr key={b}>
                      <td>{BUILDINGS[b].name}</td>
                      <td>{d.buildings![b]}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          ) : (
            locked("Buildings", "you need a Full report")
          )}
        </div>
      </div>
      {d.units && onLoadSim && (
        <button
          style={{ marginTop: 8, width: "100%" }}
          onClick={() =>
            onLoadSim({
              defender: d.units!,
              wall: d.wall ?? 0,
            })
          }
        >
          🧪 Load into Simulator
        </button>
      )}
    </>
  );
}

export default function ReportView({
  report,
  onClose,
  onGoto,
  onLoadSim,
}: {
  report: Report;
  onClose: () => void;
  onGoto: (x: number, y: number) => void;
  onLoadSim?: (seed: {
    attacker?: Partial<Units>;
    defender?: Partial<Units>;
    wall?: number;
    defSmithy?: number;
  }) => void;
}) {
  const d = report.detail;
  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <b style={{ fontSize: 16 }}>Report</b>
          <span>
            <small>{new Date(report.at).toLocaleString()}</small>{" "}
            <button onClick={onClose}>✕</button>
          </span>
        </div>
        {!d && (
          <div style={{ marginTop: 8 }}>
            {report.text}
            <p>
              <small>
                This report was saved before detailed reports existed, so only
                the summary is available.
              </small>
            </p>
          </div>
        )}
        {d?.kind === "battle" && (
          <Battle d={d} onGoto={onGoto} onLoadSim={onLoadSim} />
        )}
        {d?.kind === "scout" && (
          <Scout d={d} onGoto={onGoto} onLoadSim={onLoadSim} />
        )}
      </div>
    </div>
  );
}
