import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Raycaster,
  Texture,
  Vector3
} from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  defaultMapOptions,
  defaultTextureOptions,
  ElevationSource,
  Map,
  type MapLayer,
  Utils,
  type MapProps,
  Source,
  type Tile
} from '../../src'
import { loadQuadTexture } from '../../src/terrain/quad-texture-material'
import { FakeFileReader } from '../support/browser-fakes'
import { raycastZ, terrariumPixels } from '../support/helpers'

/** The JSON chunk of a GLB. */
const glbJson = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = view.getUint32(12, true)
  return JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + length))
  ) as {
    meshes: unknown[]
    nodes: { matrix?: number[] }[]
  }
}

const { loadImageData } = vi.hoisted(() => ({ loadImageData: vi.fn() }))

vi.mock('../../src/io/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/io/image')>()),
  loadImageData
}))

vi.mock('../../src/terrain/quad-texture-material', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/terrain/quad-texture-material')
  >()),
  // no canvas in Node: a texture stands in for the stitched imagery
  loadQuadTexture: vi.fn(() => Promise.resolve(new Texture()))
}))

const SIZE = 16
const location = { lat: 46.57634, lon: 7.9904 }

/** Smooth terrain that is continuous across tile borders. */
const worldHeight = (tx: number, ty: number) => (x: number, y: number) => {
  const gx = tx * SIZE + x
  const gy = ty * SIZE + y
  return 1000 + 400 * Math.sin(gx / 7) * Math.cos(gy / 5)
}

const tileFromUrl = (url: string) => {
  const match = /(\d+)\/(\d+)\.png$/.exec(url)
  if (!match) throw new Error(`Unexpected elevation url: ${url}`)
  return { x: Number(match[1]), y: Number(match[2]) }
}

const createMap = (props: Partial<MapProps> = {}) =>
  new Map({
    source: new Source({ api: 'eox' }),
    location,
    options: { tileSegments: 8 },
    ...props
  })

const edge = (tile: Tile, axis: 'row' | 'col', index: number) => {
  const n = tile.map.options.tileSegments + 1
  const position = tile.geometry.attributes.position
  return Array.from({ length: n }, (_, i) =>
    position.getZ(axis === 'row' ? index * n + i : i * n + index)
  )
}

const findTile = (map: Map, x: number, y: number): Tile | undefined =>
  map.tileCache[`${map.options.zoom}/${x}/${y}`]

const tileAt = (map: Map, x: number, y: number): Tile => {
  const tile = findTile(map, x, y)
  if (!tile) throw new Error(`Tile ${x}/${y} is not cached`)
  return tile
}

beforeEach(() => {
  loadImageData.mockImplementation((url: string) => {
    const { x, y } = tileFromUrl(url)
    return Promise.resolve(terrariumPixels(SIZE, worldHeight(x, y)))
  })
})

describe('Map', () => {
  it('merges options without mutating the shared defaults', () => {
    const map = createMap({
      options: { tileSegments: 1000, zoom: 12 },
      material: { lights: false }
    })

    expect(map.options).toEqual({
      ...defaultMapOptions,
      zoom: 12,
      tileSegments: 256
    })
    expect(map.materialOptions).toEqual({
      ...defaultTextureOptions,
      lights: false
    })
    expect(defaultTextureOptions.lights).toBe(true)
    expect(map.center).toEqual({ x: 2138, y: 1447 })
  })

  it('loads an nTiles × nTiles grid, then reports ready', async () => {
    const map = createMap()
    const cb = vi.fn(() => {
      expect(map.terrain.children).toHaveLength(9)
    })

    await map.init(cb)

    expect(cb).toHaveBeenCalledOnce()
    expect(map.ready).toBe(true)
    expect(loadImageData).toHaveBeenCalledTimes(9)
    expect(Object.keys(map.tileCache).sort()).toEqual(
      [1068, 1069, 1070]
        .flatMap((x) => [722, 723, 724].map((y) => `11/${x}/${y}`))
        .sort()
    )
    expect(tileAt(map, 1069, 723).mesh.position.toArray()).toEqual([0, 0, 0])
    expect(tileAt(map, 1070, 724).mesh.position.toArray()).toEqual([
      600, -600, 0
    ])
  })

  it('stitches seams between every pair of neighbours', async () => {
    const map = createMap()
    await map.init()

    for (const tile of Object.values(map.tileCache)) {
      const east = findTile(map, tile.x + 1, tile.y)
      const south = findTile(map, tile.x, tile.y + 1)
      const n = map.options.tileSegments

      if (east) expect(edge(tile, 'col', n)).toEqual(edge(east, 'col', 0))
      if (south) expect(edge(tile, 'row', n)).toEqual(edge(south, 'row', 0))
    }
  })

  it('never shows walls or cracks while tiles are still loading', async () => {
    const pending = new globalThis.Map<string, () => void>()
    loadImageData.mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          const { x, y } = tileFromUrl(url)
          pending.set(`${x}/${y}`, () => {
            resolve(terrariumPixels(SIZE, worldHeight(x, y)))
          })
        })
    )
    const map = createMap()
    const done = map.init()
    const n = map.options.tileSegments

    // corners first, then the tiles between them: every edge case of
    // "neighbour loaded before / after me"
    const order = [
      '1070/724',
      '1068/722',
      '1069/723',
      '1068/724',
      '1070/722',
      '1069/722',
      '1068/723',
      '1070/723',
      '1069/724'
    ]
    for (const [step, key] of order.entries()) {
      pending.get(key)?.()
      await vi.waitFor(() => {
        expect(map.terrain.children).toHaveLength(step + 1)
      })

      const loaded = Object.values(map.tileCache).filter((t) => t.loaded)
      for (const tile of loaded) {
        // terrain is 600–1400 m high: z = 0 would be a wall down to the ground
        const { array } = tile.geometry.attributes.position
        for (let i = 2; i < array.length; i += 3) {
          expect(array[i], `${tile.key()} after ${key}`).toBeGreaterThan(0)
        }
        const east = findTile(map, tile.x + 1, tile.y)
        const south = findTile(map, tile.x, tile.y + 1)
        if (east?.loaded) {
          expect(edge(tile, 'col', n)).toEqual(edge(east, 'col', 0))
        }
        if (south?.loaded) {
          expect(edge(tile, 'row', n)).toEqual(edge(south, 'row', 0))
        }
      }
    }

    await done
    expect(map.ready).toBe(true)
  })

  it('applies textured materials honouring the material options', async () => {
    const lit = createMap()
    const unlit = createMap({ material: { lights: false, wireframe: true } })
    await Promise.all([lit.init(), unlit.init()])

    await vi.waitFor(() => {
      for (const tile of Object.values(lit.tileCache)) {
        expect(tile.mesh.material).toBeInstanceOf(MeshLambertMaterial)
      }
      for (const tile of Object.values(unlit.tileCache)) {
        expect(tile.mesh.material).toBeInstanceOf(MeshBasicMaterial)
        expect(tile.mesh.material).toMatchObject({ wireframe: true })
      }
    })
  })

  it('keeps going when a tile fails to load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    loadImageData.mockImplementationOnce(() => Promise.reject(new Error('404')))

    const map = createMap()
    await map.init()

    expect(map.ready).toBe(true)
    expect(map.terrain.children).toHaveLength(8)
    expect(error).toHaveBeenCalledWith(new Error('404'))
  })

  it('ignores aborted requests silently', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    loadImageData.mockImplementation(() =>
      Promise.reject(new DOMException('aborted', 'AbortError'))
    )

    await createMap().init()

    expect(error).not.toHaveBeenCalled()
  })

  it('discards tiles that finish loading after clean()', async () => {
    const map = createMap()
    const cb = vi.fn()
    const pending = map.init(cb)
    map.clean()
    await pending

    expect(map.terrain.children).toHaveLength(0)
    expect(map.tileCache).toEqual({})
    expect(map.ready).toBe(false)
    expect(cb).not.toHaveBeenCalled()
  })

  it('survives init → clean → init (React StrictMode)', async () => {
    const map = createMap()
    const first = vi.fn()
    const second = vi.fn()

    const stale = map.init(first)
    map.clean()
    await Promise.all([stale, map.init(second)])

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    expect(map.ready).toBe(true)
    expect(map.terrain.children).toHaveLength(9)
  })

  it('shares one load between concurrent init() calls', async () => {
    const map = createMap()
    const first = vi.fn()
    const second = vi.fn()

    await Promise.all([map.init(first), map.init(second)])

    expect(loadImageData).toHaveBeenCalledTimes(9)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(map.terrain.children).toHaveLength(9)
  })

  it('clean() disposes every tile', async () => {
    const map = createMap()
    await map.init()
    const tiles = Object.values(map.tileCache)
    const spies = tiles.map((tile) => vi.spyOn(tile, 'dispose'))

    map.clean()

    for (const spy of spies) expect(spy).toHaveBeenCalledOnce()
    expect(map.terrain.children).toHaveLength(0)
    expect(map.ready).toBe(false)
  })

  describe('runtime style', () => {
    const materialOf = (map: Map) =>
      tileAt(map, 1069, 723).mesh.material as MeshLambertMaterial

    it('switches the imagery off and on with setSource()', async () => {
      const map = createMap()
      await map.init()
      await map.whenReady()
      const textured = materialOf(map)
      expect(textured.map).toBeInstanceOf(Texture)

      map.setSource({ api: 'none' })
      await map.whenReady()
      expect(materialOf(map).map).toBeNull()
      expect(map.source.api).toBe('none')

      map.setSource(new Source({ api: 'osm' }))
      await map.whenReady()
      expect(materialOf(map).map).toBeInstanceOf(Texture)
      expect(map.attributions[0]).toContain('OpenStreetMap')
    })

    it('restyles with setMaterial(), keeping the textures', async () => {
      const map = createMap()
      await map.init()
      await map.whenReady()
      const { map: texture } = materialOf(map)
      const layer = { materialChanged: vi.fn() }
      map.addLayer(layer)
      vi.mocked(loadQuadTexture).mockClear()

      map.setMaterial({ color: 0x808080, wireframe: true })

      const material = materialOf(map)
      expect(material.map).toBe(texture)
      expect(material.color.getHex()).toBe(0x808080)
      expect(material.wireframe).toBe(true)
      expect(loadQuadTexture).not.toHaveBeenCalled()
      expect(layer.materialChanged).toHaveBeenCalledWith(map)

      map.setMaterial({ lights: false })
      expect(materialOf(map)).toBeInstanceOf(MeshBasicMaterial)
    })

    it('applies a setMaterial() made right after setSource()', async () => {
      const map = createMap({ source: { api: 'none' } })
      await map.init()
      await map.whenReady()

      // a look switch: both in one go, the imagery staying off
      map.setSource({ api: 'none' })
      map.setMaterial({ wireframe: true, color: 0x123456 })
      await map.whenReady()

      const material = materialOf(map)
      expect(material.wireframe).toBe(true)
      expect(material.color.getHex()).toBe(0x123456)
      expect(material.map).toBeNull()
    })

    it('restyles a texture still loading when it arrives', async () => {
      const map = createMap()
      await map.init()
      await map.whenReady()

      map.setSource({ api: 'osm' })
      map.setMaterial({ color: 0x00ff00 })
      await map.whenReady()

      const material = materialOf(map)
      expect(material.map).toBeInstanceOf(Texture)
      expect(material.color.getHex()).toBe(0x00ff00)
    })

    it('reloads the imagery for a new filter', async () => {
      const map = createMap()
      await map.init()
      await map.whenReady()
      vi.mocked(loadQuadTexture).mockClear()

      map.setMaterial({ filter: 'grayscale(1)' })
      await map.whenReady()

      expect(loadQuadTexture).toHaveBeenCalledTimes(9)
      expect(vi.mocked(loadQuadTexture).mock.calls[0][2]).toBe('grayscale(1)')
    })
  })

  describe('whenReady', () => {
    it('waits for the textures and the layers', async () => {
      let release: (() => void) | undefined
      vi.mocked(loadQuadTexture).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => {
              resolve(
                new Texture() as Awaited<ReturnType<typeof loadQuadTexture>>
              )
            }
          })
      )
      const map = createMap()
      const layerReady = vi.fn(() => Promise.resolve())
      map.addLayer({ whenReady: layerReady })
      void map.init()
      let ready = false
      void map.whenReady().then(() => (ready = true))

      await map.init()
      await vi.waitFor(() => {
        expect(loadQuadTexture).toHaveBeenCalledTimes(9)
      })
      expect(ready).toBe(false)
      release?.()
      await vi.waitFor(() => {
        expect(ready).toBe(true)
      })
      expect(layerReady).toHaveBeenCalled()
    })
  })

  describe('grid and bounds', () => {
    it('gives the init() grid in tiles and degrees', () => {
      const map = createMap({ options: { nTiles: 3 } })

      expect(map.grid).toEqual({
        zoom: 11,
        minX: 1068,
        minY: 722,
        maxX: 1070,
        maxY: 724
      })
      const [west, south, east, north] = map.bounds
      expect([west, north]).toEqual(
        Utils.tile2bbox([1068, 722, 11]).filter((_, i) => i === 0 || i === 3)
      )
      expect([south, east]).toEqual(
        Utils.tile2bbox([1070, 724, 11]).filter((_, i) => i === 1 || i === 2)
      )
      expect(west).toBeLessThan(location.lon)
      expect(north).toBeGreaterThan(location.lat)
    })
  })

  describe('export', () => {
    beforeEach(() => {
      vi.stubGlobal('FileReader', FakeFileReader)
    })

    it('exports the tiles and layers as GLB, in meters', async () => {
      const map = createMap({ source: { api: 'none' } })
      const marker = new Mesh(new BoxGeometry(), new MeshBasicMaterial())
      map.terrain.add(marker)
      await map.init()

      const blob = await map.export('glb')
      const json = glbJson(new Uint8Array(await blob.arrayBuffer()))

      expect(blob.type).toBe('model/gltf-binary')
      // 9 tiles and the marker
      expect(json.meshes).toHaveLength(10)
      const scale = Utils.tileWidth(location.lat, 11) / 600
      expect(json.nodes[0].matrix?.[0]).toBeCloseTo(scale, 6)
    })

    it('leaves out the layers and keeps scene units when asked to', async () => {
      const map = createMap({ source: { api: 'none' } })
      map.terrain.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()))
      await map.init()

      const blob = await map.export('glb', { layers: false, units: 'scene' })
      const json = glbJson(new Uint8Array(await blob.arrayBuffer()))

      expect(json.meshes).toHaveLength(9)
      expect(json.nodes[0].matrix?.[0]).toBeCloseTo(1, 9)
    })

    it('exports STL for 3D printing', async () => {
      const map = createMap({
        source: { api: 'none' },
        options: { nTiles: 1, tileSegments: 2 }
      })
      await map.init()

      const view = new DataView(await (await map.export('stl')).arrayBuffer())

      expect(view.getUint32(80, true)).toBe(2 * 2 * 2)
    })
  })

  describe('vertical scale', () => {
    it('sets zScale from an exaggeration of true scale', () => {
      const map = createMap({ options: { zoom: 15, exaggeration: 2 } })
      const trueScale = 600 / Utils.tileWidth(location.lat, 15)

      expect(map.options.zScale).toBeCloseTo(2 * trueScale, 12)
    })

    it('draws baseAltitude at z = 0, in the mesh and in positions', async () => {
      const lifted = createMap()
      const based = createMap({
        options: { tileSegments: 8, baseAltitude: 1000 }
      })
      await Promise.all([lifted.init(), based.init()])
      const { zScale } = lifted.options
      const ground = (map: Map) =>
        tileAt(map, 1069, 723).geometry.attributes.position.getZ(10)

      expect(ground(based)).toBeCloseTo(ground(lifted) - 1000 * zScale, 6)
      expect(based.getPosition({ ...location, alt: 1500 }).z).toBeCloseTo(
        500 * zScale,
        9
      )
      const surface = await based.getTerrainPosition(location)
      expect(based.getLocation(surface).alt).toBeCloseTo(
        (await lifted.getTerrainPosition(location)).z / zScale,
        3 // float32 vertices
      )
    })
  })

  describe('getPosition', () => {
    it('projects a location onto the terrain plane', async () => {
      const map = createMap()
      await map.init()

      const { x, y, z } = map.getPosition({ ...location, alt: 3000 })
      const half = map.options.tileSize / 2

      expect(Math.abs(x)).toBeLessThan(half)
      expect(Math.abs(y)).toBeLessThan(half)
      expect(z).toBeCloseTo(3000 * map.options.zScale)
    })

    it('lazily loads the tile under the location and stitches it', async () => {
      const map = createMap()
      await map.init()

      // ~2 tiles east of the center tile
      const lon = location.lon + (2 * 360) / 2 ** map.options.zoom
      map.getPosition({ lat: location.lat, lon, alt: 0 })

      await vi.waitFor(() => {
        expect(findTile(map, 1071, 723)?.loaded).toBe(true)
      })
      expect(map.terrain.children).toHaveLength(10)

      const n = map.options.tileSegments
      expect(edge(tileAt(map, 1070, 723), 'col', n)).toEqual(
        edge(tileAt(map, 1071, 723), 'col', 0)
      )
    })

    it('does not load tiles when loadTile is false', async () => {
      const map = createMap()
      await map.init()

      const lon = location.lon + (2 * 360) / 2 ** map.options.zoom
      map.getPosition({ lat: location.lat, lon, alt: 0 }, { loadTile: false })

      expect(Object.keys(map.tileCache)).toHaveLength(9)
    })
  })

  describe('getTerrainPosition', () => {
    const east2 = {
      lat: location.lat,
      lon: location.lon + (2 * 360) / 2 ** defaultMapOptions.zoom
    }

    it('puts the point on the rendered surface', async () => {
      const map = createMap()
      await map.init()

      const point = await map.getTerrainPosition(location)
      const { x, y } = map.getPosition({ ...location, alt: 0 })

      expect([point.x, point.y]).toEqual([x, y])
      expect(point.z).toBeCloseTo(raycastZ(map.terrain, x, y), 6)
      expect(point.z).toBeGreaterThan(600 * map.options.zScale)
    })

    it('waits for a tile that is still loading', async () => {
      const map = createMap()
      const init = map.init()

      const point = await map.getTerrainPosition(location)

      expect(point.z).toBeCloseTo(raycastZ(map.terrain, point.x, point.y), 6)
      await init
    })

    it('loads the tile under the location first', async () => {
      const map = createMap()
      await map.init()

      const point = await map.getTerrainPosition(east2)

      expect(findTile(map, 1071, 723)?.loaded).toBe(true)
      expect(loadImageData).toHaveBeenCalledTimes(10)
      expect(point.z).toBeCloseTo(raycastZ(map.terrain, point.x, point.y), 6)
    })

    it('rejects when the tile cannot be loaded', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const map = createMap()
      await map.init()
      loadImageData.mockRejectedValueOnce(new Error('404'))

      await expect(map.getTerrainPosition(east2)).rejects.toThrow(
        'No terrain loaded at'
      )
    })

    it('rejects when the map is cleaned meanwhile', async () => {
      const map = createMap()
      const pending = map.getTerrainPosition(location)
      map.clean()

      await expect(pending).rejects.toThrow('No terrain loaded at')
    })
  })

  describe('getTerrainPositionSync', () => {
    const east2 = {
      lat: location.lat,
      lon: location.lon + (2 * 360) / 2 ** defaultMapOptions.zoom
    }

    it('matches getTerrainPosition where the terrain is loaded', async () => {
      const map = createMap()
      await map.init()

      for (const dLon of [-0.1, 0, 0.05]) {
        const where = { lat: location.lat + dLon / 2, lon: location.lon + dLon }
        expect(map.getTerrainPositionSync(where)).toEqual(
          await map.getTerrainPosition(where)
        )
      }
    })

    it('returns undefined while the tile loads, then the position', async () => {
      const map = createMap()
      await map.init()

      expect(map.getTerrainPositionSync(east2)).toBeUndefined()
      expect(loadImageData).toHaveBeenCalledTimes(10)

      await vi.waitFor(() => {
        expect(map.getTerrainPositionSync(east2)).toBeDefined()
      })
      const point = map.getTerrainPositionSync(east2)
      expect(point?.z).toBeCloseTo(
        raycastZ(map.terrain, point?.x ?? 0, point?.y ?? 0),
        6
      )
    })

    it('does not load anything with loadTile: false', async () => {
      const map = createMap()
      await map.init()

      expect(
        map.getTerrainPositionSync(east2, { loadTile: false })
      ).toBeUndefined()
      expect(loadImageData).toHaveBeenCalledTimes(9)
    })
  })

  describe('getLocation', () => {
    // zoom 9 puts the center on an odd tile: tile2position then shifts the
    // whole grid by half a tile, which the inverse must reproduce
    it.each([9, 11, 14])('inverts getPosition at zoom %i', (zoom) => {
      const map = createMap({ options: { zoom } })
      const span = 360 / 2 ** zoom

      for (let i = -6; i <= 6; i++) {
        for (let j = -6; j <= 6; j++) {
          const where = {
            lat: location.lat + (i * span) / 4.3,
            lon: location.lon + (j * span) / 3.7,
            alt: 1000 + i * j
          }
          const back = map.getLocation(
            map.getPosition(where, { loadTile: false })
          )

          expect(back.lat).toBeCloseTo(where.lat, 9)
          expect(back.lon).toBeCloseTo(where.lon, 9)
          expect(back.alt).toBeCloseTo(where.alt, 9)
        }
      }
    })

    it('maps the scene origin into the center tile', () => {
      const map = createMap()
      const [w, s, e, n] = Utils.tile2bbox([1069, 723, 11])
      const { lat, lon } = map.getLocation({ x: 0, y: 0, z: 0 })

      expect(lon).toBeCloseTo((w + e) / 2, 12)
      expect(lat).toBeCloseTo((s + n) / 2, 12)
    })
  })

  describe('pick', () => {
    const rayDown = (point: Vector3) =>
      new Raycaster(
        new Vector3(point.x, point.y, point.z + 1e5),
        new Vector3(0, 0, -1)
      )

    it('returns the location under a ray', async () => {
      const map = createMap()
      await map.init()
      const where = { lat: location.lat + 0.02, lon: location.lon - 0.03 }
      const ground = await map.getTerrainPosition(where)

      const hit = map.pick(rayDown(new Vector3(ground.x, ground.y, ground.z)))

      expect(hit?.lat).toBeCloseTo(where.lat, 9)
      expect(hit?.lon).toBeCloseTo(where.lon, 9)
      expect(hit?.alt).toBeCloseTo(ground.z / map.options.zScale, 4)
      expect(hit?.point.z).toBeCloseTo(ground.z, 6)
    })

    it('accounts for transforms of map.terrain', async () => {
      const map = createMap()
      await map.init()
      map.terrain.position.set(1000, -500, 20)
      map.terrain.rotation.z = 0.3
      map.terrain.scale.setScalar(2)
      const ground = await map.getTerrainPosition(location)

      map.terrain.updateMatrixWorld()
      const world = map.terrain.localToWorld(
        new Vector3(ground.x, ground.y, ground.z)
      )
      const hit = map.pick(rayDown(world))

      expect(hit?.lat).toBeCloseTo(location.lat, 9)
      expect(hit?.lon).toBeCloseTo(location.lon, 9)
      expect(hit?.point.distanceTo(world)).toBeLessThan(1e-6)
    })

    it('returns undefined when the ray misses the terrain', async () => {
      const map = createMap()
      await map.init()

      expect(map.pick(rayDown(new Vector3(1e4, 1e4, 0)))).toBeUndefined()
    })
  })

  describe('sources', () => {
    it('accepts props instead of instances', () => {
      const map = createMap({
        source: { url: 'https://img/{z}/{x}/{y}.jpg', attribution: '© Img' },
        elevation: { api: 'mapterhorn' }
      })

      expect(map.source).toBeInstanceOf(Source)
      expect(map.source.mapUrl(1, 0, 1)).toBe('https://img/1/0/1.jpg')
      expect(map.elevation).toBeInstanceOf(ElevationSource)
      expect(map.elevation.api).toBe('mapterhorn')
    })

    it('uses AWS terrain tiles by default', () => {
      expect(createMap().elevation.api).toBe('aws')
    })

    it('has no imagery without a source: a plain material in its color', async () => {
      const map = new Map({
        location,
        options: { tileSegments: 8 },
        material: { color: '#d8d2c6' }
      })
      await map.init()

      expect(map.source.api).toBe('none')
      await vi.waitFor(() => {
        for (const tile of Object.values(map.tileCache)) {
          const { material } = tile.mesh
          expect(material).toBeInstanceOf(MeshLambertMaterial)
          expect(material).toMatchObject({ map: null })
        }
      })
      const { material } = tileAt(map, 1069, 723).mesh
      expect((material as MeshLambertMaterial).color.getHexString()).toBe(
        'd8d2c6'
      )
    })

    it('lists the attributions of every source and layer once', () => {
      const map = createMap({
        source: { api: 'osm' },
        elevation: { url: 'u', attribution: '© OpenStreetMap contributors' }
      })
      map.addLayer({ attribution: '© Buildings' })
      map.addLayer({})

      expect(map.attributions).toEqual([
        '© OpenStreetMap contributors',
        '© Buildings'
      ])
    })
  })

  describe('layers', () => {
    const recordingLayer = () => {
      const events: string[] = []
      const attach = vi.fn(() => events.push('attach'))
      const detach = vi.fn(() => events.push('detach'))
      const tileRemoved = vi.fn((tile: Tile) =>
        events.push(`removed ${tile.key()}`)
      )
      const layer: MapLayer = {
        attach,
        detach,
        tileRemoved,
        tileLoaded: (tile: Tile) => {
          events.push(`loaded ${tile.key()}`)
          // the tile is already stitched and in the scene
          expect(tile.loaded).toBe(true)
          expect(tile.mesh.parent).not.toBeNull()
        }
      }
      return { layer, events, attach, detach, tileRemoved }
    }

    it('tells a layer about every tile, loaded before or after it was added', async () => {
      const map = createMap()
      const early = recordingLayer()
      map.addLayer(early.layer)
      await map.init()
      const late = recordingLayer()
      expect(map.addLayer(late.layer)).toBe(late.layer)

      for (const { events } of [early, late]) {
        expect(events[0]).toBe('attach')
        expect(events.filter((e) => e.startsWith('loaded'))).toHaveLength(9)
      }
      expect(map.layers).toEqual([early.layer, late.layer])
    })

    it('also for tiles loaded on demand', async () => {
      const map = createMap()
      const { layer, events } = recordingLayer()
      map.addLayer(layer)
      await map.init()

      await map.getTerrainPosition({
        lat: location.lat,
        lon: location.lon + (2 * 360) / 2 ** defaultMapOptions.zoom
      })

      expect(events).toContain('loaded 11/1071/723')
    })

    it('removes tiles from layers on clean() and keeps the layers', async () => {
      const map = createMap()
      const { layer, events } = recordingLayer()
      map.addLayer(layer)
      await map.init()

      map.clean()
      expect(events.filter((e) => e.startsWith('removed'))).toHaveLength(9)
      expect(map.layers).toEqual([layer])

      await map.init()
      expect(events.filter((e) => e.startsWith('loaded'))).toHaveLength(18)
    })

    it('detaches removed layers, once', async () => {
      const map = createMap()
      const { layer, attach, detach, tileRemoved } = recordingLayer()
      map.addLayer(layer)
      map.addLayer(layer)
      await map.init()

      map.removeLayer(layer)
      map.removeLayer(layer)

      expect(attach).toHaveBeenCalledOnce()
      expect(detach).toHaveBeenCalledOnce()
      expect(map.layers).toEqual([])
      map.clean()
      expect(tileRemoved).not.toHaveBeenCalled()
    })

    it('keeps loading when a layer throws', async () => {
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      const map = createMap()
      map.addLayer({
        tileLoaded: () => {
          throw new Error('layer bug')
        }
      })

      await map.init()

      expect(map.terrain.children).toHaveLength(9)
      expect(error).toHaveBeenCalledWith(new Error('layer bug'))
    })
  })

  it('keeps bounding volumes in sync with the stitched heights', async () => {
    const map = createMap()
    await map.init()

    for (const tile of Object.values(map.tileCache)) {
      const { boundingBox, boundingSphere, attributes } = tile.geometry
      const vertex = new Vector3()
      for (let i = 0; i < attributes.position.count; i++) {
        vertex.fromBufferAttribute(attributes.position, i)
        expect(boundingBox?.containsPoint(vertex)).toBe(true)
        // radius² vs distance² may differ by one ulp for the farthest vertex
        expect(
          vertex.distanceTo(boundingSphere?.center ?? vertex) -
            (boundingSphere?.radius ?? -1)
        ).toBeLessThan(1e-9)
      }
    }
  })
})
