---
name: verify-rendering
description: Check that three-map-terrain actually renders correctly in a browser — run the playground or the examples against real tile servers and inspect them with Playwright (and optionally the three.js devtools MCP). Use after changing src/, the material or texture code, three.js versions, lighting, or the examples, and whenever a task says "make sure the map still works / looks right".
---

# Verify rendering

Unit tests run in Node without WebGL; `yarn test:e2e` renders in Chromium but
with synthetic tiles. This skill covers the remaining gap: **real data, real
look**.

## 1. Automated baseline

```bash
yarn test:e2e
```

It runs `e2e/render.spec.ts` against the playground for `renderer=webgl` and
`renderer=webgpu`:

- 3×3 grid loads, every tile gets its stitched texture, no console/page errors
  (shader compile errors surface as console errors);
- top-down unlit view checks the child texture layout `NW | NE / SW | SE`
  pixel-exactly (and the sRGB color pipeline via a mid-gray quadrant);
- `wireframe=1` draws lines carrying each quadrant's texture with the
  background visible between them;
- a click on a known point returns the right geolocation and altitude
  (`map.pick`);
- truncated texture responses are re-requested, and fall back to `<img>`
  when every attempt is truncated;
- buildings from a mocked OpenFreeMap (TileJSON + MVT) stand on the terrain
  in the map's color and are picked by a click;
- terrain without imagery (`api=none`) loads no texture and is drawn in
  `color`, buildings in the same tone;
- `setSource()` + `setMaterial()` in one go (a look switch) ends in the
  second's style: wireframe lines in the new color;
- `map.export('glb')` writes a GLB with the stitched texture embedded.

Unit tests cover the loading-time invariants that are hard to see in a
browser: no walls or cracks while tiles stream in, seams and corners after
every step, `heightAt` against `Raycaster`.

The WebGPU tests report the backend that actually ran in their annotations:
`webgpu` on a real GPU, `webgpu (webgl2 backend)` where the adapter is
SwiftShader (Playwright's headless shell, GPU-less CI) — three's WebGPU
backend fails there, so the tests force the WebGL2 backend. To exercise real
WebGPU locally, run the tests against Chrome (`channel: 'chrome'`).

## 2. Playground with real tiles

```bash
yarn dev    # vite playground → http://localhost:5173
```

Query parameters:

| Param                | Values                                     | Default  | Purpose                                                            |
| -------------------- | ------------------------------------------ | -------- | ------------------------------------------------------------------ |
| `renderer`           | `webgl`, `webgpu`                          | `webgl`  | renderer under test                                                |
| `forceWebGL`         | `1`                                        | —        | `WebGPURenderer` with its WebGL2 backend                           |
| `lights`             | `1`, `0`                                   | `1`      | `MeshLambertMaterial` vs unlit basic                               |
| `wireframe`          | `1`                                        | —        | `wireframe` material option                                        |
| `api`                | `eox`, `osm`, `swisstopo`, `none`          | `eox`    | texture source (`swisstopo`: a `url` template; `none`: no imagery) |
| `color`              | hex without `#`                            | —        | `material.color` (a tint, or the plain terrain)                    |
| `filter`             | CSS filter                                 | —        | `material.filter`, e.g. `grayscale(1)`                             |
| `elevation`          | `aws`, `mapterhorn`, …                     | `aws`    | elevation source                                                   |
| `buildings`          | `openfreemap`, `versatiles`, `overpass`, … | —        | the `Buildings` layer; `token=…` for keyed ones                    |
| `edges`              | `1`                                        | —        | buildings' `edges`                                                 |
| `zoom`, `lat`, `lon` | numbers                                    | Alps, 11 | another place or zoom: drawn true to scale (`exaggeration=…`)      |
| `base`               | meters                                     | `0`      | `baseAltitude`                                                     |
| `nTiles`             | integer                                    | `3`      | grid size                                                          |
| `segments`           | integer                                    | `100`    | `tileSegments` (try `40` with `wireframe=1`)                       |
| `view`               | `orbit`, `top`                             | `orbit`  | perspective + MapControls, or orthographic top view                |

`window.__playground` exposes `{ map, buildings, revision, backend, ready, texturedTiles(), lastPick, lastBuilding, freeze() }` — e.g. `__playground.map.setMaterial({ wireframe: true })` or `await __playground.map.export('glb')` from the console.

Buildings and looks, with real data:

- `?zoom=15&lat=46.515&lon=6.632&elevation=mapterhorn&buildings=openfreemap&edges=1&api=none&color=f2ede5&base=372`
  — Lausanne as a plain model: buildings on the slopes (never floating,
  never buried, the walls reaching the ground), courtyards open, the city
  cut cleanly at the grid edge. `api=swisstopo&filter=grayscale(1)` for the
  aerial look, `wireframe=1&segments=48` for lines (buildings as edges).
- Clicking a building highlights it and shows its height (`lastBuilding`).
- Switch looks at runtime from the console (`setSource`, `setMaterial`)
  several times, back and forth: the terrain, buildings and base must
  always end in the last style.

Clicking the terrain runs `map.pick` (geolocation + altitude shown in the
overlay, stored in `lastPick`) and moves the yellow marker there with
`map.getTerrainPositionSync`: it must rest exactly on the surface.

With the **playwright** MCP server:

1. `browser_navigate` to `http://localhost:5173/?renderer=webgl`.
2. Wait until `window.__playground.texturedTiles() === 9` (`browser_evaluate`).
3. `browser_console_messages` — must contain `Map is ready` and no errors or
   `Multiple instances of Three.js` warnings.
4. `browser_take_screenshot` and look at it. Expect: satellite imagery of the
   Bernese Alps draped on relief, no black or rainbow (placeholder) tiles, no
   visible cracks between tiles, red marker sphere above the center (3000 m)
   and the yellow one resting in the Grindelwald valley (≈1050 m).
5. `browser_click` the terrain: the overlay shows `lat, lon · N m` and the
   yellow marker moves there, sitting on the surface.
6. Repeat with `renderer=webgpu`, and `lights=0`.
7. To see the loading state, hold some elevation tiles (e.g. a route that
   delays `**/terrarium/**`): loaded tiles must never show walls down to
   z = 0 or gaps between each other.

With the **threejs-devtools** MCP server (opens its own proxied tab of the dev
server on `DEV_PORT=5173`): `scene_tree` should show a `Group` with 9 meshes
using `MeshLambertMaterial` whose `map` is a 512×512 `CanvasTexture`.

## 3. Examples

```bash
yarn build                                  # examples use dist/
(cd examples/basic && yarn start)           # webpack-dev-server, port 8080
(cd examples/react && yarn dev)             # vite, port 5173 (the live example)
```

Same checklist as above. The React example runs in `StrictMode`, so
`init → clean → init` happens on mount — there must be exactly 9 tiles and no
errors about aborted requests.

- React (`?place=lausanne&look=plain|aerial|wireframe`): switch the looks
  back and forth (e.g. wireframe → plain → wireframe, and through aerial) —
  every look must be complete each time; the footer credits follow. A click
  on a building highlights it and shows its height; on the terrain, the
  yellow sphere sits on the surface. Rotate to see the base's section.
- Basic (San Francisco): Overture buildings on a grayscale map with a base;
  a click names the building (Overture `@name`).
- In both, "Download GLB / STL" must save files; check a GLB with the
  Khronos glTF validator (`npx gltf-validator file.glb`, or its npm API):
  0 errors, the textures embedded.

The heaviest user of the library is the GPX Terrain app
([whidrubeld/gpx-terrain](https://github.com/whidrubeld/gpx-terrain)): for
changes to positions, picking or materials, also run it against the local
build (`yarn link` here, `yarn link three-map-terrain` there) with its
`verify-app` skill.

## 4. Report

Attach or describe the screenshots, list console errors verbatim, and state
which renderer/backends were actually exercised.
