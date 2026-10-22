import {
  LineSegments,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Mesh,
  type BufferGeometry,
  MeshStandardMaterial,
  Texture,
  Vector3
} from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Map, type MapOptions, TerrainBase } from '../../../src'
import { terrariumPixels } from '../../support/helpers'

const { loadImageData } = vi.hoisted(() => ({ loadImageData: vi.fn() }))

vi.mock('../../../src/io/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/io/image')>()),
  loadImageData
}))

vi.mock('../../../src/terrain/texture', () => ({
  // no canvas in Node: a texture stands in for the stitched imagery
  loadTextureGrid: vi.fn(() => Promise.resolve(new Texture()))
}))

const location = { lat: 46.57634, lon: 7.9904 }

beforeEach(() => {
  loadImageData.mockResolvedValue(
    terrariumPixels(16, (x, y) => 1000 + 10 * x + 5 * y)
  )
})

const setup = async (
  options: Partial<MapOptions> = {},
  base = new TerrainBase()
) => {
  const map = new Map({
    location,
    options: { nTiles: 3, tileSegments: 4, zScale: 0.1, ...options },
    material: { color: 0xffffff }
  })
  map.addLayer(base)
  await map.init()
  const mesh = base.group.children[0] as Mesh<
    BufferGeometry,
    MeshLambertMaterial
  >
  return { map, base, mesh }
}

/** The base object now in the map. */
const base = (map: Map) => {
  const layer = map.layers.find((l) => l instanceof TerrainBase)
  return layer?.group.children[0] as Mesh<BufferGeometry, MeshLambertMaterial>
}

/** Triangles of the base by the direction they face. */
const faces = (mesh: Mesh) => {
  const normal = mesh.geometry.getAttribute('normal')
  const count: Record<string, number> = {}
  for (let i = 0; i < normal.count; i += 3) {
    const key = new Vector3().fromBufferAttribute(normal, i).toArray().join(',')
    count[key] = (count[key] ?? 0) + 1
  }
  return count
}

describe('TerrainBase', () => {
  it('walls the outer edges only and closes the bottom', async () => {
    const { mesh } = await setup()

    // 3 tiles per side × 4 segments × 2 triangles; 9 floors × 2 triangles
    expect(faces(mesh)).toEqual({
      '0,1,0': 24,
      '0,-1,0': 24,
      '1,0,0': 24,
      '-1,0,0': 24,
      '0,0,-1': 18
    })
  })

  it('walls the outer edges of a grid of any shape', async () => {
    // 2 × 3 tiles, the location's tile (1069, 723) in the west column
    const grid = { minX: 1069, minY: 722, maxX: 1070, maxY: 724 }
    const { mesh } = await setup({ grid })

    // north and south: 2 tiles × 4 segments × 2 triangles, east and west 3
    expect(faces(mesh)).toEqual({
      '0,1,0': 16,
      '0,-1,0': 16,
      '1,0,0': 24,
      '-1,0,0': 24,
      '0,0,-1': 12
    })
  })

  it('reaches depth meters below the lowest terrain', async () => {
    const { map, mesh } = await setup(
      { nTiles: 1 },
      new TerrainBase({ depth: 200 })
    )
    const [tile] = Object.values(map.tileCache)
    const low = tile.geometry.boundingBox?.min.z ?? 0
    mesh.geometry.computeBoundingBox()

    expect(mesh.geometry.boundingBox?.min.z).toBeCloseTo(low - 200 * 0.1, 6)
  })

  it('faces out: counter-clockwise seen from outside', async () => {
    const { mesh } = await setup({ nTiles: 1 })
    const position = mesh.geometry.getAttribute('position')
    const normal = mesh.geometry.getAttribute('normal')
    const [a, b, c, n] = [
      new Vector3(),
      new Vector3(),
      new Vector3(),
      new Vector3()
    ]
    for (let i = 0; i < position.count; i += 3) {
      a.fromBufferAttribute(position, i)
      b.fromBufferAttribute(position, i + 1)
      c.fromBufferAttribute(position, i + 2)
      n.fromBufferAttribute(normal, i)
      const winding = b.sub(a).cross(c.sub(a))
      if (winding.lengthSq() > 0) expect(winding.dot(n)).toBeGreaterThan(0)
    }
  })

  it('follows the tiles: a new one moves the walls, clean() removes it', async () => {
    const { map, base, mesh } = await setup({ nTiles: 1 })
    const before = faces(mesh)['1,0,0']

    await map.addTileSegment(map.center.x + 1, map.center.y)
    const after = base.group.children[0] as Mesh
    expect(faces(after)['0,0,-1']).toBe(4)
    expect(faces(after)['1,0,0']).toBe(before)
    // north and south walls of both tiles
    expect(faces(after)['0,1,0']).toBe(2 * before)

    map.clean()
    expect(base.group.children).toHaveLength(0)
  })

  it('walls the place of a removed tile', async () => {
    const { map, base } = await setup()

    map.removeTileSegment(map.center.x, map.center.y)

    // the hole's sides are walls of the 4 tiles around it, facing into it
    expect(faces(base.group.children[0] as Mesh)).toEqual({
      '0,1,0': 24 + 8,
      '0,-1,0': 24 + 8,
      '1,0,0': 24 + 8,
      '-1,0,0': 24 + 8,
      '0,0,-1': 16
    })
  })

  it('is drawn like the terrain, in a darker shade, or as given', async () => {
    const { map, mesh } = await setup({ nTiles: 1 })
    expect(mesh.material).toBeInstanceOf(MeshLambertMaterial)
    expect(mesh.material.color.r).toBeCloseTo(0.72, 6)
    // in front of the skirts in its planes
    expect(mesh.material).toMatchObject({
      polygonOffset: true,
      polygonOffsetFactor: -1
    })

    map.setMaterial({ lights: false })
    const restyled = base(map)
    expect(restyled.material).toBeInstanceOf(MeshBasicMaterial)

    const own = new MeshStandardMaterial()
    const custom = await setup(
      { nTiles: 1 },
      new TerrainBase({ material: own })
    )
    expect(custom.mesh.material).toBe(own)
  })

  it('is drawn as its outline in wireframe', async () => {
    const { map } = await setup({ nTiles: 1 })

    map.setMaterial({ wireframe: true })

    const lines = base(map) as unknown as LineSegments
    expect(lines).toBeInstanceOf(LineSegments)
    // 4 sides: 4 profile segments, the bottom edge and 2 corners each
    expect(lines.geometry.getAttribute('position').count).toBe(4 * 7 * 2)
  })

  it('detaches: removes the mesh and disposes its material', async () => {
    const { map, base, mesh } = await setup({ nTiles: 1 })
    const dispose = vi.spyOn(mesh.material, 'dispose')

    map.removeLayer(base)

    expect(base.group.parent).toBeNull()
    expect(base.group.children).toHaveLength(0)
    expect(dispose).toHaveBeenCalled()
  })
})
