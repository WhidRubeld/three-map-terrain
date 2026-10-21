import {
  Color,
  type InstancedMesh,
  Matrix4,
  Raycaster,
  Texture,
  Vector3
} from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CROWN_COLOR,
  Map,
  type TileRequest,
  type TreeFeature,
  Trees,
  treesFromOverpass,
  treesFromVectorTile,
  Utils,
  Water,
  type WaterFeature
} from '../../../src'
import { terrariumPixels } from '../../support/helpers'
import { encodeVectorTile } from '../../support/mvt-encoder'

const { loadImageData } = vi.hoisted(() => ({ loadImageData: vi.fn() }))

vi.mock('../../../src/io/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/io/image')>()),
  loadImageData
}))

vi.mock('../../../src/terrain/material', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/terrain/material')>()),
  loadQuadTexture: vi.fn(() => Promise.resolve(new Texture()))
}))

const ZOOM = 15
const SIZE = 16
const location = { lat: 46.948, lon: 7.4474 }
const center = Utils.position2tile(location.lat, location.lon, ZOOM)

const ground = (gx: number, gy: number) =>
  600 + 20 * Math.sin(gx / 3) + 15 * Math.cos(gy / 2.5)

beforeEach(() => {
  loadImageData.mockImplementation((url: string) => {
    const [x, y] = (/\d+\/(\d+)\/(\d+)\.png$/.exec(url) ?? [])
      .slice(1)
      .map(Number)
    return Promise.resolve(
      terrariumPixels(SIZE, (px, py) => ground(x * SIZE + px, y * SIZE + py))
    )
  })
})

const lonLat = (fx: number, fy: number) => [
  Utils.tile2lon(center.x + fx, ZOOM),
  Utils.tile2lat(center.y + fy, ZOOM)
]

const wood = (x0: number, y0: number, x1: number, y1: number): TreeFeature => ({
  id: `wood ${x0}`,
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        lonLat(x0, y0),
        lonLat(x1, y0),
        lonLat(x1, y1),
        lonLat(x0, y1),
        lonLat(x0, y0)
      ]
    ]
  },
  properties: {}
})

const setup = async (
  trees: TreeFeature[],
  options: Partial<ConstructorParameters<typeof Trees>[0]> = {}
) => {
  const load = vi.fn((_tile: TileRequest) => Promise.resolve(trees))
  const map = new Map({
    source: { api: 'eox' },
    location,
    options: { zoom: ZOOM, tileSegments: 8, exaggeration: 1 }
  })
  const layer = map.addLayer(
    new Trees({ source: { load, minZoom: ZOOM, maxZoom: ZOOM }, ...options })
  )
  await map.init()
  await layer.whenReady()
  return { map, layer }
}

const copies = (layer: Trees, part: 'crowns' | 'trunks') =>
  layer.group.children.filter((object) =>
    object.name.startsWith(`trees ${part} `)
  ) as InstancedMesh[]

/** Where every copy stands, in map.terrain coordinates. */
const positions = (layer: Trees, part: 'crowns' | 'trunks') => {
  const matrix = new Matrix4()
  return copies(layer, part).flatMap((mesh) =>
    Array.from({ length: mesh.count }, (_, i) => {
      mesh.getMatrixAt(i, matrix)
      return new Vector3().setFromMatrixPosition(matrix).add(mesh.position)
    })
  )
}

describe('Trees', () => {
  it('fills a wood with trees standing on the terrain, never twice at tile edges', async () => {
    // across the center tile and its eastern neighbour
    const { map, layer } = await setup([wood(0.7, 0.3, 1.3, 0.5)], {
      spacing: 10
    })
    const trunks = positions(layer, 'trunks')
    const meters = Utils.tileWidth(location.lat, ZOOM)
    const area = 0.6 * 0.2 * meters ** 2

    // about one tree per 10 × 10 m
    expect(trunks.length).toBeGreaterThan((area / 100) * 0.8)
    expect(trunks.length).toBeLessThan((area / 100) * 1.2)
    expect(copies(layer, 'trunks')).toHaveLength(2)
    const keys = new Set(
      trunks.map((p) => `${p.x.toFixed(3)} ${p.y.toFixed(3)}`)
    )
    expect(keys.size).toBe(trunks.length)
    // trunks start just under the ground
    for (const p of trunks.slice(0, 50)) {
      const location = map.getLocation(p)
      const surface = map.getTerrainPositionSync(location, { loadTile: false })
      expect(surface && surface.z - p.z).toBeCloseTo(
        0.5 * map.options.zScale,
        3
      )
    }
  })

  it('plants the same trees every time a tile is drawn', async () => {
    const { layer } = await setup([wood(0.2, 0.2, 0.5, 0.5)])
    const before = positions(layer, 'crowns').map((p) => p.toArray().join())

    layer.invalidate()
    await layer.whenReady()

    expect(positions(layer, 'crowns').map((p) => p.toArray().join())).toEqual(
      before
    )
  })

  it('stands single trees where they are, as high as they are', async () => {
    const tree: TreeFeature = {
      geometry: { type: 'Point', coordinates: lonLat(0.5, 0.5) },
      height: 20,
      properties: {}
    }
    const { map, layer } = await setup([tree])
    const [crown] = copies(layer, 'crowns')
    const matrix = new Matrix4()
    crown.getMatrixAt(0, matrix)
    const scale = new Vector3().setFromMatrixScale(matrix)

    expect(crown.count).toBe(1)
    // a crown 62 % of the height, its half as the z radius
    expect(scale.z / map.options.zScale).toBeCloseTo(20 * 0.62 * 0.5, 6)
  })

  it('caps the trees of a tile', async () => {
    const { layer } = await setup([wood(0.1, 0.1, 0.9, 0.9)], {
      maxPerTile: 50
    })
    expect(copies(layer, 'trunks')[0].count).toBe(50)
  })

  it('picks the wood of a tree, and highlights its trees', async () => {
    const forest = wood(0.2, 0.2, 0.5, 0.5)
    const tree: TreeFeature = {
      id: 'single',
      geometry: { type: 'Point', coordinates: lonLat(0.8, 0.8) },
      properties: {}
    }
    const { map, layer } = await setup([forest, tree])
    const [crowns] = copies(layer, 'crowns')
    const position = positions(layer, 'crowns').at(-1)
    if (!position) throw new Error('no tree')
    map.terrain.updateMatrixWorld(true)
    const raycaster = new Raycaster(
      map.terrain.localToWorld(position.clone().setZ(1e6)),
      new Vector3(0, 0, -1)
    )

    expect(layer.pick(raycaster)?.feature).toBe(tree)

    layer.highlight('single', 0xff0000)
    const color = crowns.instanceColor
    const last = (crowns.count - 1) * 3
    expect([
      color?.getX(crowns.count - 1),
      color?.getY(crowns.count - 1)
    ]).toEqual([1, 0])
    expect(color?.array[0]).toBeCloseTo(new Color(CROWN_COLOR).r, 6)
    layer.highlight()
    expect(color?.array[last]).toBeCloseTo(new Color(CROWN_COLOR).r, 6)
  })

  it('frees the copies of a tile drawn again, never the shared shapes', async () => {
    const { layer } = await setup([wood(0.2, 0.2, 0.5, 0.5)])
    const [crowns] = copies(layer, 'crowns')
    const disposeCopies = vi.spyOn(crowns, 'dispose')
    const disposeShape = vi.spyOn(crowns.geometry, 'dispose')

    layer.invalidate()
    await layer.whenReady()

    expect(disposeCopies).toHaveBeenCalled()
    expect(disposeShape).not.toHaveBeenCalled()
  })

  it('reads woods from vector tiles and trees from Overpass', async () => {
    const data = encodeVectorTile([
      {
        name: 'landcover',
        features: [
          {
            type: 3,
            properties: { class: 'wood', subclass: 'forest' },
            geometry: [[0, 0, 100, 0, 100, 100, 0, 100]]
          },
          {
            type: 3,
            properties: { class: 'grass' },
            geometry: [[0, 0, 100, 0, 100, 100, 0, 100]]
          }
        ]
      }
    ])
    expect(
      await treesFromVectorTile(data, { z: ZOOM, x: center.x, y: center.y })
    ).toMatchObject([{ kind: 'forest', geometry: { type: 'Polygon' } }])

    expect(
      treesFromOverpass({
        elements: [
          {
            type: 'node',
            id: 1,
            lat: 46.5,
            lon: 6.6,
            tags: { natural: 'tree', height: '12 m' }
          }
        ]
      })
    ).toMatchObject([
      {
        id: 'node/1',
        height: 12,
        geometry: { type: 'Point', coordinates: [6.6, 46.5] }
      }
    ])
  })
})

describe('Trees clear of other layers', () => {
  // a wood across the center tile, a river through its middle
  const forest = wood(0.1, 0.1, 0.9, 0.9)
  const river: WaterFeature = {
    kind: 'river',
    geometry: {
      type: 'LineString',
      coordinates: [lonLat(0.5, 0), lonLat(0.5, 1)]
    },
    properties: {}
  }

  const plant = (waterLate: boolean) => {
    // every tile's water waits
    const waiting: (() => void)[] = []
    const map = new Map({
      source: { api: 'eox' },
      location,
      options: { zoom: ZOOM, tileSegments: 8, exaggeration: 1 }
    })
    const water = map.addLayer(
      new Water({
        source: {
          minZoom: ZOOM,
          maxZoom: ZOOM,
          load: async ({ x, y }) => {
            if (waterLate) {
              await new Promise<void>((resolve) => waiting.push(resolve))
            }
            return x === center.x && y === center.y ? [river] : []
          }
        },
        widths: { river: 40 }
      })
    )
    const trees = map.addLayer(
      new Trees({
        source: {
          minZoom: ZOOM,
          maxZoom: ZOOM,
          load: ({ x, y }) =>
            Promise.resolve(x === center.x && y === center.y ? [forest] : [])
        },
        avoid: [water],
        clearance: 5
      })
    )
    return {
      map,
      trees,
      release: () => {
        for (const resolve of waiting) resolve()
      }
    }
  }

  const across = (map: Map, trees: Trees) => {
    const meters = Utils.tileWidth(location.lat, ZOOM)
    const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]
    const { tileSize } = map.options
    return positions(trees, 'trunks').map(
      (p) => Math.abs((p.x - tile.mesh.position.x) / tileSize) * meters
    )
  }

  it('leaves the water and its clearance without trees', async () => {
    const { map, trees } = plant(false)
    await map.init()
    await map.whenReady()
    const distances = across(map, trees)

    expect(distances.length).toBeGreaterThan(100)
    // half the river (20 m) and the clearance (5 m)
    expect(Math.min(...distances)).toBeGreaterThanOrEqual(25 - 1e-6)
  })

  it('takes out the trees in water that arrives later', async () => {
    const { map, trees, release } = plant(true)
    await map.init()
    // the wood is planted before the river is there
    await vi.waitFor(() => {
      expect(positions(trees, 'trunks').length).toBeGreaterThan(100)
    })
    expect(Math.min(...across(map, trees))).toBeLessThan(25)

    release()
    await map.whenReady()
    expect(Math.min(...across(map, trees))).toBeGreaterThanOrEqual(25 - 1e-6)
  })
})
