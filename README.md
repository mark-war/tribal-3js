# Tribal 3JS

React + @react-three/fiber + zustand + Vite.

    npm install && npm run dev

## Architecture
- `src/game/config/*`  data-driven buildings/units — add content by editing tables.
- `src/game/core/*`    PURE TypeScript sim (economy, combat, deterministic world). No React/Three imports,
                       so it can run unchanged in a Node server for authoritative multiplayer.
- `src/game/store.ts`  client state + command/battle resolution.
- `src/scene/*`        Three.js views (village, chunked world map with InstancedMesh).
- `src/ui/*`           React HUD overlay.

## Scaling ideas baked in
1. Lazy settlement: villages fast-forward on demand, never per-tick.
2. Deterministic seeded world in chunks: nothing stored for empty land, map streams by camera.
3. Instanced rendering: thousands of villages in one draw call.
4. Timestamps not timers: every queue/march is `finishesAt`/`arriveAt`, so a server can own truth.

## Next steps
Server (Node + WebSocket/Postgres) running `core/`, auth, alliances, scouting/noble units, reports UI, GLTF models, fog of war.
