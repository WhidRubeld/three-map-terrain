<div align="center">

# three-map-terrain

**Real-world 3D terrain and buildings for [three.js](https://threejs.org), from any map tiles.**<br>
Elevation, imagery and OpenStreetMap buildings in one style, the geolocation math to put your own data on it, and model files — GLB, STL, USDZ — to take it anywhere.

[![npm](https://img.shields.io/npm/v/three-map-terrain?style=flat-square&color=000&labelColor=000)](https://www.npmjs.com/package/three-map-terrain)
[![CI](https://img.shields.io/github/actions/workflow/status/whidrubeld/three-map-terrain/ci.yml?branch=master&style=flat-square&label=ci&color=000&labelColor=000)](https://github.com/whidrubeld/three-map-terrain/actions/workflows/ci.yml)
[![three](https://img.shields.io/badge/three-%E2%89%A50.152-000?style=flat-square&labelColor=000)](https://threejs.org)
[![types](https://img.shields.io/npm/types/three-map-terrain?style=flat-square&color=000&labelColor=000)](src/index.ts)
[![license](https://img.shields.io/npm/l/three-map-terrain?style=flat-square&color=000&labelColor=000)](LICENSE)

[**Live example**](https://whidrubeld.github.io/three-map-terrain/) · [Quick start](#quick-start) · [Buildings](#3d-buildings) · [Looks](#looks) · [Export](#export) · [Sources](#sources) · [API](#api)

<a href="https://whidrubeld.github.io/three-map-terrain/"><img src="docs/hero.webp" alt="The live example: the Bernese Alps from Lake Brienz to the Aletsch Glacier as 3D terrain with satellite imagery; the panel shows the geolocation of a click on the terrain" width="100%"></a>

<table>
  <tr>
    <td width="33%"><a href="https://whidrubeld.github.io/three-map-terrain/?place=lausanne&look=plain"><img src="docs/lausanne-plain.webp" alt="Lausanne as a white model: terrain without imagery, OpenStreetMap buildings with their edges and a solid base cut along the lake"></a></td>
    <td width="33%"><a href="https://whidrubeld.github.io/three-map-terrain/?place=lausanne&look=aerial"><img src="docs/lausanne-aerial.webp" alt="The same Lausanne with swisstopo aerial imagery in grayscale under white buildings"></a></td>
    <td width="33%"><a href="https://whidrubeld.github.io/three-map-terrain/?place=lausanne&look=wireframe"><img src="docs/lausanne-wireframe.webp" alt="The same Lausanne in wireframe: the terrain's triangles, the buildings' and the base's edges"></a></td>
  </tr>
</table>

<sub>The live example — [React Three Fiber in one component](examples/react/src/App.tsx): Lausanne from the lake to the cathedral, one map in three looks the buildings take on.</sub>

</div>

## Features

- **Terrain from real elevation** — [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), [Mapterhorn](https://mapterhorn.com), Mapbox, MapTiler or your own, at any zoom, as a grid of tiles around a location.
- **3D buildings** — OpenStreetMap buildings from [OpenFreeMap](https://openfreemap.org), VersaTiles, MapTiler, Mapbox, Protomaps or the Overpass API, or any data you load ([Overture Maps](https://overturemaps.org) in an example), standing on the rendered terrain, with picking and highlighting.
- **Any source** — every source takes a preset, a `{z}/{x}/{y}` URL template or your own `load` function; tiles missing or beyond a source's zoom are cut out of their ancestors.
- **One look for everything** — imagery or none, a color, a filter (grayscale, sepia, brightness… the same in every browser), wireframe: the buildings and the base take on the terrain's style, also when it changes at runtime.
- **Diorama base** — `TerrainBase` closes the terrain into a solid block; buildings are cut cleanly at its edge.
- **Export** — the terrain with its imagery, buildings and base as GLB, glTF, OBJ, STL (3D printing) or USDZ (AR), in meters.
- **Geolocation both ways** — place objects at a latitude/longitude (on the surface or at an altitude), and read the geolocation under the pointer.
- **Seamless while streaming** — tiles are stitched to their neighbours the moment they load: no cracks, no walls.
- **Plain three.js** — built-in materials, no custom shaders: works with `WebGLRenderer` and `WebGPURenderer`, with lights and fog.
- **Well-behaved** — retries for flaky tile servers, `AbortController` for pending requests, `clean()` frees every GPU resource.
- **Small** — TypeScript, ESM + CommonJS, no runtime dependencies (its own vector tile decoder); `three` is a peer dependency.

## Install

```bash
npm install three three-map-terrain
# or: yarn add three three-map-terrain · pnpm add three three-map-terrain
```

Requires `three` ≥ 0.152.

## Quick start

```ts
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { Map } from 'three-map-terrain'

const scene = new Scene()
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 1, 1e6)
camera.up.set(0, 0, 1) // the terrain lies in the XY plane, Z is up
camera.position.set(0, -1200, 900)

const renderer = new WebGLRenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
document.body.append(renderer.domElement)
const controls = new MapControls(camera, renderer.domElement)

const map = new Map({
  source: { api: 'eox' }, // Sentinel-2 imagery
  location: { lat: 46.57634, lon: 7.9904 } // Bernese Alps
})
scene.add(map.terrain)
await map.init() // geometry is ready; textures keep streaming in

renderer.setAnimationLoop(() => {
  controls.update()
  renderer.render(scene, camera)
})
```

Built-in materials react to lights: add an `AmbientLight` and a `DirectionalLight`, or pass `material: { lights: false }`.

### React Three Fiber

```tsx
import { MapControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Map } from 'three-map-terrain'

export function Terrain() {
  const map = useMemo(
    () =>
      new Map({
        source: { api: 'eox' },
        location: { lat: 46.57634, lon: 7.9904 }
      }),
    []
  )

  useEffect(() => {
    void map.init()
    return () => map.clean() // aborts requests, frees GPU memory
  }, [map])

  return <primitive object={map.terrain} />
}

export default function App() {
  return (
    <Canvas camera={{ up: [0, 0, 1], position: [0, -1200, 900], far: 1e6 }}>
      <ambientLight intensity={1.5} />
      <directionalLight position={[-1e4, 1e4, 1e4]} intensity={2.5} />
      <Terrain />
      <MapControls />
    </Canvas>
  )
}
```

### Put things on the map

```ts
// on the rendered surface, wherever the terrain is
const { x, y, z } = await map.getTerrainPosition({ lat: 46.6242, lon: 8.0414 })
marker.position.set(x, y, z)

// every frame, for moving objects (undefined until that tile has loaded)
const p = map.getTerrainPositionSync({ lat, lon })
if (p) vehicle.position.set(p.x, p.y, p.z)

// at an altitude in meters, e.g. an aircraft
const { x, y, z } = map.getPosition({ lat, lon, alt: 3000 })

// the geolocation under the pointer
raycaster.setFromCamera(pointer, camera)
const hit = map.pick(raycaster) // { lat, lon, alt, point } | undefined
```

## 3D buildings

Buildings are a layer of the map. They need a city-scale zoom — 14 to 16; at 15 a 3 × 3 grid is about 2.5 km wide — and true scale, so that they are not flattened:

```ts
import { Buildings, Map } from 'three-map-terrain'

const map = new Map({
  location: { lat: 46.515, lon: 6.632 }, // Lausanne
  elevation: { api: 'mapterhorn' },
  options: {
    zoom: 15,
    exaggeration: 1, // true to scale: heights as wide as they are high
    baseAltitude: 372 // Lake Geneva at z = 0: the scene stays near the origin
  }
})
const buildings = map.addLayer(
  new Buildings({ source: { api: 'openfreemap' }, edges: true })
)
scene.add(map.terrain) // the buildings are in map.terrain too
await map.init()

// the building under the pointer, highlighted
raycaster.setFromCamera(pointer, camera)
const hit = buildings.pick(raycaster) // { feature, lat, lon, alt, point } | undefined
buildings.highlight(hit?.feature)
```

With React Three Fiber, a pointer event is already an intersection: `buildings.pickIntersection(event)`.

How they are built:

- **On the surface.** Walls start just below the lowest ground under them; the roof is `height` meters above it — and at least 3 m above the highest ground on a slope. Heights are scaled like the terrain. Parts with a `minHeight` (overhangs, towers on podiums) float with a floor; courtyards stay open. Roofs are flat.
- **Once, whole.** Every terrain tile gets one mesh with the buildings whose center lies in it, so a building crossing a tile border is drawn once and never cut. Sources whose tiles are coarser than the terrain (most stop at zoom 14) are loaded once for the terrain tiles they cover.
- **Cut at the edge.** With `clip` (default) buildings end with the grid: those crossing its edge are cut along it, and the parts of buildings outside that reach in are drawn — a clean section, see [`TerrainBase`](#looks).
- **Data.** Heights, minimum heights and colors come from the source: OSM `height`, `building:levels` (3 m each), `min_height`, `building:colour`; vector tiles with these precomputed. Outlines that have `building:part`s are left to the parts. Buildings without a height get `defaultHeight`.

## Looks

The terrain and its layers share one set of material options — `lights`, `wireframe`, `fog`, `color`, and `filter` for imagery. Buildings and the base take on the map's unless they are given their own:

```ts
// no imagery: a plain model, the relief shows in the light
new Map({ location, material: { color: '#f2ede5' } })

// imagery toned down to the buildings
new Map({
  source: { api: 'osm' },
  location,
  material: { filter: 'grayscale(1) brightness(1.1)' }
})

// everything in lines: the terrain's triangles, the buildings' edges
new Map({ location, material: { wireframe: true, color: '#9fb3c8' } })

// a solid block: walls from the terrain's outer edges down, and a bottom
map.addLayer(new TerrainBase({ depth: 50 }))
```

`filter` takes the color functions of CSS — `grayscale`, `sepia`, `saturate`, `hue-rotate`, `invert`, `opacity`, `brightness`, `contrast` — in any order. The library applies them to the imagery's pixels, so they look the same in every browser and renderer, Safari included, and go into exported models; other functions such as `blur()` make the filter invalid, and it is ignored with a warning.

Change them at runtime — the textures are kept, the buildings and the base follow:

```ts
map.setSource({ api: 'none' }) // imagery off; or another source
map.setMaterial({ wireframe: true }) // only a new `filter` reloads imagery
```

## Export

```ts
const blob = await map.export('glb') // 'glb' | 'gltf' | 'obj' | 'stl' | 'usdz'

const link = document.createElement('a')
link.href = URL.createObjectURL(blob)
link.download = 'lausanne.glb'
link.click()
```

`map.export()` waits for everything to be loaded, then writes the terrain with its imagery and every layer in meters — true to scale horizontally, heights with the map's exaggeration. glTF, OBJ and USDZ are Y-up as their tools expect, STL stays Z-up for slicers; with a `TerrainBase` the terrain is a solid block, and the buildings stand in it — what a slicer needs to print a city. Options: `textures`, `lines` (building edges), `layers`, `units: 'scene'`. For any other three.js object there is `exportModel(object, format, options)`. three.js' exporters are loaded only when you export.

## Sources

Every kind of source — imagery, elevation, buildings — takes a preset `api`, a URL template or your own `load` function, and `maxZoom` / `attribution`. A tile that is missing (HTTP 404, or a `load` resolving to `null`) or deeper than `maxZoom` is cut out of its nearest ancestor, so terrain deeper than a source still works.

### Imagery — `source`

| `api`      | Imagery                                                                        | Key |
| ---------- | ------------------------------------------------------------------------------ | --- |
| `eox`      | [Sentinel-2 cloudless](https://s2maps.eu) satellite mosaic                     | —   |
| `osm`      | [OpenStreetMap](https://www.openstreetmap.org) standard map                    | —   |
| `mapbox`   | Mapbox satellite                                                               | yes |
| `maptiler` | MapTiler satellite                                                             | yes |
| `none`     | No imagery: the terrain is drawn in `material.color` (also without a `source`) | —   |

Any other tile server by its URL — `{z}`, `{x}`, `{y}`, `{-y}` (TMS), `{s}` (subdomains), `{quadkey}`:

```ts
// swisstopo aerial imagery, 10 cm in Switzerland
{ url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg', maxZoom: 20, attribution: '© swisstopo' }
// Esri World Imagery: rows before columns
{ url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Esri, Maxar, Earthstar Geographics' }
// your own loader: headers, WMS, a cache, local files — an image, canvas or bitmap
{ load: async ({ z, x, y, signal }) => myImage(z, x, y, signal) }
```

Hundreds of templates with their attributions are listed by [leaflet-providers](https://github.com/leaflet-extras/leaflet-providers) and [xyzservices](https://github.com/geopandas/xyzservices); the [Editor Layer Index](https://github.com/osmlab/editor-layer-index) has aerial imagery by country — mind that much of it is licensed for editing OpenStreetMap only.

### Elevation — `elevation`

| `api`           | Data                                                                                                                                   | Key |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `aws` (default) | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), terrarium, to zoom 15                                               | —   |
| `mapterhorn`    | [Mapterhorn](https://mapterhorn.com), terrarium, 512 px; 30 m worldwide, much finer where open data exists (e.g. Switzerland, Austria) | —   |
| `mapbox`        | Mapbox Terrain-RGB, to zoom 15                                                                                                         | yes |
| `maptiler`      | MapTiler Terrain RGB, to zoom 14                                                                                                       | yes |

Any other server by its URL with its `encoding` — `'terrarium'`, `'mapbox'` or a function `(r, g, b) => meters` — or a `load` returning RGBA pixels (e.g. decoded from a GeoTIFF).

### Buildings — `new Buildings({ source })`

| `api`         | Data                                                                                                                                                               | Key | Zooms | Heights                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ----- | ------------------------------ |
| `openfreemap` | [OpenFreeMap](https://openfreemap.org) vector tiles (OpenMapTiles)                                                                                                 | —   | 13–14 | from OSM tags                  |
| `versatiles`  | [VersaTiles](https://versatiles.org) vector tiles (Shortbread)                                                                                                     | —   | 14    | none: `defaultHeight`          |
| `maptiler`    | MapTiler vector tiles (OpenMapTiles)                                                                                                                               | yes | 13–14 | from OSM tags                  |
| `mapbox`      | Mapbox Streets v8                                                                                                                                                  | yes | 15–16 | `height`, `min_height`         |
| `protomaps`   | Protomaps basemap                                                                                                                                                  | yes | 14–15 | `height`, `min_height`         |
| `overpass`    | OpenStreetMap through the [Overpass API](https://overpass-api.de) — every tag; slow (tens of seconds a tile), one request at a time; `endpoint` for another server | —   | 14    | `height`, `building:levels`, … |

Any vector tile (MVT) server by its `url` or `tilejson`, with the `layers` that hold buildings and a `properties` function reading the heights — schemas for OpenMapTiles, Mapbox Streets, Protomaps, Shortbread and Overture come with the library:

```ts
new BuildingSource({ tilejson: 'https://my.tileserver/data/v3.json' }) // OpenMapTiles fields by default
new BuildingSource({
  url: 'https://my.server/{z}/{x}/{y}.pbf',
  layers: 'buildings',
  properties: (p) => ({ height: Number(p.h), hidden: p.underground === true })
})
```

Or anything else with `load`: return the buildings of a tile as GeoJSON-like features — whole (each is drawn by the tile its center is in) or clipped to the tile:

```ts
new BuildingSource({
  minZoom: 15,
  maxZoom: 15,
  attribution: '© My city',
  async load({ z, x, y, signal }) {
    const response = await fetch(
      `https://my.server/buildings/${z}/${x}/${y}.geojson`,
      { signal }
    )
    const { features } = await response.json()
    return features.map((f) => ({
      id: f.id,
      geometry: f.geometry,
      height: f.properties.height,
      properties: f.properties
    }))
  }
})
```

The [basic example](examples/basic/src/overture.ts) loads the [Overture Maps](https://overturemaps.org) buildings — OpenStreetMap merged with Microsoft, Google and Esri footprints — from their PMTiles archive this way, in a few lines.

## Layers

Buildings and the base are `MapLayer`s: objects the map tells about its tiles. Your own data — trees, labels, routes — can be one too; every method is optional:

```ts
map.addLayer({
  attribution: '© My data', // listed in map.attributions
  attach(map) {}, // added: map.terrain is there to add objects to
  tileLoaded(tile) {}, // a tile is in the scene: tile.heightAt(u, v), tile.mesh.position
  tileRemoved(tile) {}, // free what you made for it
  materialChanged(map) {}, // map.setMaterial(): follow map.materialOptions
  whenReady: async () => {}, // map.whenReady() and map.export() wait for it
  detach(map) {} // map.removeLayer()
})
```

## Examples

| Example                                                      | Stack                         | What it shows                                                                                                                                                                                                |
| ------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [React](examples/react)                                      | React Three Fiber, drei, Vite | The [live example](https://whidrubeld.github.io/three-map-terrain/): the Alps with imagery; Lausanne with buildings and a base in three looks switched at runtime; picking, highlighting, GLB and STL export |
| [Basic](examples/basic)                                      | three.js, webpack             | San Francisco: Overture buildings from a custom PMTiles source on a grayscale map, a base, picking, export                                                                                                   |
| [**GPX Terrain**](https://github.com/whidrubeld/gpx-terrain) | React, R3F, TanStack Store    | [A full app](https://whidrubeld.github.io/gpx-terrain/) on the library: GPX tracks draped on terrain, profile, playback, picking, imagery and wireframe at runtime                                           |

<table>
  <tr>
    <td width="50%"><a href="examples/basic"><img src="docs/basic.webp" alt="The basic example: downtown San Francisco, Overture buildings on a grayscale OpenStreetMap map, a tower highlighted"></a></td>
    <td width="50%"><a href="https://whidrubeld.github.io/gpx-terrain/"><img src="https://raw.githubusercontent.com/whidrubeld/gpx-terrain/master/docs/hero.webp" alt="GPX Terrain: the Stelvio Pass road draped on wireframe terrain, with track details, a legend, an elevation profile and the card of the point under the cursor"></a></td>
  </tr>
  <tr>
    <td><sub>Basic: San Francisco with Overture buildings</sub></td>
    <td><sub>GPX Terrain: a GPX viewer built with the library</sub></td>
  </tr>
</table>

## API

### `new Map({ location, source?, elevation?, options?, material? })`

| Prop        | Type                                      | Description                                              |
| ----------- | ----------------------------------------- | -------------------------------------------------------- |
| `location`  | `{ lat: number; lon: number }`            | The grid is centered on the tile containing it           |
| `source`    | `Source \| SourceProps`                   | Imagery; [see above](#imagery--source). Without it, none |
| `elevation` | `ElevationSource \| ElevationSourceProps` | Elevation; AWS Terrain Tiles by default                  |
| `options`   | `Partial<MapOptions>`                     | See below                                                |
| `material`  | `Partial<QuadTextureMaterialOptions>`     | See below                                                |

**`MapOptions`** (defaults in `defaultMapOptions`)

| Option         | Default | Description                                                                                                                                |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `nTiles`       | `3`     | The grid is `nTiles × nTiles` tiles                                                                                                        |
| `zoom`         | `11`    | Zoom level of the terrain tiles; textures use `zoom + 1`                                                                                   |
| `tileSize`     | `600`   | Size of a tile in scene units                                                                                                              |
| `tileSegments` | `100`   | Segments per tile side (`PlaneGeometry`), 1–256                                                                                            |
| `zScale`       | `0.045` | Scene units per meter of elevation. True scale is `tileSize / Utils.tileWidth(lat, zoom)`; the default is true scale at zoom 11 around 46° |
| `exaggeration` | —       | Vertical exaggeration relative to true scale (`1`: true to scale); when set, it decides `zScale`                                           |
| `baseAltitude` | `0`     | Altitude in meters drawn at z = 0                                                                                                          |

**`QuadTextureMaterialOptions`** (defaults in `defaultTextureOptions`) — shared with the layers as `MaterialOptions`, without `filter`

| Option      | Default   | Description                                                                                                    |
| ----------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `lights`    | `true`    | `MeshLambertMaterial` (lit) or `MeshBasicMaterial` (unlit)                                                     |
| `wireframe` | `false`   | Draw lines — the terrain's triangles (`tileSegments` of 32–64 reads well), the buildings' and the base's edges |
| `fog`       | `true`    | Whether the scene fog applies                                                                                  |
| `color`     | `#ffffff` | Tints imagery (white leaves it as it is); without imagery, the color of the surface                            |
| `filter`    | `'none'`  | CSS color functions for the imagery, e.g. `'grayscale(1) brightness(1.1)'`, applied to its pixels              |

Until its texture arrives, a tile shows a shared wireframe placeholder.

### `Map` members

Positions are in `map.terrain` coordinates: X east, Y north, Z up. Transforms of `map.terrain` (or its parents) are taken into account by `pick`.

| Member                                                                    | Returns                                 | Description                                                                                                                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terrain`                                                                 | `Group`                                 | Add it to your scene; one mesh per loaded tile, and the layers' objects                                                                                                                   |
| `init(callback?)`                                                         | `Promise<void>`                         | Loads the grid. Resolves (and calls `callback`, sets `ready`) once every tile has its elevation and seams are stitched; textures keep streaming in. Calls before `clean()` share one load |
| `whenReady()`                                                             | `Promise<void>`                         | Resolves once everything is loaded: tiles, their textures, the layers' content                                                                                                            |
| `getPosition({ lat, lon, alt }, { loadTile })`                            | `{ x, y, z }`                           | `x`, `y` of a geolocation, `z = (alt − baseAltitude) × zScale`. Loads the tile if it is not in the grid, unless `loadTile: false`                                                         |
| `getTerrainPosition({ lat, lon })`                                        | `Promise<{ x, y, z }>`                  | A point exactly on the rendered surface, interpolated over the mesh triangles. Waits for (and loads) the tile; rejects if it cannot be loaded                                             |
| `getTerrainPositionSync({ lat, lon }, { loadTile })`                      | `{ x, y, z } \| undefined`              | The same, synchronously: `undefined` while the tile is not loaded (starts loading it unless `loadTile: false`)                                                                            |
| `getLocation({ x, y, z })`                                                | `{ lat, lon, alt }`                     | Inverse of `getPosition`; `alt` in meters                                                                                                                                                 |
| `pick(raycaster)`                                                         | `{ lat, lon, alt, point } \| undefined` | The terrain hit by a ray, e.g. after `raycaster.setFromCamera(pointer, camera)`; `point` in world coordinates                                                                             |
| `setSource(source)`                                                       | `void`                                  | Replaces the imagery (`{ api: 'none' }` turns it off); each tile keeps its texture until the new one arrives                                                                              |
| `setMaterial(options)`                                                    | `void`                                  | Changes the material options of the terrain and the layers that follow it                                                                                                                 |
| `addLayer(layer)`, `removeLayer(layer)`, `layers`                         |                                         | [Layers](#layers): buildings, base, yours. Layers survive `clean()`                                                                                                                       |
| `export(format?, options?)`                                               | `Promise<Blob>`                         | [A model file](#export) of everything                                                                                                                                                     |
| `attributions`                                                            | `string[]`                              | The credits of the sources and layers in use — show them with the map                                                                                                                     |
| `bounds`, `grid`                                                          |                                         | The grid as `[west, south, east, north]` in degrees, and in tiles                                                                                                                         |
| `addTileSegment(x, y)`                                                    | `Promise<void>`                         | Loads one more tile of the grid's zoom                                                                                                                                                    |
| `clean()`                                                                 | `void`                                  | Removes the tiles, aborts pending requests, disposes geometries, materials and textures. `init()` can be called again                                                                     |
| `ready`, `options`, `materialOptions`, `tileCache`, `source`, `elevation` |                                         | Whether `init()` finished, the resolved options, the loaded `Tile`s by `z/x/y`, the sources                                                                                               |

With React Three Fiber, pointer events already carry the hit: `map.getLocation(map.terrain.worldToLocal(event.point.clone()))`.

### `new Buildings({ source, ...options })`

| Option           | Default   | Description                                                                              |
| ---------------- | --------- | ---------------------------------------------------------------------------------------- |
| `source`         | —         | `BuildingSource` or its props; [see above](#buildings--new-buildings-source-)            |
| `material`       | the map's | `Partial<MaterialOptions>` overriding the map's, or your own `Material` for the faces    |
| `edges`          | `false`   | Outline solid buildings with their edges, in a darker shade                              |
| `clip`           | `true`    | Cut buildings at the edge of the grid, and draw the parts of those outside that reach in |
| `featureColors`  | `false`   | Draw buildings in the color the source gives them (OSM `building:colour`)                |
| `highlightColor` | `#ffb020` | The color of `highlight()`                                                               |
| `defaultHeight`  | `6`       | Meters, for buildings without a height                                                   |
| `minZoom`        | `13`      | Terrain tiles below this zoom get no buildings                                           |

Members: `pick(raycaster)` and `pickIntersection(intersection)` → `{ feature, lat, lon, alt, point }`; `highlight(feature | id, color?)` (no argument clears it); `whenReady()`; `count`; `group` (in `map.terrain`); `dispose()`.

A `BuildingFeature` is `{ id?, geometry, height?, minHeight?, color?, properties }` with a GeoJSON `Polygon` or `MultiPolygon` in `[lon, lat]`.

### `new TerrainBase({ depth?, material? })`

Side walls from the terrain's outer edges down to `depth` meters (default 50) below its lowest point, and a bottom; drawn like the terrain in a darker shade, or with its own `material`. In wireframe, its outline.

### Sources

- `new Source(props)` — imagery; `mapUrl(z, x, y)`, `load(tile)`.
- `new ElevationSource(props)` — elevation; `tileUrl(z, x, y)`, `load(tile)`, `decode(r, g, b)`; `decodeTerrarium`, `decodeMapbox`.
- `new BuildingSource(props)` — buildings; `load(tile)`.

All take the props shown in [Sources](#sources); `map`, `Buildings` and the others also take the props directly.

<details>
<summary>Lower-level exports</summary>

- `Utils` — Web Mercator tile math: `position2tile`, `position2tileFraction`, `tile2bbox`, `tile2lat`, `tile2lon`, `tile2position`, `tileWidth`, `getTileKey`.
- `Tile` — one terrain tile: elevation decoding, geometry, seams, `heightAt(u, v)`, `whenTextured()`, `dispose()`.
- `loadQuadTexture`, `createQuadTextureMaterial`, `QuadTextureMaterial`, `disposeMaterial` — the 2 × 2 child-tile texture and the material built from it.
- `buildingsFromVectorTile`, `openMapTilesProperties`, `mapboxStreetsProperties`, `protomapsProperties`, `shortbreadProperties`, `overtureProperties` — buildings from vector tiles, by schema.
- `buildingsFromOverpass`, `overpassQuery`, `osmBuildingAttributes`, `parseLength`, `LEVEL_HEIGHT` — buildings from OpenStreetMap.
- `decodeVectorTile`, `gunzip` — the vector tile (MVT) decoder.
- `exportModel`, `MODEL_TYPES`, `expandTileUrl`.

</details>

### Loading

Tiles are fetched with CORS. Network errors, HTTP 408/425/429/5xx and bodies that cannot be decoded (tile servers occasionally send truncated images with status 200) are retried up to three times with backoff, bypassing the HTTP cache. A texture that still cannot be decoded is drawn as far as it arrived; an elevation tile never is, since partial heights would be bogus terrain. A missing tile (404) falls back to its ancestors, up to six levels — the browser still logs the 404. Building tiles that are missing are empty.

## Upgrading

### To 2.2

Nothing breaks; worth knowing:

- `source` is optional: without it the terrain has no imagery (`{ api: 'none' }`). `Source.api` can also be `'custom'` and `'none'`.
- A tile that answers 404 now falls back to its ancestor instead of staying untextured or failing to load.
- `QuadTextureMaterialOptions` has `color` and `filter`; `createQuadTextureMaterial()` takes `null` for a plain material; `Tile.buildmesh()` disposes the material it replaces.
- `filter` is applied by the library, no longer by the canvas, which Safari cannot do: it now works there. It takes the color functions of CSS; a filter with others (`blur()`, `drop-shadow()`) is ignored with a warning.
- `Tile.baseURL` still works but `elevation` replaces it.

### From 1.x

2.0 rewrote the internals on stable three.js API. For most apps nothing changes but the peer range; check these if you went deeper:

- **`three` ≥ 0.152** is required (was ≥ 0.148).
- **`init()` returns a promise** and calls its callback once the tiles have their elevation and are stitched. 1.x called it synchronously, before anything had loaded.
- **Tile materials are built-in** `MeshLambertMaterial` / `MeshBasicMaterial` with one stitched texture as `map`. The custom `ShaderMaterial` and its `mapNW`/`mapNE`/`mapSW`/`mapSE` uniforms are gone; `QuadTextureMaterial()` resolves to the new material.
- **`Tile.computeElevation()`** takes `{ width, height, data }` (e.g. an `ImageData`) instead of an `ndarray`; `get-pixels` and `ndarray` are no longer dependencies.
- **Only the package root can be imported** (`exports` map): import from `three-map-terrain`, not from its `dist/` files.
- `clean()` also aborts pending requests; `tileSegments` is clamped to 1–256.

## Data and attribution

Show the credits of the data you use — `map.attributions` lists them — and follow its terms. Exported models carry the data's license too.

- AWS Terrain Tiles: [sources and attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md). Mapterhorn: [attribution](https://mapterhorn.com/attribution).
- `eox`: [Sentinel-2 cloudless](https://s2maps.eu) by EOX IT Services GmbH (contains modified Copernicus Sentinel data). The 2016 layer used here is CC BY-NC-SA 4.0: non-commercial use.
- `osm` imagery: © OpenStreetMap contributors — mind the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/); heavy use needs your own tile server.
- Buildings from OpenStreetMap (OpenFreeMap, VersaTiles, MapTiler, Mapbox, Protomaps, Overpass) and Overture are under the [ODbL](https://www.openstreetmap.org/copyright): credit OpenStreetMap contributors (and the Overture Maps Foundation). The public Overpass API instances are for moderate use: [their limits](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).
- swisstopo geodata: free with the credit © swisstopo.
- `mapbox`, `maptiler`, `protomaps`: their terms of service, with your token.

## Development

```bash
yarn            # install
yarn dev        # playground with hot reload on http://localhost:5173
yarn validate   # typecheck, lint, format check, unit tests, build
yarn test:e2e   # rendering tests in Chromium (WebGL + WebGPU), tile servers mocked
```

The playground takes query parameters: `renderer=webgpu` (`&forceWebGL=1` for its WebGL2 backend), `lights=0`, `wireframe=1`, `segments=40`, `nTiles=5`, `view=top`, `api=osm|swisstopo|none`, `color=e9e4da`, `filter=grayscale(1)`, `elevation=mapterhorn`, `buildings=openfreemap&edges=1`, `zoom=15&lat=46.515&lon=6.632`, `base=372`. Architecture notes and conventions are in [AGENTS.md](AGENTS.md).

## Roadmap

- [x] Terrain position helpers (`getTerrainPosition`, `getTerrainPositionSync`, `pick`)
- [x] Basic and React examples, and a full app: [GPX Terrain](https://github.com/whidrubeld/gpx-terrain)
- [x] Any imagery, elevation and building source; looks shared by the terrain and its layers
- [x] 3D buildings, a diorama base, GLB / STL / USDZ export
- [ ] Roof shapes (`roof:shape`) and building textures
- [ ] More vector layers: roads, water, trees
- [ ] Pin and direction components
- [ ] Vue example

## License

[MIT](LICENSE).
