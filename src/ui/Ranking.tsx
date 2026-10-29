import { useState } from "react";
import { worldAgeHours } from "../game/core/economy";
import { buildRanking } from "../game/core/ranking";
import { useGame } from "../game/store";
import { dur } from "./fmt";

type Key = "points" | "villages" | "kills" | "looted" | "sent";
const TABS: [Key, string][] = [
  ["points", "Points"],
  ["villages", "Villages"],
  ["kills", "Kills"],
  ["looted", "Looted"],
  ["sent", "Resources sent"],
];
const n = (x: number) => x.toLocaleString();

/** Who is leading the world: you and the 100 bots. */
export default function Ranking({
  onClose,
  onGoto,
}: {
  onClose: () => void;
  onGoto: (x: number, y: number) => void;
}) {
  const { villages, stats, news, rivals } = useGame();
  const [tab, setTab] = useState<"rank" | "news">("rank");
  useGame((s) => s.now);
  const [key, setKey] = useState<Key>("points");
  const rows = buildRanking(
    villages,
    stats,
    worldAgeHours(),
    Date.now(),
    rivals,
  ).sort((a, b) => b[key] - a[key] || b.points - a.points);
  const me = rows.findIndex((r) => r.you);
  const leader = rows[0];
  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <b style={{ fontSize: 16 }}>🏆 World ranking</b>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="tabs">
          <button
            className={tab === "rank" ? "on" : ""}
            onClick={() => setTab("rank")}
          >
            🏆 Ranking
          </button>
          <button
            className={tab === "news" ? "on" : ""}
            onClick={() => setTab("news")}
          >
            📰 World news ({news.length})
          </button>
        </div>
        {tab === "news" && (
          <div style={{ maxHeight: "60vh", overflow: "auto" }}>
            {news.length === 0 ? (
              <p>
                Quiet so far. Bots fight each other and conquer villages as the
                world grows.
              </p>
            ) : (
              news.map((n, i) => (
                <div key={i} className="report info">
                  <div>{n.text}</div>
                  <small>{dur(Date.now() - n.at)} ago</small>
                </div>
              ))
            )}
          </div>
        )}
        {tab === "rank" && (
          <>
            <div>
              👑 Leading by {TABS.find((t) => t[0] === key)![1].toLowerCase()}:{" "}
              <b>{leader.name}</b> ({n(leader[key])}). You are <b>#{me + 1}</b>{" "}
              of {rows.length}.
            </div>
            <div className="tabs wrap" style={{ marginTop: 6 }}>
              {TABS.map(([k, l]) => (
                <button
                  key={k}
                  className={k === key ? "on" : ""}
                  onClick={() => setKey(k)}
                >
                  {l}
                </button>
              ))}
            </div>
            <div style={{ maxHeight: "55vh", overflow: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Player</th>
                    <th>Style</th>
                    <th>Villages</th>
                    <th>Points</th>
                    <th>Kills</th>
                    <th>Looted</th>
                    <th>Sent</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={r.name}
                      style={
                        r.you
                          ? { background: "rgba(59,130,246,.25)" }
                          : undefined
                      }
                    >
                      <td>{i + 1}</td>
                      <td>
                        <span className="badge" style={{ background: r.color }}>
                          {r.name}
                        </span>
                        {r.nemesis && " 😈"}
                        {r.eliminated && " ☠"}
                      </td>
                      <td>
                        <small>{r.doctrine ?? ""}</small>
                      </td>
                      <td>{r.villages}</td>
                      <td>{n(r.points)}</td>
                      <td>{n(r.kills)}</td>
                      <td>{n(r.looted)}</td>
                      <td>{n(r.sent)}</td>
                      <td>
                        {r.home && (
                          <button
                            className="pin"
                            title="Show on the map"
                            onClick={() => onGoto(r.home![0], r.home![1])}
                          >
                            📍
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {tab === "rank" && (
          <small>
            Your numbers are exact. A bot's kills, looted and sent are an
            estimate of its off-screen life (farming barbarians, trading between
            bots) plus every real event with you.
          </small>
        )}
      </div>
    </div>
  );
}
