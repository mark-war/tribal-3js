import { useGame } from "../game/store";

export function WorldNews() {
  const news = useGame((s) => s.news);
  if (!news.length) return <div>No news from the world yet.</div>;
  return (
    <div style={{ maxHeight: 240, overflowY: "auto" }}>
      {news.map((n) => (
        <div key={n.id}>
          <small>{new Date(n.at).toLocaleTimeString()}</small> {n.text}
        </div>
      ))}
    </div>
  );
}
