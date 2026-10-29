import { Canvas } from "@react-three/fiber";
import { useEffect } from "react";
import VillageView from "./scene/VillageView";
import WorldMap from "./scene/WorldMap";
import Hud from "./ui/Hud";
import { useGame } from "./game/store";
import { startAdvisor } from "./ai/driver";

export default function App() {
  const view = useGame((s) => s.view);
  const mode = useGame((s) => s.mode);
  const tick = useGame((s) => s.tick);
  useEffect(() => {
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [tick]);
  useEffect(() => startAdvisor(), []); // optional AI advisor for the bots (does nothing unless you switch it on)
  const is2d = mode === "2d";
  // 2D = orthographic camera looking straight down (tiny z offset avoids a degenerate up-vector).
  const camera = is2d
    ? {
        position: [0, 60, 0.001],
        zoom: view === "world" ? 14 : 30,
        near: 0.1,
        far: 500,
      }
    : { position: view === "world" ? [10, 30, 25] : [0, 12, 12], fov: 50 };
  return (
    <>
      <Canvas key={view + mode} orthographic={is2d} camera={camera as any}>
        <ambientLight intensity={is2d ? 1.4 : 0.7} />
        {!is2d && <directionalLight position={[20, 30, 10]} intensity={1.1} />}
        {view === "village" ? <VillageView /> : <WorldMap />}
      </Canvas>
      <Hud />
    </>
  );
}
