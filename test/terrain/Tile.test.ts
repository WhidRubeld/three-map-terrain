import {
  Group,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshNormalMaterial,
  Texture,
  type BufferAttribute
} from 'three'
import { describe, expect, it, vi } from 'vitest'

import {
  decodeMapbox,
  type ElevationPixels,
  type ElevationSourceProps,
  Map,
  Source,
  type SourceProps,
  Tile,
  type TileRequest
} from '../../src'
import { loadTextureGrid } from '../../src/terrain/texture'
import { raycastZ, terrariumPixels } from '../support/helpers'

vi.mock('../../src/terrain/texture', () => ({
  // no canvas in Node: a texture stands in for the stitched imagery
  loadTextureGrid: vi.fn(() => Promise.resolve(new Texture()))
}))

const createMap = (
  tileSegments = 4,
  sources: { elevation?: ElevationSourceProps; source?: SourceProps } = {}
) =>
  new Map({
    source: sources.source ?? new Source({ api: 'osm' }),
    elevation: sources.elevation,
    location: { lat: 46.57634, lon: 7.9904 },
    options: { tileSegments, zScale: 0.5 }
  })

const zAt = (tile: Tile, row: number, col: number) =>
  tile.geometry.attributes.position.getZ(
    row * (tile.map.options.tileSegments + 1) + col
  )

const column = (tile: Tile, col: number) =>
  Array.from({ length: tile.map.options.tileSegments + 1 }, (_, row) =>
    zAt(tile, row, col)
  )

const row = (tile: Tile, index: number) =>
  Array.from({ length: tile.map.options.tileSegments + 1 }, (_, col) =>
    zAt(tile, index, col)
  )

describe('Tile', () => {
  it('builds keys and urls', () => {
    const tile = new Tile(createMap(), 11, 1069, 724)

    expect(tile.key()).toBe('11/1069/724')
    expect(tile.url()).toBe(
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/11/1069/724.png'
    )
  })

  it('lists the four child tiles in NW, SW, NE, SE order', () => {
    const children = new Tile(createMap(), 11, 10, 20).children()

    expect(children.map((tile) => tile.key())).toEqual([
      '12/20/40',
      '12/20/41',
      '12/21/40',
      '12/21/41'
    ])
  })

  it('decodes terrarium elevation', () => {
    const tile = new Tile(createMap(), 11, 0, 0)
    tile.computeElevation(terrariumPixels(8, (x, y) => x * 100 - y * 10.5))

    expect(tile.shape).toEqual([8, 8, 4])
    expect(tile.elevation?.[0]).toBe(0)
    expect(tile.elevation?.[7]).toBe(700)
    expect(tile.elevation?.[8 * 3 + 2]).toBeCloseTo(200 - 31.5, 2)
  })

  it('decodes other encodings', () => {
    const tile = new Tile(createMap(), 11, 0, 0)
    // 1000 m in the Mapbox encoding
    tile.computeElevation(
      { width: 1, height: 1, data: [1, 173, 176, 255] },
      decodeMapbox
    )
    expect(tile.elevation?.[0]).toBeCloseTo(1000, 6)
  })

  it('crops the region of an ancestor, bilinearly upsampled', () => {
    const tile = new Tile(createMap(), 11, 0, 0)
    tile.computeElevation(terrariumPixels(8, (x, y) => x * 10 + y * 1000))

    // the south-east quarter: pixel i lies at 4 + i / 2 of the parent
    tile.cropElevation({ left: 0.5, top: 0.5, size: 0.5 })

    const at = (x: number, y: number) => tile.elevation?.[y * 8 + x]
    expect(tile.shape).toEqual([8, 8, 4])
    expect(at(0, 0)).toBe(4040)
    expect(at(1, 0)).toBe(4045) // between parent pixels 4 and 5
    expect(at(1, 1)).toBe(4545)
    // beyond the parent's last pixel: clamped (seams are stitched later)
    expect(at(7, 7)).toBe(7070)
  })

  it('samples elevation onto the whole plane, edges from the edge pixels', () => {
    const tile = new Tile(createMap(4), 11, 0, 0)
    tile.computeElevation(terrariumPixels(8, (x, y) => x + y * 100))
    tile.buildGeometry()

    // 8px / 4 segments → every second pixel, scaled by zScale = 0.5
    expect(zAt(tile, 0, 0)).toBe(0)
    expect(zAt(tile, 0, 1)).toBe(1)
    expect(zAt(tile, 1, 0)).toBe(100)
    expect(zAt(tile, 3, 3)).toBe(303)
    // the seam row/column would be pixel 8 (the neighbour's first pixel):
    // until stitched, it uses the tile's last pixel (7) instead of z = 0
    expect(row(tile, 4)).toEqual([350, 351, 352, 353, 353.5])
    expect(column(tile, 4)).toEqual([3.5, 103.5, 203.5, 303.5, 353.5])
  })

  it('keeps its own edges when the neighbours are not loaded', () => {
    const map = createMap(4)
    const tile = new Tile(map, 11, 0, 0)
    tile.computeElevation(terrariumPixels(8, (x, y) => x + y * 100))
    tile.buildGeometry()
    const before = [...tile.geometry.attributes.position.array]

    const unloadedNeighbour = new Tile(map, 11, 1, 0)
    tile.resolveSeams({ [unloadedNeighbour.key()]: unloadedNeighbour })

    expect([...tile.geometry.attributes.position.array]).toEqual(before)
    expect(tile.seamX || tile.seamY).toBe(false)
  })

  it('copies edges from loaded east and south neighbours', () => {
    const map = createMap(4)
    const height = (tx: number, ty: number) => (x: number, y: number) =>
      (tx * 8 + x) * 3 + (ty * 8 + y) * 1000

    const tiles = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ].map(([x, y]) => {
      const tile = new Tile(map, 11, x, y)
      tile.computeElevation(terrariumPixels(8, height(x, y)))
      tile.buildGeometry()
      return tile
    })
    const [tile, east, south] = tiles
    const cache = Object.fromEntries(tiles.map((t) => [t.key(), t]))

    // neighbours first, as Map does
    for (const t of [...tiles].reverse()) t.resolveSeams(cache)

    expect(column(tile, 4)).toEqual(column(east, 0))
    expect(row(tile, 4)).toEqual(row(south, 0))
    expect(tile.seamX && tile.seamY).toBe(true)
  })

  it('swaps the placeholder material once the texture is loaded', async () => {
    const tile = new Tile(createMap(), 11, 0, 0)
    const texture = new Texture()
    vi.spyOn(tile, 'loadImagery').mockResolvedValue(texture as never)

    expect(tile.mesh.material).toBeInstanceOf(MeshNormalMaterial)
    await tile.loadTexture()
    const material = tile.mesh.material as MeshLambertMaterial
    expect(material).toBeInstanceOf(MeshLambertMaterial)
    expect(material.map).toBe(texture)
  })

  it("makes the material with the map's factory", async () => {
    const map = createMap()
    const custom = new MeshBasicMaterial()
    const create = vi.fn(() => custom)
    map.materialOptions = { ...map.materialOptions, create }
    const tile = new Tile(map, 11, 0, 0)
    const texture = new Texture()
    vi.spyOn(tile, 'loadImagery').mockResolvedValue(texture as never)

    await tile.loadTexture()

    expect(tile.mesh.material).toBe(custom)
    expect(create).toHaveBeenCalledWith({
      texture,
      tile,
      options: map.materialOptions
    })
  })

  it('reloads its texture, discarding a load it replaced', async () => {
    const tile = new Tile(createMap(), 11, 0, 0)
    const stale = new Texture()
    const fresh = new Texture()
    let resolveStale: ((texture: Texture) => void) | undefined
    vi.spyOn(tile, 'loadImagery')
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStale = resolve as (texture: Texture) => void
        })
      )
      .mockResolvedValueOnce(fresh as never)
    const disposeStale = vi.spyOn(stale, 'dispose')

    const first = tile.loadTexture()
    const second = tile.loadTexture()
    await second
    resolveStale?.(stale)
    await first

    expect((tile.mesh.material as MeshLambertMaterial).map).toBe(fresh)
    expect(disposeStale).toHaveBeenCalled()
    await expect(tile.whenTextured()).resolves.toBeUndefined()
  })

  it('disposes the material and texture it replaces, not the placeholder', async () => {
    const tile = new Tile(createMap(), 11, 0, 0)
    const [first, second] = [new Texture(), new Texture()]
    vi.spyOn(tile, 'loadImagery')
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce(second as never)
    const disposeTexture = vi.spyOn(first, 'dispose')

    await tile.loadTexture()
    const disposeMaterial = vi.spyOn(tile.mesh.material, 'dispose')
    await tile.loadTexture()

    expect((tile.mesh.material as MeshLambertMaterial).map).toBe(second)
    expect(disposeTexture).toHaveBeenCalled()
    expect(disposeMaterial).toHaveBeenCalled()
  })

  it('restyles keeping its texture', async () => {
    const map = createMap()
    const tile = new Tile(map, 11, 0, 0)
    const texture = new Texture()
    vi.spyOn(tile, 'loadImagery').mockResolvedValue(texture as never)
    await tile.loadTexture()
    const textured = tile.mesh.material
    const disposeTexture = vi.spyOn(texture, 'dispose')

    map.materialOptions = { ...map.materialOptions, color: 0x00ff00 }
    tile.restyle()

    const material = tile.mesh.material as MeshLambertMaterial
    expect(material).not.toBe(textured)
    expect(material.map).toBe(texture)
    expect(material.color.getHex()).toBe(0x00ff00)
    expect(disposeTexture).not.toHaveBeenCalled()
  })

  it('disposes a texture that arrives after the tile was disposed', async () => {
    const tile = new Tile(createMap(), 11, 0, 0)
    const texture = new Texture()
    const dispose = vi.spyOn(texture, 'dispose')
    vi.spyOn(tile, 'loadImagery').mockResolvedValue(texture as never)

    const pending = tile.loadTexture()
    tile.dispose()
    await pending

    expect(dispose).toHaveBeenCalled()
    expect(tile.mesh.material).toBeInstanceOf(MeshNormalMaterial)
  })

  it('releases its mesh resources and its texture on dispose', async () => {
    const tile = new Tile(createMap(), 11, 0, 0)
    const parent = new Group().add(tile.mesh)
    const texture = new Texture()
    vi.spyOn(tile, 'loadImagery').mockResolvedValue(texture as never)
    await tile.loadTexture()
    const material = tile.mesh.material

    const geometryDispose = vi.spyOn(tile.geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    const textureDispose = vi.spyOn(texture, 'dispose')

    tile.dispose()

    expect(parent.children).toHaveLength(0)
    expect(geometryDispose).toHaveBeenCalled()
    expect(materialDispose).toHaveBeenCalled()
    expect(textureDispose).toHaveBeenCalled()
    expect(tile.loaded).toBe(false)
  })

  it('never disposes the shared placeholder material', () => {
    const tile = new Tile(createMap(), 11, 0, 0)
    const placeholder = tile.mesh.material
    const dispose = vi.spyOn(placeholder, 'dispose')

    tile.dispose()

    expect(dispose).not.toHaveBeenCalled()
    expect(
      (tile.geometry.attributes.position as BufferAttribute).count
    ).toBeGreaterThan(0)
  })

  describe('fetch', () => {
    const pixels = (meters: number): ElevationPixels =>
      terrariumPixels(8, (x, y) => meters + x + y * 10)

    it("loads from the map's elevation source", async () => {
      const load = vi.fn(() => Promise.resolve(pixels(500)))
      const tile = new Tile(createMap(4, { elevation: { load } }), 11, 3, 4)

      await tile.fetch()

      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({ z: 11, x: 3, y: 4 })
      )
      expect(tile.loaded).toBe(true)
      expect(zAt(tile, 0, 0)).toBe(250) // 500 m × zScale 0.5
    })

    it('cuts tiles beyond maxZoom out of the ancestor', async () => {
      const load = vi.fn(() => Promise.resolve(pixels(500)))
      const map = createMap(4, { elevation: { load, maxZoom: 12 } })
      const tile = new Tile(map, 13, 4277, 2894)

      await tile.fetch()

      expect(load).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ z: 12, x: 2138, y: 1447 })
      )
      // 4277 is odd, 2894 even: the north-east quarter, from pixel (4, 0)
      expect(tile.elevation?.[0]).toBe(504)
    })

    it('falls back to the parent of a missing tile', async () => {
      const load = vi.fn(({ z }: { z: number }) =>
        Promise.resolve(z === 13 ? null : pixels(800))
      )
      const tile = new Tile(createMap(4, { elevation: { load } }), 13, 0, 1)

      await tile.fetch()

      expect(load.mock.calls.map(([request]) => request.z)).toEqual([13, 12])
      expect(tile.elevation?.[0]).toBe(840) // pixel (0, 4) of the parent
    })

    it('rejects when neither the tile nor its ancestors exist', async () => {
      const load = vi.fn(() => Promise.resolve(null))
      const tile = new Tile(createMap(4, { elevation: { load } }), 11, 0, 0)

      await expect(tile.fetch()).rejects.toThrow(
        'No elevation tile at 11/0/0 or its ancestors'
      )
    })
  })

  describe('loadImagery', () => {
    const image = {
      width: 256,
      height: 256,
      close: vi.fn()
    } as unknown as ImageBitmap
    const childLoaders = async (tile: Tile) => {
      await tile.loadImagery()
      const [inputs] = vi.mocked(loadTextureGrid).mock.calls.at(-1) ?? []
      if (!inputs) throw new Error('loadTextureGrid was not called')
      return Promise.all(
        inputs.map((input) =>
          typeof input === 'string' ? Promise.resolve(input) : input()
        )
      )
    }

    it('loads the four children through the source', async () => {
      const load = vi.fn((_tile: TileRequest) => Promise.resolve(image))
      const tile = new Tile(createMap(4, { source: { load } }), 11, 10, 20)

      const children = await childLoaders(tile)

      expect(
        load.mock.calls.map(([request]) => [request.z, request.x, request.y])
      ).toEqual([
        [12, 20, 40],
        [12, 20, 41],
        [12, 21, 40],
        [12, 21, 41]
      ])
      expect(children[0]).toEqual({
        image,
        region: { left: 0, top: 0, size: 1 }
      })
    })

    it('loads its own imagery tile, or sixteen, by imageryZoomOffset', async () => {
      const tiles = async (imageryZoomOffset: number) => {
        const load = vi.fn((_tile: TileRequest) => Promise.resolve(image))
        const map = new Map({
          source: { load },
          location: { lat: 46.57634, lon: 7.9904 },
          options: { tileSegments: 4, imageryZoomOffset }
        })
        await childLoaders(new Tile(map, 11, 10, 20))
        return load.mock.calls.map(
          ([{ z, x, y }]) => `${String(z)}/${String(x)}/${String(y)}`
        )
      }

      expect(await tiles(0)).toEqual(['11/10/20'])
      // column by column from the west, each from the north
      const sixteen = await tiles(2)
      expect(sixteen).toHaveLength(16)
      expect(sixteen.slice(0, 5)).toEqual([
        '13/40/80',
        '13/40/81',
        '13/40/82',
        '13/40/83',
        '13/41/80'
      ])
      expect(await tiles(9)).toHaveLength(64)
      expect(await tiles(-2)).toEqual(['11/10/20'])
    })

    it('cuts children beyond maxZoom out of one shared ancestor', async () => {
      const load = vi.fn((_tile: TileRequest) => Promise.resolve(image))
      const tile = new Tile(
        createMap(4, { source: { load, maxZoom: 11 } }),
        11,
        10,
        20
      )

      const children = await childLoaders(tile)

      expect(load).toHaveBeenCalledOnce()
      expect(
        children.map((child) =>
          typeof child === 'string' ? child : child.region
        )
      ).toEqual([
        { left: 0, top: 0, size: 0.5 },
        { left: 0, top: 0.5, size: 0.5 },
        { left: 0.5, top: 0, size: 0.5 },
        { left: 0.5, top: 0.5, size: 0.5 }
      ])
    })

    it('loads nothing without imagery: a plain material', async () => {
      const map = new Map({
        location: { lat: 46.57634, lon: 7.9904 },
        material: { color: 0x336699, wireframe: true }
      })
      const tile = new Tile(map, 11, 10, 20)

      expect(await tile.loadImagery()).toBeNull()
      await tile.loadTexture()

      const material = tile.mesh.material as MeshLambertMaterial
      expect(loadTextureGrid).not.toHaveBeenCalled()
      expect(material.map).toBeNull()
      expect(material.color.getHex()).toBe(0x336699)
      expect(material.wireframe).toBe(true)
    })

    it("hands the map's process the stitched canvas and the tile", async () => {
      const load = vi.fn((_tile: TileRequest) => Promise.resolve(image))
      const process = vi.fn()
      const map = createMap(4, { source: { load } })
      map.materialOptions = { ...map.materialOptions, process }
      const tile = new Tile(map, 11, 10, 20)

      await tile.loadImagery()
      const [, , processor] = vi.mocked(loadTextureGrid).mock.calls.at(-1) ?? []
      const context = {} as CanvasRenderingContext2D
      await processor?.(context, 512, 256)

      expect(process).toHaveBeenCalledWith(context, {
        width: 512,
        height: 256,
        z: 11,
        x: 10,
        y: 20
      })
    })

    it('fails a texture whose tile and ancestors are all missing', async () => {
      const load = vi.fn(() => Promise.resolve(null))
      const tile = new Tile(createMap(4, { source: { load } }), 11, 10, 20)

      await expect(childLoaders(tile)).rejects.toThrow(
        'No texture tile at 12/20/40 or its ancestors'
      )
    })
  })

  describe('heightAt', () => {
    const bumpyTile = () => {
      const tile = new Tile(createMap(8), 11, 0, 0)
      tile.computeElevation(
        terrariumPixels(
          16,
          (x, y) => 500 + 300 * Math.sin(x * 1.7) * Math.cos(y)
        )
      )
      tile.buildGeometry()
      return tile
    }

    it('follows the rendered triangles exactly', () => {
      const tile = bumpyTile()
      const { tileSize } = tile.map.options

      // a deterministic spread of points, including cell edges and corners
      const points = Array.from({ length: 200 }, (_, i) => [
        (i * 0.618034) % 1,
        (i * 0.414214) % 1
      ])
      points.push([0, 0], [1, 1], [0.5, 0.5], [0.125, 0.875], [1, 0.3])

      for (const [u, v] of points) {
        const x = (u - 0.5) * tileSize
        const y = (0.5 - v) * tileSize
        expect(tile.heightAt(u, v), `u=${u} v=${v}`).toBeCloseTo(
          raycastZ(tile.mesh, x, y),
          6
        )
      }
    })

    it('returns vertex heights at vertices and clamps outside the tile', () => {
      const tile = bumpyTile()

      expect(tile.heightAt(0, 0)).toBe(zAt(tile, 0, 0))
      expect(tile.heightAt(3 / 8, 5 / 8)).toBeCloseTo(zAt(tile, 5, 3), 9)
      expect(tile.heightAt(1, 1)).toBe(zAt(tile, 8, 8))
      expect(tile.heightAt(-1, 2)).toBe(zAt(tile, 8, 0))
    })
  })
})
