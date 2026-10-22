# three-map-terrain · React example

[React Three Fiber](https://r3f.docs.pmnd.rs) + [drei](https://drei.docs.pmnd.rs),
bundled with [Vite](https://vite.dev). It is the
[live example](https://whidrubeld.github.io/three-map-terrain/) on GitHub
Pages — a small tool: pick an area anywhere, style it, export a model. For
a full app built with the library see
[GPX Terrain](https://github.com/whidrubeld/gpx-terrain).

What it shows:

- **An area** ([src/App.tsx](src/App.tsx)) — `new Map(...)` in `useMemo`
  for each area, its `grid` any rectangle of tiles, `map.init()` / `map.clean()` in an effect (safe in
  `StrictMode`), on Mapterhorn elevation (worldwide, finer where finer data
  exists). It opens on Lausanne, from Lake Geneva up to the cathedral, true
  to scale, with every layer; the Bernese Alps are the other preset. The
  camera looks at the middle of the grid from `map.getTerrainPosition`.
- **Picking an area** ([src/Picker.tsx](src/Picker.tsx)) — an OpenStreetMap
  map ([OpenLayers](https://openlayers.org), loaded when it opens): a click
  puts the area there, at the zoom chosen; dragging the frame's edges and
  corners (`ol/interaction/Extent`) reshapes it a tile at a time, 1 to 5
  tiles a side; a search ([Photon](https://photon.komoot.io)) takes it to a
  place. The frame is the `grid` the map gets.
- **Layers** ([src/layers.ts](src/layers.ts)) — OpenFreeMap buildings with
  their edges, roads and railways whose bridges span the valleys, water,
  woods and scrub (`Vegetation`: trees and bushes, kept off the water,
  roads and houses with `avoid`) and a `TerrainBase`: made once,
  switched on and off with `map.addLayer` / `map.removeLayer`, and moved to
  the next area's map. Below their zoom (`minZoom`) they draw nothing.
- **Looks** ([src/looks.ts](src/looks.ts)) — one map restyled at runtime
  with `map.setSource` / `map.setMaterial`, which the layers take on:
  plain (no imagery, a color per part from
  [src/colored.ts](src/colored.ts)), aerial (the photo in grayscale by a
  `process` of its pixels), textured (canvas textures of asphalt, tracks
  and facades on the layers' parts, from [src/textured.ts](src/textured.ts),
  repeating at true size since the UVs are in meters) and wireframe. The
  photos are Sentinel-2 cloudless worldwide, swisstopo's in Switzerland.
- **Relief** — the vertical exaggeration (`exaggeration`), 1× to 3×.
- Picking what is under the cursor — a building, plant, road or water
  (`layer.pick` with the event's ray, never one behind the terrain) — and
  highlighting it, or the geolocation of the terrain (`map.getLocation`).
- **Export** — `map.export()`: the terrain, imagery and layers as GLB, STL,
  OBJ or USDZ.
- The credits of the sources in use, from `map.attributions`.

## The URL

The page keeps its view in the query ([src/view.ts](src/view.ts)) — **Copy
link** shares it:

| Parameter    | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `place`      | a preset: `lausanne` (the default), `alps`                               |
| `lat`, `lon` | any other area: its middle                                               |
| `z`          | its zoom (8–16)                                                          |
| `w`, `h`     | its tiles west to east and north to south (1–5); `n` for both            |
| `ex`         | vertical exaggeration, 1 by default                                      |
| `look`       | `plain`, `aerial`, `textured` or `wireframe`                             |
| `imagery`    | the photos of aerial and textured: `sentinel` or `swisstopo`             |
| `layers`     | the layers shown, e.g. `buildings,roads`; empty for none, all by default |
| `pick`       | opens the area picker                                                    |

What a link leaves out is the area's default — a preset's own, else
plain, Sentinel-2 and every layer: `?place=lausanne&look=textured`,
`?lat=27.98808&lon=86.92529&z=12&w=5&h=3&look=textured&layers=water,base`.

`three-map-terrain` is linked from the repository root, so build the library first:

```bash
# repository root
yarn && yarn build

# this folder
yarn
yarn dev      # http://localhost:5173
yarn build    # type-check + production build into dist/ (relative paths)
```
