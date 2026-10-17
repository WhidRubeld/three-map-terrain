# three-map-terrain

<p>
  <a href="https://www.npmjs.com/package/three-map-terrain"><img alt="npm version" src="https://img.shields.io/npm/v/three-map-terrain"></a>
</p>

A JavaScript library to build 3D maps with [three.js](https://threejs.org).

<img width="1062" alt="Screenshot 2023-02-04 at 02 40 34" src="https://user-images.githubusercontent.com/35730139/216731690-217bddbb-ca56-4443-a76f-efbc923b095b.png">

[Live demo](https://whidrubeld.github.io/three-map-terrain/) / [Source code](https://github.com/whidrubeld/three-map-terrain/tree/master/examples/basic)

## About

[three-map-terrain](https://github.com/whidrubeld/three-map-terrain) takes two slippy map tilesets, one to fetch elevation data tiles, the other to texture the meshes built from said elevation data (any XYZ tileserver will do).

## Installation

```bash
yarn add three three-map-terrain
```

`three` is a peer dependency (`>=0.152.0`). Works with both `WebGLRenderer` and `WebGPURenderer`.

Tiles are fetched with CORS. Transient failures (network errors, HTTP 408/425/429/5xx, truncated images) are retried up to 3 times with backoff.

## Basic - Quick start

```typescript
import { Scene } from 'three'
import { Map, Source } from 'three-map-terrain'

const scene = new Scene()

const location = { lat: 46.57634, lon: 7.9904 }
const source = new Source({ api: 'eox' })
const map = new Map({ source, location })

scene.add(map.terrain)
await map.init()
console.log('Map is ready')
```

[**See full example**](https://github.com/whidrubeld/three-map-terrain/tree/master/examples/basic)

## React - Quick start

```tsx
import { useEffect, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { Map, Source } from 'three-map-terrain'

export default function App() {
  const map = useMemo(
    () =>
      new Map({
        source: new Source({ api: 'eox' }),
        location: { lat: 46.57634, lon: 7.9904 }
      }),
    []
  )

  useEffect(() => {
    void map.init(() => console.log('Map is ready'))
    return () => map.clean() // aborts pending requests, frees GPU memory
  }, [map])

  return (
    <Canvas>
      <primitive object={map.terrain} />
    </Canvas>
  )
}
```

[**See full example**](https://github.com/whidrubeld/three-map-terrain/tree/master/examples/react)

## Documentation

### `Source` class

Defines a tileset source used to fetch textures applied to the 3D terrain mesh.

```typescript
const source = new Source({ api, token })
```

| Argument | Description                                   | Required                   | Default Value |
| -------- | --------------------------------------------- | -------------------------- | ------------- |
| api      | One of `['osm', 'mapbox', 'eox', 'maptiler']` | `true`                     | -             |
| token    | Your api key                                  | for `mapbox` or `maptiler` | -             |

### `Map` class

The main class three-map-terrain. Creates a 3D map using a grid of tiles.

```javascript
const map = new Map({ source, location, options, material })
```

| Argument | Type                           | Description                                                                   | Required | Default Value           |
| -------- | ------------------------------ | ----------------------------------------------------------------------------- | -------- | ----------------------- |
| source   | `Source`                       | A source instance                                                             | `true`   | -                       |
| location | `{ lat: number, lon: number }` | An object containing the latitude and longitude values used to center the map | `true`   | -                       |
| options  | `MapOptions`                   | An object to pass some map options (override)                                 | `false`  | `defaultMapOptions`     |
| material | `QuadTextureMaterialOptions`   | An object to pass some material options (override)                            | `false`  | `defaultTextureOptions` |

#### The `MapOptions` type

| Option       | Type     | Description                                                                                                                                    |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| nTiles       | `number` | `Map.init()` will display a grid of `nTiles x nTiles`                                                                                          |
| zoom         | `number` | Default zoom level                                                                                                                             |
| tileSize     | `number` | Tile size at the default zoom level                                                                                                            |
| tileSegments | `number` | Number of segments given to the [PlaneGeometry](https://threejs.org/docs/#api/en/geometries/PlaneGeometry) constructor. Maximum value is `256` |
| zScale       | `number` | The raw elevation data is multiplied by zScale when building a Tile mesh                                                                       |

#### The `defaultMapOptions` object

```typescript
{
  nTiles: 3,
  zoom: 11,
  tileSize: 600,
  tileSegments: 100,
  zScale: 0.045
}
```

#### The `QuadTextureMaterialOptions` type

Each tile is textured with its four child tiles (one zoom level deeper), stitched into a single texture and applied with a built-in three.js material.

| Option    | Type      | Description                                                                                                                                                                                                 |
| --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lights    | `boolean` | `true` uses a lit [MeshLambertMaterial](https://threejs.org/docs/#api/en/materials/MeshLambertMaterial), `false` an unlit [MeshBasicMaterial](https://threejs.org/docs/#api/en/materials/MeshBasicMaterial) |
| wireframe | `boolean` | Render the textured terrain as a wireframe. The grid density follows `MapOptions.tileSegments`: `100` (default) looks almost solid from afar, `32`–`48` gives a readable grid                               |
| fog       | `boolean` | Whether the material is affected by the scene fog                                                                                                                                                           |

#### The `defaultTextureOptions` object

```typescript
{
  lights: true,
  wireframe: false,
  fog: true
}
```

### Map helpers

#### Init map cache

```typescript
await map.init(() => {
  console.log('Map is ready')
})
```

| Argument | Type         | Description    | Required | Default Value |
| -------- | ------------ | -------------- | -------- | ------------- |
| callback | `() => void` | Ready callback | `false`  | -             |

Returns a `Promise<void>`. It resolves (and the callback is called, and `map.ready` becomes `true`) once every tile has its elevation and the seams between tiles are stitched; textures keep streaming in afterwards. Calls made while loading share the same load. If `map.clean()` is called meanwhile, the pending call resolves without calling its callback.

#### Determine the location of a point by coordinates

<img width="1062" alt="Screenshot 2023-02-04 at 02 42 28" src="https://user-images.githubusercontent.com/35730139/216731744-24d0e8e3-23b3-4681-bf36-588a1b26be38.png">

```typescript
const posInVector3 = map.getPosition(
  {
    lat: 46.57634,
    lon: 7.9904,
    alt: 3e3
  },
  { loadTile: true }
)
```

| Argument | Type                                        | Description              | Required | Default Value        |
| -------- | ------------------------------------------- | ------------------------ | -------- | -------------------- |
| location | `{ lat: number, lon: number, alt: number }` | Your geolocation         | `true`   | -                    |
| options  | `{ loadTile: boolean }`                     | Extra options (override) | `false`  | `{ loadTile: true }` |

Parameter `loadTile` determines whether to load the required tile if you have specified coordinates that are outside the already loaded tiles.

#### Place a point on the terrain surface

```typescript
const { x, y, z } = await map.getTerrainPosition({
  lat: 46.57634,
  lon: 7.9904
})
marker.position.set(x, y, z)
```

| Argument | Type                           | Description      | Required | Default Value |
| -------- | ------------------------------ | ---------------- | -------- | ------------- |
| location | `{ lat: number, lon: number }` | Your geolocation | `true`   | -             |

Like `getPosition`, but without the altitude: `z` is read from the terrain itself, interpolated over the same triangles as the rendered mesh, so the point never floats above or sinks into it. Waits for the tile under the location, loading it if needed, and rejects if it cannot be loaded. The altitude in meters is approximately `z / map.options.zScale`.

For areas that are already loaded there is a synchronous variant, e.g. to move an object along the terrain every frame:

```typescript
const position = map.getTerrainPositionSync({ lat, lon }, { loadTile: true })
if (position) vehicle.position.set(position.x, position.y, position.z)
```

It returns `undefined` while the tile under the location is not loaded, and starts loading it unless `loadTile` is `false`.

#### Find the geolocation of a point on the map

`getLocation` is the inverse of `getPosition`: it takes a point in `map.terrain` coordinates and returns `{ lat, lon, alt }` (`alt` in meters, `z / zScale`).

```typescript
const { lat, lon, alt } = map.getLocation({ x, y, z })
```

`pick` finds the terrain under a ray — typically the mouse pointer — and returns its geolocation plus the hit `point` in world coordinates, or `undefined` if the ray misses the loaded tiles. Transforms of `map.terrain` are taken into account.

```typescript
const raycaster = new Raycaster()

renderer.domElement.addEventListener('click', (event) => {
  const pointer = new Vector2(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1
  )
  raycaster.setFromCamera(pointer, camera)

  const hit = map.pick(raycaster) // { lat, lon, alt, point } | undefined
  if (hit) console.log(hit.lat, hit.lon, hit.alt)
})
```

With React Three Fiber the pointer events already carry the hit point (in world coordinates):

```tsx
<primitive
  object={map.terrain}
  onClick={(event) => {
    const { lat, lon, alt } = map.getLocation(
      map.terrain.worldToLocal(event.point.clone())
    )
  }}
/>
```

#### Reset map cache

```typescript
map.clean()
```

Removes every tile from `map.terrain`, aborts pending requests and disposes geometries, materials and textures. Call it when the map is no longer used (e.g. in a React effect cleanup); `map.init()` can be called again afterwards.

## Development

```bash
yarn            # install
yarn dev        # playground (src/ with hot reload) on http://localhost:5173
yarn validate   # typecheck, lint, format check, unit tests, build
yarn test:e2e   # rendering tests in Chromium (WebGL + WebGPU), tile servers mocked
```

The playground accepts `?renderer=webgpu` (`&forceWebGL=1` for its WebGL2 backend), `?lights=0`, `?wireframe=1`, `?segments=40` (`tileSegments`), `?api=osm`, `?nTiles=5` and `?view=top`. Click the terrain to see its geolocation.
See [AGENTS.md](AGENTS.md) for architecture notes and conventions.

## Future list

- [x] Asynchronous analog of the `getPosition` function without passing the altitude parameter (`getTerrainPosition`)
- [ ] Advanced example
- [ ] Base Pin component
- [ ] Base Direction component
- [ ] Vue example
- [x] React example
- [x] Basic example

## License and attributions

The map library code is MIT licensed.

<p>This project is an updated and more advanced version of the <a href="https://github.com/blaze33/map33.js">map33.js</a> library.</p>
