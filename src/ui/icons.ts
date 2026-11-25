/** One place for how each kind of march is drawn. */
const ICON: Record<string, string> = {
  attack: "⚔️",
  scout: "🔍",
  support: "🛡",
  trade: "🏪",
  raid: "🚩",
  expand: "🏰",
  strike: "🚩",
  rally: "📯",
  paladin_move: "🦸",
  return: "🏠",
};
const COLOR: Record<string, string> = {
  attack: "#ef5350",
  scout: "#4dd0e1",
  support: "#42a5f5",
  trade: "#ffd54f",
  raid: "#b71c1c",
  expand: "#b71c1c",
  strike: "#b71c1c",
  rally: "#ffa726",
  paladin_move: "#ffd54f",
  return: "#66bb6a",
};
export const kindIcon = (k: string) => ICON[k] ?? "•";
export const kindColor = (k: string) => COLOR[k] ?? "#ffffff";
