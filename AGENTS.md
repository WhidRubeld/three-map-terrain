# AGENTS.md

Guidance for AI coding agents working on **three-map-terrain** — a small
TypeScript library that builds 3D terrain for [three.js](https://threejs.org)
from slippy-map tiles (elevation from AWS Terrain Tiles, textures from
OSM/EOX/Mapbox/MapTiler). Published to npm as `three-map-terrain`.

## Layout

```
src/                      library (the only published code, plus dist/)
  index.ts                public API = everything re-exported here
  Map.class.ts            Map: tile grid, loading, seam stitching, getPosition, clean
  Tile.class.ts           Tile: elevation decode → PlaneGeometry, material, seams, dispose
  quad-texture-material.ts  stitches 4 child tiles into one CanvasTexture + built-in material
  Source.class.ts         texture tile URL builders
  Utils.class.ts          Web Mercator tile math
  image.ts                (internal) fetch + createImageBitmap + canvas helpers
test/                     Vitest unit tests (Node, no WebGL)
e2e/                      Playwright tests against playground/ with mocked tile servers
playground/               `yarn dev` app; query params documented in .skills/verify-rendering
examples/basic            plain three.js + webpack (deployed to GitHub Pages)
examples/react            React Three Fiber + drei + Vite
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

## How it works (read before touching src/)

- `Map.init()` creates an `nTiles × nTiles` grid of `Tile`s around the
  location's tile at `zoom`, loads them in parallel, then stitches seams.
  It resolves (and calls the optional callback) when geometry is ready;
  textures stream in afterwards (a wireframe `MeshNormalMaterial` placeholder
  is shown meanwhile).
- **Loading** (`src/image.ts`): transient failures — network errors, HTTP
  408/425/429/5xx and bodies `createImageBitmap` cannot decode (tile servers,
  EOX in particular, sometimes send truncated bodies with status 200) — are
  retried with backoff `RETRY_DELAYS` (250 ms, 1 s, 3 s) and `cache: 'reload'`
  so the browser cache cannot replay a broken body. Aborts and other 4xx are
  not retried. If a texture is still undecodable, `<img>` renders the part
  that arrived; elevation never falls back (partial heights = bogus terrain).
- **Elevation**: terrarium PNGs (`R*256 + G + B/256 - 32768` m), decoded with
  `createImageBitmap(..., { colorSpaceConversion: 'none' })` + canvas
  `getImageData`. Never let color management touch these pixels.
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
  (`lights: true`) or `MeshBasicMaterial`. No custom shaders on purpose: they
  break between three.js releases and don't run on `WebGPURenderer`.
- **Lifecycle**: `Tile.dispose()` aborts in-flight requests (`AbortController`)
  and disposes geometry/material/texture; `Map.clean()` disposes every tile.
  Results that arrive after disposal are discarded. The shared placeholder
  material is never disposed.

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
- Unit tests mock `src/image` (network/canvas); stub browser globals with
  `vi.stubGlobal` (restored automatically).

## Version constraints (as of three r186)

- **TypeScript is pinned to `~6.0`**: typescript-eslint's peer range is
  `<6.1.0`, and TypeScript 7 (native compiler) has no JS compiler API yet.
- `three` and `@types/three` must share the same minor in every package root.
- React stays `<19.4` — `@react-three/fiber` 9.x peer range.
- `peerDependencies.three` is `>=0.152.0` (needs `Texture.colorSpace`).

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
