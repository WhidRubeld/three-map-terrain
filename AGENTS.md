# AGENTS.md

Guidance for AI coding agents working on **three-map-terrain** — a
TypeScript library that builds 3D terrain for [three.js](https://threejs.org)
from map tiles of any source (elevation, imagery), layers on it (buildings,
roads and bridges from vector tiles / OpenStreetMap, and users' own), and
exports them as model files. Published to npm as `three-map-terrain`.

**Design principle (3.0):** the library is a frame with extension points
at every stage — source (provider), schema (parsing), geometry (`build`),
material (per part, terrain factory, imagery `process`) — not a collection
of looks. Built-in looks (color, lights, wireframe) are defaults; effects
such as grayscale imagery live in the examples and in GPX Terrain. Prefer
an extension point over a built-in effect, and keep the core small: what
only one layer needs stays in that layer.

## Layout

```
src/                      library (the only published code, plus dist/)
  index.ts                public API = the folders' index.ts barrels
  terrain/                the terrain grid
    Map.class.ts          Map: grid, loading, seams, positions, layers (MapLayer),
                          setSource/setMaterial, whenReady, export
    Tile.class.ts         Tile: elevation → PlaneGeometry, imagery and material, seams
    grid.ts               (internal) the tile's grid: normals of a region,
                          bounds, raycast over the cells a ray crosses
    material.ts           MaterialOptions (the look), TerrainMaterialOptions
                          (process, create), loadQuadTexture, createTerrainMaterial
    texture.ts            (internal) loadTextureGrid: k × k imagery tiles → one
                          CanvasTexture
  sources/                where data comes from
    tile-source.ts        TileRequest, URL templates, fallback to ancestors
    Source.class.ts       imagery: presets / url / load / none
    ElevationSource.class.ts  elevation: presets / url + encoding / load
    vector-tiles.ts       VectorTiles: MVT provider (presets, url, tilejson),
                          one shared load per tile, lazily decoded layers
    overpass.ts           Overpass: queued queries per endpoint
    feature-source.ts     FeatureSource (interface), TileFeatureSource =
                          provider + FeatureSchema; props of layer sources
    source-tiles.ts       (internal) source tiles shared by terrain tiles, refcounts
  layers/                 the layer frame and the layers on it
    FeatureLayer.class.ts FeatureLayer: tiles, sources, redraws (tileChanged,
                          invalidate), materials per part (restyled in place),
                          pick (occlusion), highlight (overlays), pending
    scheduler.ts          (internal) draws every layer's tiles in slices
                          between frames, nearest to map.focus first
    TileContext.class.ts  TileContext: a tile's features, ground, primitives
                          (drapePolygon/Line/Path, extrude, face, segment, add)
    drape.ts              cutting shapes along the terrain's triangles, TileSurface
    extrude.ts            walls/roofs/floors/edges with UVs in meters
    geometry.ts           SurfaceBuilder, LineBuilder, InstanceBuilder (attributes,
                          featureIndex)
    footprint.ts          (internal) what a tile's faces cover, from above (covers()),
                          triangles in a grid (CSR arrays)
    features.ts           Position, Ring, toNumber, parseLength, clipRect, classifyRings
    buildings/            Buildings (ownership, grounding, clip), BuildingSource
                          (schema), features (MVT schemas), osm (tags, Overpass)
    roads/                Roads (ribbons, decks, piers), RoadSource (schema),
                          features (kinds, widths, MVT schemas), osm, bridges
                          (joining pieces, deck profile)
    water/                Water (draped areas and waterways), WaterSource, schemas, osm
    trees/                Trees (woods scattered, single trees; instanced trunks
                          and crowns), TreeSource, schemas, osm
    osm.ts                (internal) Overpass elements, joinRings, polygonsOf
    base/                 TerrainBase: side walls + bottom (a plain MapLayer)
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
                          buildings via a custom PMTiles source, OpenFreeMap roads,
                          imagery toned with a `process`
examples/react            React Three Fiber + drei + Vite; the live example
                          (GitHub Pages, deployed from master), a small tool:
                          areas (`grid`: columns × rows) picked on an
                          OpenStreetMap map (Picker.tsx: OpenLayers, lazy; edges
                          dragged with its Extent; Photon search) or presets (Lausanne,
                          Alps), layers toggled with add/removeLayer (layers.ts;
                          scrub as bushes: Trees `plant`), four looks (looks.ts;
                          colored.ts, textured.ts: materials per part), export;
                          the view lives in the URL (view.ts: place or lat/lon/
                          z/w/h, ex, look, imagery, layers, pick). No Leaflet
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

- `Map.init()` creates the `Tile`s of `map.grid` (`options.grid`: any
  rectangle of tiles at `zoom`; else `nTiles × nTiles` around the location's
  tile), loads them in parallel, then stitches seams. The location sets the
  coordinates (`center`) either way, inside the grid or not.
  It resolves (and calls the optional callback) when geometry is ready;
  textures stream in afterwards (a wireframe `MeshNormalMaterial` placeholder
  is shown meanwhile).
- **Sources** (`src/sources/`): `Source` (imagery) and `ElevationSource`
  take a preset `api`, a URL template (`expandTileUrl`) or a `load`.
  Layer sources split **provider** from **schema**: `TileFeatureSource`
  (base of `BuildingSource`, `RoadSource`) reads a provider — `VectorTiles`
  (presets resolve to `VectorTiles.preset(api, token)`, shared by every
  layer: one request per tile while any layer wants it, cancelled when the
  last lets go; layers decoded lazily by name), `Overpass` (one query at a
  time per endpoint, across layers) or a `load` — through the layer's
  `FeatureSchema` (layer names + `properties` per `VectorSchema`, an
  Overpass query + parser). Props override the reading — `layers` and
  `properties` with any vector tiles, presets included; `query` with
  Overpass (the layers' `overpass*Query(bbox, more)` add selectors, built
  by `overpassQl` in `layers/osm.ts`) — so reading more is the user's call,
  not a new built-in. `loadWithFallback` loads a tile, or — beyond `maxZoom`, or
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
  Normals and bounds come from `grid.ts`, not `computeVertexNormals`: the
  same area-weighted normals, for the vertices around the rows/columns that
  changed (`updateGeometry(rows?, columns?)`: a seam refreshes two rows, a
  corner one vertex's ring) — on 256 segments the full recomputes were
  ~800 ms of long tasks per 5 × 5 load.
- **Texture**: each tile is textured with its four children at `zoom + 1`
  — `4^imageryZoomOffset` tiles at `zoom + imageryZoomOffset` (0–3, default
  1), `loadTextureGrid`, column by column — drawn into one canvas (2×2:
  `NW | NE / SW | SE`, `flipY` maps canvas top to north), handed to the map's `process` (CPU: `getImageData`/`putImageData`
  or any drawing; the context is created `willReadFrequently` then) →
  `CanvasTexture` with `SRGBColorSpace`. The tile owns that texture
  (`Tile.texture`) and disposes it; the material is made by the map's
  `create` factory (default `createTerrainMaterial`: `MeshLambertMaterial`
  with `lights`, else `MeshBasicMaterial`, `color` as a tint) and disposed
  when replaced — factories may put the texture in a uniform, so never
  dispose it through `material.map`. No custom shaders in the library on
  purpose: they break between three.js releases and don't run on
  `WebGPURenderer`; users plug theirs in through `create`. Grayscale and
  other tones are a `process` in the examples, never a library option
  (Safari has no canvas `filter` either).
- **Runtime style**: `setSource` reloads every placed tile's texture
  (`Tile.loadTexture`: a generation counter and a per-texture
  `AbortController` drop superseded loads; the old material and texture stay
  until the new ones are in, then are disposed). `setMaterial` makes the
  materials again on the same textures (`Tile.restyle`) unless `process`
  changed. The material is created synchronously right after the texture
  arrives, from the options of that moment — `setSource()` then
  `setMaterial()` in one tick ends in the second's style (unit + e2e tests
  guard this). Layers follow through `materialChanged` — their materials
  only, in place (see FeatureLayer); `TerrainBase` is rebuilt only in or out
  of wireframe.
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
    raycasting and frustum culling rely on. Tile meshes raycast with
    `raycastGrid` (`mesh.raycast`): the cells under the ray's path through
    the bounding box, both triangles each — the same intersections as
    `Mesh.raycast` (tests compare them), falling back to it for geometry
    that is not an untouched grid.
- **Lifecycle**: `Tile.dispose()` aborts in-flight requests (`AbortController`)
  and disposes geometry/material/texture; `Map.clean()` disposes every tile,
  `Map.removeTileSegment()` one (out of `tileCache` and `loads`; its
  neighbours keep their stitched edges, `addTileSegment` loads it again).
  Results that arrive after disposal are discarded. The shared placeholder
  material is never disposed. `Map.whenReady()` waits for the grid, tiles
  loaded since, textures (`Tile.whenTextured`) and layers' `whenReady`.
- **Large areas** (README "Large areas"): the library gives the pieces, the
  policy (which tiles, how detailed) is the user's — no quadtree in the core.
  - `alignTo(other)` sets `terrain`'s transform from both maps' `frame()`
    (the origin on the Web Mercator square and the units per square width:
    exact at tile corners, where a coarse tile's corners are a fine one's;
    z from the `zScale`s and `baseAltitude`s), composed with the other's
    world matrix and the inverse of its own parent's.
  - `skirt` (meters): `Tile.updateSkirt`, from every `updateGeometry` — a
    child mesh of the tile, a strip straight down from each edge
    (`edgeVertices`: one loop around, each edge its own corners) with the
    edge's normals and UVs, in the tile's material (`useMaterial` keeps it
    in step; hidden in wireframe), `raycast` a no-op, not exported
    (`userData.export`). Vertical on purpose: slanted under the tile it
    pokes through slopes falling away from the edge. `TerrainBase`'s own material has a
    polygon offset so its walls win over the skirts in their planes.
  - The e2e test puts zoom 13 in a ring of zoom 12 (`?lod=1`): background
    shows through the edges without skirts, none with them.
- **Layers** (`MapLayer`): `addLayer` calls `attach`, then `tileLoaded` for
  the placed tiles; `fetchAndPlace` calls `tileLoaded` after stitching and
  adding the mesh, then `tileChanged` for the placed tiles whose heights the
  stitching changed (`stitchAround` returns them: the W/N/NW neighbours and
  corners); `clean()` and `removeTileSegment()` call `tileRemoved` before
  disposing. Hooks are wrapped (`notify`): a failing layer never breaks the
  terrain. Layers survive `clean()` (React StrictMode: init → clean → init).
  Their objects live in groups under `map.terrain`; `map.pick` intersects
  `terrain.children` non-recursively, so it never hits them.
- **FeatureLayer** (`src/layers/`), the frame of `Buildings` and `Roads`:
  - Per terrain tile an entry: its source tiles (`SourceTiles.covering`: at
    `clamp(terrain zoom, minZoom, maxZoom)`; deeper terrain shares one,
    shallower loads up to 4² children; refcounted, aborted when unused),
    `select(tile, source, features)` (ownership), then `build(ctx, draw)`
    (`options.build`, else the layer's `draw`).
  - Drawing is sliced (`scheduler.ts`, one queue for every layer and map):
    `schedule()` marks the layer stale and kicks a slice (a `MessageChannel`
    task in browsers, `setTimeout(0)` elsewhere); a slice draws the dirty
    tile nearest to `map.focus` (world coordinates; default the location)
    across all layers, again and again until `SLICE_BUDGET` (6 ms) is used,
    then posts the next slice — at least one tile per slice. `prepare()`
    runs before a stale layer's next tile (cross-tile state). A tile whose
    `canDraw(tile)` is false waits (Trees for `avoid`); when nothing else is
    drawable and no layer is loading, waiting tiles are drawn anyway (layers
    waiting for each other). `whenReady()` waits for the loads, then slice
    by slice until nothing is stale or dirty. `pending(tile)`: loading, or
    dirty with its sources.
  - `TileContext` records the tiles whose heights a drawing read
    (`depends`): `tileLoaded`/`tileChanged`/`tileRemoved` of one of them
    redraws the entry. Draped geometry depends on this (seams change after
    load: "keeps draped shapes on the surface while tiles stitch their
    seams" guards it).
  - Geometry goes into named parts: one `Mesh` per surface part and tile,
    one `LineSegments` per line part; `ctx.add()` objects are the user's
    (never disposed). Vertices carry `position`, `normal`, `uv` (meters),
    `color` (the look) and `featureIndex` (`FEATURE_ATTRIBUTE`) — `pick`
    reads it. Line parts are built only if their material is visible.
    `ctx.instances(part, geometry)` collects copies of a shared geometry
    (matrix, color, feature each) into one `InstancedMesh` per part and tile:
    picked by `instanceId`, highlighted by recoloring `instanceColor` (base
    colors kept per mesh), disposed with `InstancedMesh.dispose()` — the
    shared geometry never.
  - Materials: `material` option = the look (`Partial<MaterialOptions>`),
    one `Material` for faces, or `(part) => Material | undefined`; else
    `createMaterial(part, kind, look)` in `partColor(part, kind, look)`
    (faces hidden in wireframe, or a transparent fill without depth writes
    with `fillOpacity`; lines `visible: wireframe`). The look's colors are
    the materials' — vertex colors are white unless they differ per
    feature (`featureColors`) — so `materialChanged` / `setMaterial()`
    (`restyle`) give every object (`entry.parts`) the material of its part
    without drawing again: own materials of an unchanged look are kept,
    the user's asked again, the rest made anew and the old disposed. Only
    tiles that left out a part now shown (`entry.skipped`: hidden lines,
    hidden copies — `TileContext.visible()`) or `redrawsOn(previous, next)`
    (Buildings with `featureColors` on a new color) are drawn again. A look
    with the same `lights`, `wireframe`, `fillOpacity`, `fog`, `color`
    changes nothing. Own materials are disposed when replaced and on
    `detach`, the user's never.
  - Copies (`instances`) with an own faces material are outlined in
    wireframe: an `InstancedMesh` sharing their `instanceMatrix` (and
    `instanceColor`) with a `wireframe: true` `MeshBasicMaterial`, made and
    removed on restyle, never picked or exported, never disposed (the
    copies own the buffers). Highlighted copies are an overlay
    `InstancedMesh` of those copies (disposed: its own matrices).
  - `pick` ignores hits behind the terrain (tile meshes nearer by >
    0.01 units); `highlight` draws overlays — copies of the feature's
    triangles/segments with a highlight material (polygon offset), never
    picked, `userData.export = false` — so it works over any material.
  - `covers()` caches the 3 × 3 tiles' footprints for the tile of the last
    point (`version` bumps whenever objects change): Trees ask for every
    candidate tree.
  - `maxDistance` (option and property; meters, or per part): a
    `BeforeRender` — an `LOD` subclass, first child of `group` while set —
    is updated by the renderer (WebGL and WebGPU) before each render with
    the camera; it measures each tile's distance to the camera (the nearest
    point of its terrain box, horizontal meters and `z / zScale`, divided by
    `camera.zoom` like `LOD`), stores it (`entry.meters`) and sets the parts'
    `visible` (outlines follow). A tile drawn again takes the last distance
    at once. Hidden objects are drawn, exported, never picked; objects of
    `ctx.add()` are left alone.
- **Draping** (`drape.ts`, `TileContext.drapeConvex`): a convex polygon in
  grid coordinates (`col`, `row`: cells 1 × 1, rows south) is cut into
  bands, cells and the two triangles of each cell (diagonal
  `col + row = c + r + 1`, as PlaneGeometry and `heightAt`); every piece lies
  in one triangle, so heights and normals sampled there (`TileSurface`,
  same weights as `heightAt`) put it exactly on the mesh. Vertices shared
  by pieces of one polygon are merged. `cutPolygon` clips into reused
  scratch arrays: `emit(piece, length)` must read the piece before
  returning (a test checks it cuts exactly what `clipHalfPlane` step by
  step does). The builders (`SurfaceBuilder`…) write into growing typed
  arrays. Lines (`drapePath`) are split at
  every grid crossing (`gridCrossings`). Draped parts need a polygon offset
  (`surface`/`rails` get factor −1, units −4).
- **Buildings** (`src/layers/buildings/`):
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
    above the highest; `minHeight > 0` floats with a floor. Heights above
    `MAX_HEIGHT` (1000 m, more than any building) are data errors and
    count as none: `defaultHeight`, grounded.
  - `ctx.extrude` into `walls` (UV: meters along, up), `roofs`, `floors`
    (UV: map meters) and `edges` (lines with `edges` or in wireframe; faces
    then get a polygon offset). Edges are the look's color × 0.62 (solid)
    or the color (wireframe).
  - MVT decoding is our own (`io/mvt.ts`, checked against
    `@mapbox/vector-tile` on real tiles); int64 values are read in halves.
- **Roads** (`src/layers/roads/`):
  - Every terrain tile draws the part of each road in it: ribbons
    (`drapeLine`: a quad per segment, a bevel on the outer side of each
    bend, half discs beyond the ends — the inner bevel and the other half
    lie under the ribbon: ~20 % fewer vertices than both) clipped
    to the source tile ∩ terrain tile (so buffered vector tile lines and
    whole `load` features are never drawn twice), into `surface` (roads) or
    `rails`, with center lines in `lines`. Widths by kind (`ROAD_WIDTHS`,
    links × `LINK_WIDTH`) unless the feature or `widths` gives one. Tunnels
    are skipped. Roads are the look's color × 0.8.
  - Bridges (`bridges.ts`): pieces cut to their source tile (`clipLine`,
    with cut flags) are collected per source tile (`sourceLoaded` /
    `sourceDropped`); `prepare()` joins them (`joinBridges`: same id — or
    the same geometry — at cut ends; then end to end where exactly two
    uncut ends meet; ends left are `free` (cut, the rest not loaded),
    `on` another bridge (a ramp) or on the `ground`) and builds decks:
    ground sampled every half cell along the center and both edges (max),
    `deckProfile` = upper convex hull over the known ground, fixed ends at
    the ground (or the other deck, 3 passes), free ends level with a fixed
    one; a bridge clearing nothing by 5 m gets the clearance ramping up at
    15 % from its fixed ends (overpasses on coarse elevation). Deck points
    add the hull's bends; offsets are mitered (limit 2); piers every 40 m
    where the deck is ≥ 3 m up. Each tile draws the deck clipped to it
    (`deck` top, `structure` sides/bottom/caps, a section cap on sides with
    no placed neighbour) and the piers standing in it. A deck's signature
    (points, heights) per tile decides which tiles redraw when the decks
    change — every tile event recomputes them.
  - Measured on Lausanne (z15, 48 segments): ~330 k vertices for 9 tiles,
    a tile redrawn in ~20 ms. Real data behind the design (OpenFreeMap z14
    - Mapterhorn): feature ids are OSM way ids, the same in every tile, so
      clipped pieces join; a deck draped on the terrain dips 13 m into the
      Flon valley (Grand-Pont, Lausanne), and a straight line between the
      ends of a long hillside viaduct (Chillon, A9) runs up to 20 m into the
      slope — the hull does neither.
- **Water** (`src/layers/water/`): areas (`drapePolygon`, holes = islands)
  and waterways (`drapeLine`, `WATERWAY_WIDTHS`) clipped to source ∩
  terrain tile like roads, into `water` (polygon offset −1/−2: in front of
  the terrain, behind roads at −4), shores and center lines in `lines`.
  Tunnels dropped by the schemas. Blue (`WATER_COLOR`) unless the look has
  its own color.
- **Trees** (`src/layers/trees/`): woods (polygons) are scattered on a
  jittered grid of `spacing` meters anchored to map units — `hash(i, j, k)`
  per cell, so the same trees in every redraw and none twice at tile edges
  (each tile plants only inside source ∩ terrain tile); points are single
  trees. A wood's edges are indexed by grid row (`rowsOf`, cached per
  polygon and cell): a point tests only its row's edges. `spacing` may be
  a function of the zoom and the wood (cells differ per feature). A grid
  spot is claimed once per tile (`claim`, per cell size): overlapping woods
  plant it once, the first wins. `avoid` (any `GroundCover`, i.e. FeatureLayers)
  keeps trees off what other layers drew: `covers(x, y, margin)` (map
  units) asks the `Footprint` of the tile and its 8 neighbours (`footprint.ts`: the faces' triangles from above in a grid of
  about 4 a cell, walls skipped, built lazily, dropped on every redraw).
  `canDraw` holds a tile until no `avoid` layer is `pending` on it or its
  neighbours — planted once; `onTileDrawn` makes Trees draw that tile and
  its neighbours again later, and `Trees.whenReady` waits for the `avoid`
  layers first. On Lausanne it takes out a quarter of the trees. A tree = a
  trunk (open 4-sided prism, z 0–1, 8 triangles) and a crown (icosahedron
  of 20 triangles with a sphere's normals) shared by every layer, white
  `color` attributes, sized by its height (crown 62 % of it, radius 24 %);
  the colors are the parts' materials (`partColor`), copies have no
  `instanceColor`. A tile's spots are collected first (one reused
  `Float64Array`: x, y, `random`, rank); over `maxPerTile` those of the
  lowest rank (`hash(i, j, 4)`, independent of `random`; a counting sort)
  are planted, `avoid` asked in that order up to the cap — thinned evenly,
  the same every draw, never cut at a row or a wood; under it every spot.
  Nothing is planted while both
  parts are hidden (`ctx.visible`) — unless `plant` is given: the layer
  decides where (grid, `avoid`, clipping, cap), `plant(ctx, spot, feature,
tree)` what stands there — `tree(height?)` (the trunk and crown, their
  copies made lazily), copies in parts of its own, or nothing. Shapes,
  sizes and species stay out of the library (bushes are in the React
  example); `treeShapes()` is public for reuse. Overpass nodes' `kind` is
  their `natural` tag.
- **TerrainBase**: rebuilt from all placed tiles on every tile event — walls
  along sides without a placed neighbour, a floor per tile, `depth` meters
  below the lowest vertex; in wireframe an outline.
- **Export** (`src/export/model.ts`): copies the object tree (sharing
  geometries; all visible; lines only with `lines`; never objects with
  `userData.export === false`, e.g. highlights), expands every
  `InstancedMesh` into a mesh of its copies for formats without instancing
  (STL, OBJ, USDZ; glTF keeps `EXT_mesh_gpu_instancing`), converts materials to
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
- Keep the public API backwards compatible within a major. 3.0 dropped the
  2.x legacy names (README, Upgrading); a rename or removal now waits for 4.0.
  `FeatureLayer` is beta: its protected API may still grow.
- Prettier: no semicolons, single quotes, no trailing commas. Don't hand-format;
  run `yarn format`.
- Every behaviour change needs a unit test; rendering changes need the e2e
  test (and a visual check, see `.skills/verify-rendering`).
- Unit tests mock `src/io/image` (network/canvas) and
  `loadTextureGrid` (`src/terrain/texture`, no canvas in Node), or
  `src/io/fetch` for vector tiles;
  build MVT fixtures with `test/support/mvt-encoder.ts`. Stub browser globals
  with `vi.stubGlobal` (restored automatically), e.g. `FakeFileReader` for
  GLTFExporter.
- Keep `src/` grouped by area; new public modules are re-exported from
  their folder's `index.ts`. Internal helpers (`io/fetch`, `io/image`,
  `sources/tile-source` internals, `sources/source-tiles`, `layers/drape`
  cutting, `layers/extrude`, `layers/roads/bridges`) stay out of the barrels.
- A new kind of layer goes on `FeatureLayer` (a folder under `src/layers/`
  with its source schema, features and layer class); new shared geometry
  goes into `TileContext` primitives only if more than one layer needs it.
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
