import {
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
  Map,
  Utils,
  type MapProps,
  Source,
  type Tile
} from '../src'
import { raycastZ, terrariumPixels } from './helpers'

const { loadImageData } = vi.hoisted(() => ({ loadImageData: vi.fn() }))

vi.mock('../src/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/image')>()),
  loadImageData
}))

vi.mock('../src/quad-texture-material', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/quad-texture-material')>()
  return {
    ...actual,
    QuadTextureMaterial: vi.fn(
      (
        _urls: unknown,
        options: Parameters<typeof actual.QuadTextureMaterial>[1]
      ) =>
        Promise.resolve(
          actual.createQuadTextureMaterial(new Texture(), options)
        )
    )
  }
})

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
