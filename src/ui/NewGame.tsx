import { useState } from "react";
import type { RivalMode } from "../game/core/rivals";
import { useGame } from "../game/store";

const MODES: [RivalMode, string][] = [
  ["off", "🚫 Rivals off"],
  ["peace", "😴 Peaceful"],
  ["retaliate", "🛡 Hit back only"],
  ["raids", "⚔ Raids"],
  ["war", "👑 War (like players)"],
];

/** Erase the saved game and begin a new journey. (Later this is where a game mode, solo journey or multiplayer, gets picked.) */
export default function NewGame({ onClose }: { onClose: () => void }) {
  const { newGame, gameSpeed, rivalMode, villages, stats, worldClock } =
    useGame();
  const [speed, setSpeed] = useState(gameSpeed);
  const [mode, setMode] = useState<RivalMode>(rivalMode);
  const [name, setName] = useState("");
  const [sure, setSure] = useState(false);
  const mine = Object.values(villages).filter((v) => v.owner === "Chek").length;
  const kills = stats.Chek?.kills ?? 0;

  return (
    <div className="modal" onClick={onClose}>
      <div
        className="box"
        style={{ width: "min(520px,94vw)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row">
          <b style={{ fontSize: 16 }}>🆕 New game</b>
          <button onClick={onClose}>✕</button>
        </div>
        <p>
          This <b>erases your saved game</b>: {mine} village
          {mine === 1 ? "" : "s"}, every army and report, your ranking and
          scores ({kills} kills), and the world starts again from day one:{" "}
          <b>the bots start as newcomers too</b>. Your 2D/3D choice and your
          saved War Table presets are kept.
        </p>
        <div className="wcard">
          <div className="row">
            <span>Village name</span>
            <input
              placeholder="Chek's Village"
              maxLength={24}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="row">
            <span>Game speed</span>
            <select
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              <option value={1}>⏱ Real time (×1)</option>
              <option value={10}>⏱ ×10</option>
              <option value={60}>⏱ ×60</option>
              <option value={600}>⏱ ×600</option>
            </select>
          </div>
          <div className="row">
            <span>Rivals</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as RivalMode)}
            >
              {MODES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <small>
            You can change speed and rivals later from the top bar. The world
            has been running for {Math.round(worldClock.age)} game hours.
          </small>
        </div>
        {!sure ? (
          <button
            style={{ width: "100%", marginTop: 8 }}
            onClick={() => setSure(true)}
          >
            Start a new game…
          </button>
        ) : (
          <button
            style={{ width: "100%", marginTop: 8, background: "#a33" }}
            onClick={() => {
              newGame({ speed, mode, name });
              onClose();
            }}
          >
            Yes, erase everything and start over
          </button>
        )}
        {sure && (
          <small className="warn">
            This can't be undone. Click the red button to confirm, or close this
            window.
          </small>
        )}
      </div>
    </div>
  );
}
