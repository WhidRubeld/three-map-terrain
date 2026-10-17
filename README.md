<div align="center">

# three-map-terrain

**Real-world 3D terrain for [three.js](https://threejs.org), built from slippy-map tiles.**<br>
Elevation, satellite or map imagery, and the geolocation math to put your own data on it.

[![npm](https://img.shields.io/npm/v/three-map-terrain?style=flat-square&color=000&labelColor=000)](https://www.npmjs.com/package/three-map-terrain)
[![CI](https://img.shields.io/github/actions/workflow/status/whidrubeld/three-map-terrain/ci.yml?branch=master&style=flat-square&label=ci&color=000&labelColor=000)](https://github.com/whidrubeld/three-map-terrain/actions/workflows/ci.yml)
[![three](https://img.shields.io/badge/three-%E2%89%A50.152-000?style=flat-square&labelColor=000)](https://threejs.org)
[![types](https://img.shields.io/npm/types/three-map-terrain?style=flat-square&color=000&labelColor=000)](src/index.ts)
[![license](https://img.shields.io/npm/l/three-map-terrain?style=flat-square&color=000&labelColor=000)](LICENSE)

[**Live example**](https://whidrubeld.github.io/three-map-terrain/) · [Quick start](#quick-start) · [Examples](#examples) · [API](#api) · [Upgrading from 1.x](#upgrading-from-1x)

<a href="https://whidrubeld.github.io/three-map-terrain/"><img src="docs/hero.webp" alt="The live example: the Bernese Alps from Lake Brienz to the Aletsch Glacier as 3D terrain with satellite imagery; the panel shows the geolocation of a click on the terrain" width="100%"></a>

<sub>The live example: [React Three Fiber in one component](examples/react/src/App.tsx). Click the terrain for its geolocation.</sub>

</div>

## Features

- **Terrain from real elevation** — [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) at any zoom, as an `nTiles × nTiles` grid of meshes around a location.
- **Any imagery** — Sentinel-2 cloudless (EOX), OpenStreetMap, Mapbox or MapTiler, one zoom level deeper than the terrain and stitched into a single texture per tile.
- **Seamless while streaming** — tiles are stitched to their neighbours the moment they load: no cracks, no walls.
- **Geolocation both ways** — place objects at a latitude/longitude (on the surface or at an altitude), and read the geolocation under the pointer.
- **Plain three.js** — built-in materials, no custom shaders: works with `WebGLRenderer` and `WebGPURenderer`, with lights, fog and wireframe.
- **Well-behaved** — retries for flaky tile servers, `AbortController` for pending requests, `clean()` frees every GPU resource.
- **Small** — TypeScript, ESM + CommonJS, no runtime dependencies; `three` is a peer dependency.

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
import { Map, Source } from 'three-map-terrain'

const scene = new Scene()
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 1, 1e6)
camera.up.set(0, 0, 1) // the terrain lies in the XY plane, Z is up
camera.position.set(0, -1200, 900)

const renderer = new WebGLRenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
document.body.append(renderer.domElement)
const controls = new MapControls(camera, renderer.domElement)

const map = new Map({
  source: new Source({ api: 'eox' }),
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
import { Map, Source } from 'three-map-terrain'

export function Terrain() {
  const map = useMemo(
    () =>
      new Map({
        source: new Source({ api: 'eox' }),
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

## Examples

| Example                                                      | Stack                         | What it shows                                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [React](examples/react)                                      | React Three Fiber, drei, Vite | The [live example](https://whidrubeld.github.io/three-map-terrain/): the minimal R3F setup with `StrictMode`, a point at an altitude, the geolocation of a click   |
| [Basic](examples/basic)                                      | three.js, webpack             | The same with plain three.js and `map.pick`                                                                                                                        |
| [**GPX Terrain**](https://github.com/whidrubeld/gpx-terrain) | React, R3F, TanStack Store    | [A full app](https://whidrubeld.github.io/gpx-terrain/) on the library: GPX tracks draped on terrain, profile, playback, picking, imagery and wireframe at runtime |

<table>
  <tr>
    <td width="50%"><a href="examples/basic"><img src="docs/basic.webp" alt="The basic example: plain three.js, the terrain with axes and a grid helper, auto-rotating"></a></td>
    <td width="50%"><a href="https://whidrubeld.github.io/gpx-terrain/"><img src="https://raw.githubusercontent.com/whidrubeld/gpx-terrain/master/docs/hero.webp" alt="GPX Terrain: the Stelvio Pass road draped on wireframe terrain, with track details, a legend, an elevation profile and the card of the point under the cursor"></a></td>
  </tr>
  <tr>
    <td><sub>Basic: plain three.js</sub></td>
    <td><sub>GPX Terrain: a GPX viewer built with the library</sub></td>
  </tr>
</table>

## API

### `new Source({ api, token? })`

Where the textures come from. Elevation always comes from AWS Terrain Tiles.

| `api`      | Imagery                                                     | `token` |
| ---------- | ----------------------------------------------------------- | ------- |
| `eox`      | [Sentinel-2 cloudless](https://s2maps.eu) satellite mosaic  | —       |
| `osm`      | [OpenStreetMap](https://www.openstreetmap.org) standard map | —       |
| `mapbox`   | Mapbox satellite                                            | yes     |
| `maptiler` | MapTiler satellite                                          | yes     |

### `new Map({ source, location, options?, material? })`

| Prop       | Type                                  | Description                                    |
| ---------- | ------------------------------------- | ---------------------------------------------- |
| `source`   | `Source`                              | Texture tiles                                  |
| `location` | `{ lat: number; lon: number }`        | The grid is centered on the tile containing it |
| `options`  | `Partial<MapOptions>`                 | See below                                      |
| `material` | `Partial<QuadTextureMaterialOptions>` | See below                                      |

**`MapOptions`** (defaults in `defaultMapOptions`)

| Option         | Default | Description                                                                                                                       |
| -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `nTiles`       | `3`     | The grid is `nTiles × nTiles` tiles                                                                                               |
| `zoom`         | `11`    | Zoom level of the terrain tiles; textures use `zoom + 1`. Terrain tiles exist up to 15                                            |
| `tileSize`     | `600`   | Size of a tile in scene units                                                                                                     |
| `tileSegments` | `100`   | Segments per tile side (`PlaneGeometry`), 1–256                                                                                   |
| `zScale`       | `0.045` | Scene units per meter of elevation. True scale is `tileSize / tileWidthInMeters`; the default is true scale at zoom 11 around 46° |

**`QuadTextureMaterialOptions`** (defaults in `defaultTextureOptions`)

| Option      | Default | Description                                                                       |
| ----------- | ------- | --------------------------------------------------------------------------------- |
| `lights`    | `true`  | `MeshLambertMaterial` (lit) or `MeshBasicMaterial` (unlit)                        |
| `wireframe` | `false` | Draw the textured terrain as lines; `tileSegments` of 32–64 gives a readable grid |
| `fog`       | `true`  | Whether the scene fog applies                                                     |

Until its texture arrives, a tile shows a shared wireframe placeholder.

### `Map` members

Positions are in `map.terrain` coordinates: X east, Y north, Z up. Transforms of `map.terrain` (or its parents) are taken into account by `pick`.

| Member                                               | Returns                                 | Description                                                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terrain`                                            | `Group`                                 | Add it to your scene; one mesh per loaded tile                                                                                                                                            |
| `init(callback?)`                                    | `Promise<void>`                         | Loads the grid. Resolves (and calls `callback`, sets `ready`) once every tile has its elevation and seams are stitched; textures keep streaming in. Calls before `clean()` share one load |
| `getPosition({ lat, lon, alt }, { loadTile })`       | `{ x, y, z }`                           | `x`, `y` of a geolocation, `z = alt × zScale`. Loads the tile if it is not in the grid, unless `loadTile: false`                                                                          |
| `getTerrainPosition({ lat, lon })`                   | `Promise<{ x, y, z }>`                  | A point exactly on the rendered surface, interpolated over the mesh triangles. Waits for (and loads) the tile; rejects if it cannot be loaded                                             |
| `getTerrainPositionSync({ lat, lon }, { loadTile })` | `{ x, y, z } \| undefined`              | The same, synchronously: `undefined` while the tile is not loaded (starts loading it unless `loadTile: false`)                                                                            |
| `getLocation({ x, y, z })`                           | `{ lat, lon, alt }`                     | Inverse of `getPosition`; `alt` in meters                                                                                                                                                 |
| `pick(raycaster)`                                    | `{ lat, lon, alt, point } \| undefined` | The terrain hit by a ray, e.g. after `raycaster.setFromCamera(pointer, camera)`; `point` in world coordinates                                                                             |
| `addTileSegment(x, y)`                               | `Promise<void>`                         | Loads one more tile of the grid's zoom                                                                                                                                                    |
| `clean()`                                            | `void`                                  | Removes the tiles, aborts pending requests, disposes geometries, materials and textures. `init()` can be called again                                                                     |
| `ready`, `options`, `tileCache`                      |                                         | Whether `init()` finished, the resolved options, the loaded `Tile`s by `z/x/y`                                                                                                            |

With React Three Fiber, pointer events already carry the hit: `map.getLocation(map.terrain.worldToLocal(event.point.clone()))`.

<details>
<summary>Lower-level exports</summary>

- `Utils` — Web Mercator tile math: `position2tile`, `position2tileFraction`, `tile2bbox`, `tile2lat`, `tile2lon`, `tile2position`, `getTileKey`.
- `Tile` — one terrain tile: elevation decoding, geometry, seams, `heightAt(u, v)`, `dispose()`.
- `loadQuadTexture`, `createQuadTextureMaterial`, `QuadTextureMaterial`, `disposeMaterial` — the 2 × 2 child-tile texture and the material built from it.

</details>

### Loading

Tiles are fetched with CORS. Network errors, HTTP 408/425/429/5xx and bodies that cannot be decoded (tile servers occasionally send truncated images with status 200) are retried up to three times with backoff, bypassing the HTTP cache. A texture that still cannot be decoded is drawn as far as it arrived; an elevation tile never is, since partial heights would be bogus terrain.

## Upgrading from 1.x

2.0 rewrites the internals on stable three.js API. For most apps nothing changes but the peer range; check these if you went deeper:

- **`three` ≥ 0.152** is required (was ≥ 0.148).
- **`init()` returns a promise** and calls its callback once the tiles have their elevation and are stitched. 1.x called it synchronously, before anything had loaded.
- **Tile materials are built-in** `MeshLambertMaterial` / `MeshBasicMaterial` with one stitched texture as `map`. The custom `ShaderMaterial` and its `mapNW`/`mapNE`/`mapSW`/`mapSE` uniforms are gone; `QuadTextureMaterial()` resolves to the new material.
- **`Tile.computeElevation()`** takes `{ width, height, data }` (e.g. an `ImageData`) instead of an `ndarray`; `get-pixels` and `ndarray` are no longer dependencies.
- **Only the package root can be imported** (`exports` map): import from `three-map-terrain`, not from its `dist/` files.
- `clean()` also aborts pending requests; `tileSegments` is clamped to 1–256.

New in 2.0: `getTerrainPosition`, `getTerrainPositionSync`, `getLocation`, `pick`, a working `wireframe` option, `WebGPURenderer` support and retries.

## Data and attribution

Show the attribution of the data you use, and follow its terms:

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) — [sources and attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- `eox`: [Sentinel-2 cloudless](https://s2maps.eu) by EOX IT Services GmbH (contains modified Copernicus Sentinel data). The 2016 layer used here is CC BY-NC-SA 4.0: non-commercial use.
- `osm`: © OpenStreetMap contributors — mind the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/); heavy use needs your own tile server.
- `mapbox`, `maptiler`: their terms of service, with your token.

## Development

```bash
yarn            # install
yarn dev        # playground with hot reload on http://localhost:5173
yarn validate   # typecheck, lint, format check, unit tests, build
yarn test:e2e   # rendering tests in Chromium (WebGL + WebGPU), tile servers mocked
```

The playground accepts `?renderer=webgpu` (`&forceWebGL=1` for its WebGL2 backend), `?lights=0`, `?wireframe=1`, `?segments=40`, `?api=osm`, `?nTiles=5` and `?view=top`. Architecture notes and conventions are in [AGENTS.md](AGENTS.md).

## Roadmap

- [x] Terrain position helpers (`getTerrainPosition`, `getTerrainPositionSync`, `pick`)
- [x] Basic and React examples, and a full app: [GPX Terrain](https://github.com/whidrubeld/gpx-terrain)
- [ ] Pin and direction components
- [ ] Vue example

## License

[MIT](LICENSE).
