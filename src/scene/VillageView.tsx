import { MapControls } from "@react-three/drei";
import { useState } from "react";
import { BUILDING_IDS } from "../game/config/buildings";
import type { BuildingId } from "../game/core/types";
import { useGame } from "../game/store";

const COLORS: Record<string, string> = {
  main: "#c9a227",
  barracks: "#a33",
  academy: "#a3f",
  farm: "#dd6",
  stable: "#b74",
  smithy: "#4a6a8a",
  rally: "#d33",
  statue: "#cc9",
  market: "#e0a030",
  hiding: "#6d4c41",
  workshop: "#864",
  timber: "#5a3",
  clay: "#c64",
  iron: "#889",
  warehouse: "#a85",
  wall: "#777",
};

export default function VillageView() {
  const village = useGame((s) => s.villages[s.activeId]);
  const selected = useGame((s) => s.selectedBuilding);
  const select = useGame((s) => s.selectBuilding);
  const is2d = useGame((s) => s.mode === "2d");
  const [hover, setHover] = useState<BuildingId | null>(null);
  return (
    <>
      <MapControls
        enableRotate={!is2d}
        maxPolarAngle={Math.PI / 2.4}
        minDistance={6}
        maxDistance={36}
        minZoom={15}
        maxZoom={80}
        screenSpacePanning={is2d}
      />
      {/* clicking empty ground deselects */}
      <mesh rotation-x={-Math.PI / 2} onClick={() => select(null)}>
        <circleGeometry args={[13, 48]} />
        <meshStandardMaterial color="#3e5a22" />
      </mesh>
      {BUILDING_IDS.map((id, i) => {
        const a = (i / BUILDING_IDS.length) * Math.PI * 2;
        const r = id === "main" ? 0 : 7.5;
        const lvl = village.buildings[id];
        // 3D: level = height. 2D: flat tile, level = footprint size. Unbuilt = ghosted.
        const built = lvl > 0;
        const h = is2d ? 0.2 : 0.6 + lvl * 0.25;
        const side = is2d ? 1.4 + lvl * 0.1 : 1.8;
        const glow = selected === id ? 0.45 : hover === id ? 0.25 : 0;
        return (
          <mesh
            key={id}
            position={[Math.cos(a) * r, h / 2, Math.sin(a) * r]}
            onClick={(e) => {
              e.stopPropagation();
              select(id);
            }}
            onPointerOver={(e) => {
              e.stopPropagation();
              setHover(id);
              document.body.style.cursor = "pointer";
            }}
            onPointerOut={() => {
              setHover(null);
              document.body.style.cursor = "auto";
            }}
          >
            <boxGeometry args={[side, h, side]} />
            <meshStandardMaterial
              color={COLORS[id]}
              transparent
              opacity={built ? 1 : 0.35}
              emissive="#ffffff"
              emissiveIntensity={glow}
            />
          </mesh>
        );
      })}
    </>
  );
}
