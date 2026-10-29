import { Line, MapControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { CHUNK, PLAYER, chunkVillages, rivalInfo } from "../game/core/world";
import { kindColor } from "../ui/icons";
import type { Command, Village } from "../game/core/types";
import { useGame } from "../game/store";

const TILE = 2;
const VIEW_CHUNKS = 3;
const tmp = new THREE.Object3D();
const col = new THREE.Color();

function Villages({ list }: { list: Village[] }) {
  const ref = useRef<THREE.InstancedMesh>(null!);
  const select = useGame((s) => s.selectTarget);
  const is2d = useGame((s) => s.mode === "2d");
  useEffect(() => {
    list.forEach((v, i) => {
      const h = is2d ? 0.2 : 0.5 + v.points / 700;
      const w = is2d ? 0.8 + v.points / 1500 : 1;
      tmp.position.set(v.x * TILE, h / 2, v.y * TILE);
      tmp.scale.set(w, h, w);
      tmp.updateMatrix();
      ref.current.setMatrixAt(i, tmp.matrix);
      ref.current.setColorAt(
        i,
        col.set(
          v.owner === PLAYER
            ? "#3b82f6"
            : (() => {
                const r = rivalInfo(v.owner);
                return r ? (r.nemesis ? "#ff1744" : r.color) : "#9a7b4f";
              })(),
        ),
      );
    });
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
    ref.current.count = list.length;
    // three.js caches the bounding sphere used for clicking AND culling; without this, villages that were not in the first batch can never be clicked
    ref.current.computeBoundingSphere();
  }, [list, is2d]);
  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, 4096]}
      onClick={(e) => {
        e.stopPropagation();
        if (e.instanceId != null) select(list[e.instanceId]);
      }}
    >
      <boxGeometry args={[1.2, 1, 1.2]} />
      <meshStandardMaterial />
    </instancedMesh>
  );
}

function Marker({ c }: { c: Command }) {
  const ref = useRef<THREE.Mesh>(null!);
  useFrame(() => {
    const t = THREE.MathUtils.clamp(
      (Date.now() - c.departAt) / (c.arriveAt - c.departAt),
      0,
      1,
    );
    ref.current.position.set(
      THREE.MathUtils.lerp(c.fromXY[0], c.toXY[0], t) * TILE,
      1.5,
      THREE.MathUtils.lerp(c.fromXY[1], c.toXY[1], t) * TILE,
    );
  });
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.35]} />
      <meshBasicMaterial color={kindColor(c.clan ? "raid" : c.kind)} />
    </mesh>
  );
}

export default function WorldMap() {
  const ctrl = useRef<any>(null);
  const [key, setKey] = useState("0,0");
  const is2d = useGame((s) => s.mode === "2d");
  const own = useGame((s) => s.villages);
  const commands = useGame((s) => s.commands);
  const target = useGame((s) => s.target);
  const activeId = useGame((s) => s.activeId);
  const setCursor = useGame((s) => s.setCursor);
  const pickTile = useGame((s) => s.pickTile);
  const picked = useGame((s) => s.picked);
  const focus = useGame((s) => s.focus);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    // "show on map" from a report: slide the camera to that village
    if (!focus || !ctrl.current) return;
    const t = ctrl.current.target;
    const off = camera.position.clone().sub(t);
    t.set(focus.x * TILE, 0, focus.y * TILE);
    camera.position.copy(t).add(off);
    ctrl.current.update();
    useGame.setState({ focus: null });
  }, [focus]);
  useFrame(() => {
    const t = ctrl.current?.target;
    if (!t) return;
    const k = `${Math.floor(t.x / TILE / CHUNK)},${Math.floor(t.z / TILE / CHUNK)}`;
    if (k !== key) setKey(k);
  });
  const list = useMemo(() => {
    const [cx, cy] = key.split(",").map(Number);
    const m = new Map<string, Village>();
    for (let x = cx - VIEW_CHUNKS; x <= cx + VIEW_CHUNKS; x++)
      for (let y = cy - VIEW_CHUNKS; y <= cy + VIEW_CHUNKS; y++)
        chunkVillages(x, y, 0).forEach((v) => m.set(v.id, v));
    Object.values(own)
      .filter((v) => v.owner === PLAYER || rivalInfo(v.owner))
      .forEach((v) => m.set(v.id, v)); // player villages override
    return [...m.values()];
  }, [key, own]);
  return (
    <>
      <MapControls
        ref={ctrl}
        enableRotate={!is2d}
        maxPolarAngle={Math.PI / 2.6}
        minDistance={8}
        maxDistance={120}
        minZoom={4}
        maxZoom={80}
        screenSpacePanning={is2d}
      />
      <mesh
        rotation-x={-Math.PI / 2}
        position-y={-0.01}
        onPointerMove={(e) =>
          setCursor(Math.round(e.point.x / TILE), Math.round(e.point.z / TILE))
        }
        onClick={(e) =>
          pickTile(Math.round(e.point.x / TILE), Math.round(e.point.z / TILE))
        }
      >
        <planeGeometry args={[40000, 40000]} />
        <meshStandardMaterial color="#3e5a22" />
      </mesh>
      {picked && (
        <mesh
          rotation-x={-Math.PI / 2}
          position={[picked.x * TILE, 0.06, picked.y * TILE]}
        >
          <ringGeometry args={[1.1, 1.3, 32]} />
          <meshBasicMaterial color="#ffd54f" />
        </mesh>
      )}
      <gridHelper args={[2000, 1000, "#2b3d17", "#2b3d17"]} />
      <Villages list={list} />
      {target && own[activeId] && target.id !== activeId && (
        <Line
          points={[
            [own[activeId].x * TILE, 0.3, own[activeId].y * TILE],
            [target.x * TILE, 0.3, target.y * TILE],
          ]}
          color="#ffd54f"
          lineWidth={2}
          dashed
          dashSize={0.6}
          gapSize={0.4}
        />
      )}
      {commands.map((c) => (
        <Line
          key={"l" + c.id}
          points={[
            [c.fromXY[0] * TILE, 0.2, c.fromXY[1] * TILE],
            [c.toXY[0] * TILE, 0.2, c.toXY[1] * TILE],
          ]}
          color={kindColor(c.clan ? "raid" : c.kind)}
          lineWidth={1}
          transparent
          opacity={0.45}
        />
      ))}
      {commands.map((c) => (
        <Marker key={c.id} c={c} />
      ))}
    </>
  );
}
