# AGENTS.md

Guidance for AI coding agents working on **three-map-terrain** — a
TypeScript library that builds 3D terrain and buildings for
[three.js](https://threejs.org) from map tiles of any source (elevation,
imagery, vector tiles / OpenStreetMap buildings), and exports them as model
files. Published to npm as `three-map-terrain`.

## Layout

```
src/                      library (the only published code, plus dist/)
  index.ts                public API = the folders' index.ts barrels
  terrain/                the terrain grid
    Map.class.ts          Map: grid, loading, seams, positions, layers (MapLayer),
                          setSource/setMaterial, whenReady, export
    Tile.class.ts         Tile: elevation → PlaneGeometry, texture (re)loading, seams
    quad-texture-material.ts  4 child tiles → one CanvasTexture; MaterialOptions
  color-filter.ts       (internal) the imagery `filter`: CSS color functions → pixels
    TerrainBase.class.ts  layer: side walls + bottom (diorama block)
  sources/                where terrain tiles come from
    tile-source.ts        TileRequest, URL templates, fallback to ancestors
    Source.class.ts       imagery: presets / url / load / none
    ElevationSource.class.ts  elevation: presets / url + encoding / load
  buildings/              the Buildings layer
    Buildings.class.ts    layer: ownership, grounding, clip, meshes + edges, pick
    BuildingSource.class.ts  presets (MVT, Overpass), url / tilejson / load
    features.ts           BuildingFeature, vector tile → buildings, schemas, clipping
    geometry.ts           extrusion into one geometry (faces + edges) per tile
    osm.ts                OSM tags → heights, Overpass JSON → features
  io/                     network and formats
    fetch.ts              (internal) fetch with retries, HttpError
    image.ts              (internal) createImageBitmap + canvas helpers
    mvt.ts                vector tile (MVT) decoder (public), gunzip
  geo/Utils.class.ts      Web Mercator tile math
  export/model.ts         exportModel: three.js exporters, loaded on demand
test/                     Vitest unit tests (Node, no WebGL), mirroring src/;
                          test/support: fakes, terrarium + MVT encoders
e2e/                      Playwright tests against playground/ with mocked tile servers
playground/               `yarn dev` app; query params documented in .skills/verify-rendering
examples/basic            plain three.js + webpack: San Francisco, Overture
                          buildings via a custom PMTiles source
examples/react            React Three Fiber + drei + Vite; the live example
                          (GitHub Pages, deployed from master): Alps, Lausanne
docs/                     README images (WebP) of the examples: `yarn screenshots`
scripts/screenshots.mjs   renders them from the built examples (Chrome + cwebp)
.skills/                  agent skills (symlinked as .claude/skills)
```

## Commands (Yarn classic 1.x, Node 24)

```bash
yarn                 # install
yarn dev             # playground on http://localhost:5173
yarn typecheck       # tsc --noEmit over src, test, e2e, playground, configs
yarn lint            # eslint (typescript-eslint strictTypeChecked + stylistic)
yarn format          # prettier --write   (format:check in CI)
yarn test            # vitest unit tests  (test:watch, test:coverage)
yarn test:e2e        # playwright; first time: yarn playwright install chromium
yarn build           # vite lib build (dist/index.mjs + index.js) + tsc declarations
yarn validate        # typecheck + lint + format:check + test + build
```

Do **not** name a script `check`: `yarn check` is a built-in Yarn 1 command.

The examples have their own `package.json`/`yarn.lock` and link the library
with `link:../..` — run `yarn build` in the root before installing/building them.

The full app built with the library — **GPX Terrain**, a GPX viewer and the
library's showcase (README hero image) — lives in its own repository,
[whidrubeld/gpx-terrain](https://github.com/whidrubeld/gpx-terrain), and
depends on the published package. After a release, bump it there.

## How it works (read before touching src/)

- `Map.init()` creates an `nTiles × nTiles` grid of `Tile`s around the
  location's tile at `zoom`, loads them in parallel, then stitches seams.
  It resolves (and calls the optional callback) when geometry is ready;
  textures stream in afterwards (a wireframe `MeshNormalMaterial` placeholder
  is shown meanwhile).
- **Sources** (`src/sources/`): `Source` (imagery), `ElevationSource` and
  `BuildingSource` all take a preset `api`, a URL template (`expandTileUrl`)
  or a `load`. `loadWithFallback` loads a tile, or — beyond `maxZoom`, or
  when it is missing (404 → `null`) — its nearest ancestor (≤ 6 levels) and
  the tile's `region` in it: elevation is cropped and bilinearly upsampled
  (`Tile.cropElevation`), textures are cut out with `drawImage`. Children
  sharing an ancestor load it once (`memo`). `{ api: 'none' }` (also the
  default without `source`) loads no texture: a plain material in `color`.
- **Loading** (`src/io/`): transient failures — network errors, HTTP
  408/425/429/5xx and bodies `createImageBitmap` cannot decode (tile servers,
  EOX in particular, sometimes send truncated bodies with status 200) — are
  retried with backoff `RETRY_DELAYS` (250 ms, 1 s, 3 s) and `cache: 'reload'`
  so the browser cache cannot replay a broken body. Aborts and other 4xx are
  not retried. If a texture is still undecodable, `<img>` renders the part
  that arrived; elevation never falls back (partial heights = bogus terrain).
- **Elevation**: RGB tiles decoded by the source's `decode` (terrarium
  `R*256 + G + B/256 - 32768`, Mapbox `(R*65536 + G*256 + B)*0.1 - 10000`)
  with `createImageBitmap(..., { colorSpaceConversion: 'none' })` + canvas
  `getImageData`. Never let color management touch these pixels. Vertex
  `z = (elevation - baseAltitude) * zScale`; `exaggeration` sets `zScale`
  from `Utils.tileWidth`.
- **Geometry**: the last row/column of each `PlaneGeometry` lies on the
  east/south neighbours' first pixels. It is first approximated from the
  tile's own edge pixels (never `z = 0`, so no walls while loading), then
  `resolveSeams` copies it from loaded neighbours. `Map` stitches every tile
  the moment it loads, before adding it to the scene: the tile plus its
  W/N/NW neighbours in descending `x + y` (neighbours first), then
  `syncCorner` gives each 4-tile corner one value (the exact pixel of the
  tile whose top-left it is, else the best loaded approximation). The
  "never shows walls or cracks while tiles are still loading" test guards this.
- **Texture**: each tile is textured with its four children at `zoom + 1`,
  drawn into one 2×2 canvas (`NW | NE / SW | SE`, `flipY` maps canvas top to
  north) → `CanvasTexture` with `SRGBColorSpace` → `MeshLambertMaterial`
  (`lights: true`) or `MeshBasicMaterial`, with `color` (a tint). No custom
  shaders on purpose: they break between three.js releases and don't run on
  `WebGPURenderer`.
- **Filter**: material colors can only tint, so `filter` (CSS color
  functions: grayscale, sepia, saturate, hue-rotate, invert, opacity,
  brightness, contrast) is baked into the stitched canvas on the CPU
  (`color-filter.ts`): each function is its color matrix from the Filter
  Effects spec, in sRGB on non-premultiplied pixels, clamped after every
  step — within 1/255 of Chrome's canvas filter. Never use the canvas
  `filter`: Safari has none (none at all on `OffscreenCanvas`). An invalid
  filter is ignored with one warning, as CSS does.
- **Runtime style**: `setSource` reloads every placed tile's texture
  (`buildmesh`: a generation counter and a per-texture `AbortController`
  drop superseded loads; the old material stays until the new one is in and
  is then disposed). `setMaterial` restyles (`Tile.restyle`: a new material
  on the same texture) unless `filter` changed. A material prepared before a
  `restyle` is rebuilt with the current options before it is applied
  (`styleGeneration`) — `setSource()` then `setMaterial()` in one tick must
  end in the second's style (unit + e2e tests guard this). Layers follow
  through `materialChanged`.
- **Positions** (all in `map.terrain` coordinates):
  - `getPosition({ lat, lon, alt })` → `x`/`y` from the tile grid, `z` from
    `(alt - baseAltitude) * zScale`.
  - `getTerrainPosition` (async) waits for the tile's load promise
    (`Map.loads`); `getTerrainPositionSync` returns `undefined` until the tile
    is loaded. Both take `z` from `Tile.heightAt(u, v)`, which interpolates
    over the mesh triangles (PlaneGeometry splits each cell along the
    bottom-left → top-right diagonal). Tests compare it with `Raycaster`.
  - `getLocation({ x, y, z })` inverts `getPosition`. Tiles sit on a grid
    around the center tile's `tile2position` — which is shifted by half a tile
    for odd center tiles at zoom < 10, so never assume the center tile is at
    the origin (covered by the zoom 9 round-trip test).
  - `pick(raycaster)` intersects `map.terrain.children` and converts the hit
    with `worldToLocal` + `getLocation`. `Tile.updateGeometry()` must follow
    any height change: it refreshes normals and the bounding box/sphere that
    raycasting and frustum culling rely on.
- **Lifecycle**: `Tile.dispose()` aborts in-flight requests (`AbortController`)
  and disposes geometry/material/texture; `Map.clean()` disposes every tile.
  Results that arrive after disposal are discarded. The shared placeholder
  material is never disposed. `Map.whenReady()` waits for the grid, tiles
  loaded since, textures (`Tile.whenTextured`) and layers' `whenReady`.
- **Layers** (`MapLayer`): `addLayer` calls `attach`, then `tileLoaded` for
  the placed tiles; `fetchAndPlace` calls `tileLoaded` after stitching and
  adding the mesh; `clean()` calls `tileRemoved` before disposing. Hooks are
  wrapped (`notify`): a failing layer never breaks the terrain. Layers
  survive `clean()` (React StrictMode: init → clean → init). Their objects
  live in groups under `map.terrain`; `map.pick` intersects
  `terrain.children` non-recursively, so it never hits them.
- **Buildings** (`src/buildings/`):
  - A source tile is at `clamp(terrain zoom, minZoom, maxZoom)`; deeper
    terrain shares one request (`acquire`/`release` with refcounts and an
    `AbortController`), shallower terrain loads up to 4² children.
  - A building belongs to the terrain tile its anchor (bbox center of the
    first outer ring) lies in — drawn once, whole, even if sources return it
    for every tile it touches. With `clip` (default) an anchor outside the
    grid (`map.grid`) is clamped into it and the footprint is cut at the
    grid edge (`clipRect`): clean edges, no gaps. Inside the grid nothing is
    cut (pieces would be grounded separately: roof steps).
  - Vector tile features are split per polygon (tile generators merge
    equal buildings into one multi-polygon; such ids are dropped) and
    clipped to their tile (buffers would draw twice).
  - Grounding: the ground is sampled along the outer walls every half
    terrain segment (`Tile.heightAt`, neighbours if loaded); walls from 0.5 m
    below the lowest point, the roof `height` above it and at least 3 m
    above the highest; `minHeight > 0` floats with a floor.
  - One `Mesh` (faces, vertex colors, flat normals) per terrain tile, and
    `LineSegments` of the edges with `edges` or in wireframe (then the mesh
    is hidden but still picked). `starts`/`lineStarts` map vertices to
    features for `pick`/`highlight`. Styles come from the map's material
    options unless given (`setupStyle`); `materialChanged` rebuilds.
  - MVT decoding is our own (`io/mvt.ts`, checked against
    `@mapbox/vector-tile` on real tiles); int64 values are read in halves.
- **TerrainBase**: rebuilt from all placed tiles on every tile event — walls
  along sides without a placed neighbour, a floor per tile, `depth` meters
  below the lowest vertex; in wireframe an outline.
- **Export** (`src/export/model.ts`): copies the object tree (sharing
  geometries; all visible; lines only with `lines`), converts materials to
  `MeshStandardMaterial` (USDZ needs it), turns Z-up into Y-up for glTF /
  OBJ / USDZ (not STL), scales (meters: `tileWidth / tileSize`) and runs
  three's exporter, imported dynamically (`three/addons/exporters/*`, kept
  external). `map.export` waits for `whenReady()` first.

## Conventions

- TypeScript `strict`, ESM source, no runtime dependencies. `three` is a
  peer dependency and must stay external in the bundle.
- No Node APIs in `src/` (`tsconfig.build.json` sets `types: []`).
- Use TS `private`, not `#private` — consumers may wrap instances in proxies
  (Vue `reactive`, MobX), which breaks `#` fields.
- Keep the public API backwards compatible within a major. Odd legacy names
  (`childrens`, `buildmesh`, `keyNeighX`, `mapUrlmapTiler`) are public — keep them.
- Prettier: no semicolons, single quotes, no trailing commas. Don't hand-format;
  run `yarn format`.
- Every behaviour change needs a unit test; rendering changes need the e2e
  test (and a visual check, see `.skills/verify-rendering`).
- Unit tests mock `src/io/image` (network/canvas) and
  `loadQuadTexture` (no canvas in Node), or `src/io/fetch` for vector tiles;
  build MVT fixtures with `test/support/mvt-encoder.ts`. Stub browser globals
  with `vi.stubGlobal` (restored automatically), e.g. `FakeFileReader` for
  GLTFExporter.
- Keep `src/` grouped by area; new public modules are re-exported from
  their folder's `index.ts`. Internal helpers (`io/fetch`, `io/image`,
  `sources/tile-source` internals) stay out of the barrels.
- Example code is part of the product: keep it short, and make it look
  good — check it in a browser after every change.

## Version constraints (as of three r186)

- **TypeScript is pinned to `~6.0`**: typescript-eslint's peer range is
  `<6.1.0`, and TypeScript 7 (native compiler) has no JS compiler API yet.
- `three` and `@types/three` must share the same minor in every package root.
- React stays `<19.4` — `@react-three/fiber` 9.x peer range.
- `peerDependencies.three` is `>=0.152.0` (needs `Texture.colorSpace`).
- three's WebGPU backend fails on software WebGPU adapters (SwiftShader in
  Playwright's headless shell / GPU-less CI: `GPUValidationError: Invalid
Texture`, then device lost — even for a plain box). The e2e tests then run
  `WebGPURenderer` with `forceWebGL` and annotate the backend; real WebGPU is
  exercised on machines with a GPU (e.g. Playwright with `channel: 'chrome'`).

## MCP servers (`.mcp.json`)

- **playwright** — drive the playground/examples, read console, take screenshots.
- **threejs-devtools** — inspect the live scene graph/materials of the dev
  server (`DEV_PORT=5173`, i.e. `yarn dev`). Community package.
- **context7** — up-to-date docs for three.js, R3F, Vite, Vitest etc.
  Optional `CONTEXT7_API_KEY` env var raises rate limits.

## Skills (`.skills/`)

- `upgrade-dependencies` — bump packages in all three roots, handle couplings
  and three.js migrations, verify.
- `verify-rendering` — check the real rendering in a browser (WebGL/WebGPU).
- `release` — version bump, verification, GitHub release → npm publish.
