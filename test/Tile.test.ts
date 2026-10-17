import {
  Group,
  MeshLambertMaterial,
  MeshNormalMaterial,
  Texture,
  type BufferAttribute
} from 'three'
import { describe, expect, it, vi } from 'vitest'

import { createQuadTextureMaterial, Map, Source, Tile } from '../src'
import { terrariumPixels } from './helpers'

const createMap = (tileSegments = 4) =>
  new Map({
    source: new Source({ api: 'osm' }),
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
    expect(tile.keyNeighX()).toBe('11/1070/724')
    expect(tile.keyNeighY()).toBe('11/1069/725')
    expect(tile.url()).toBe(
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/11/1069/724.png'
    )
    expect(tile.mapUrl()).toBe('https://tile.openstreetmap.org/11/1069/724.png')
  })

  it('lists the four child tiles in NW, SW, NE, SE order', () => {
    const children = new Tile(createMap(), 11, 10, 20).childrens()

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
    const material = createQuadTextureMaterial(new Texture())
    vi.spyOn(tile, 'buildMaterial').mockResolvedValue(material)

    expect(tile.mesh.material).toBeInstanceOf(MeshNormalMaterial)
    await tile.buildmesh()
    expect(tile.mesh.material).toBe(material)
  })

  it('disposes a texture that arrives after the tile was disposed', async () => {
    const tile = new Tile(createMap(), 11, 0, 0)
    const material = createQuadTextureMaterial(new Texture())
    const dispose = vi.spyOn(material, 'dispose')
    vi.spyOn(tile, 'buildMaterial').mockResolvedValue(material)

    const pending = tile.buildmesh()
    tile.dispose()
    await pending

    expect(dispose).toHaveBeenCalled()
    expect(tile.mesh.material).toBeInstanceOf(MeshNormalMaterial)
  })

  it('releases its mesh resources on dispose', () => {
    const tile = new Tile(createMap(), 11, 0, 0)
    const parent = new Group().add(tile.mesh)
    const map = new Texture()
    const material = new MeshLambertMaterial({ map })
    tile.mesh.material = material

    const geometryDispose = vi.spyOn(tile.geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    const textureDispose = vi.spyOn(map, 'dispose')

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
})
