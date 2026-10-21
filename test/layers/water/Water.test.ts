import {
  Box3,
  type BufferGeometry,
  Color,
  type Mesh,
  type MeshLambertMaterial,
  Raycaster,
  Texture,
  Vector3
} from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  Map,
  type TileRequest,
  Utils,
  Water,
  WATER_COLOR,
  type WaterFeature,
  waterFromOverpass,
  waterFromVectorTile
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

const ZOOM = 14
const SIZE = 16
const location = { lat: 46.948, lon: 7.4474 }
const center = Utils.position2tile(location.lat, location.lon, ZOOM)

/** Rough hills (meters). */
const ground = (gx: number, gy: number) =>
  600 + 30 * Math.sin(gx / 3) + 20 * Math.cos(gy / 2.5)

beforeEach(() => {
  loadImageData.mockImplementation((url: string) => {
    const [, x, y] = (/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url) ?? [])
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

const square = (x0: number, y0: number, x1: number, y1: number) => [
  lonLat(x0, y0),
  lonLat(x1, y0),
  lonLat(x1, y1),
  lonLat(x0, y1),
  lonLat(x0, y0)
]

const setup = async (
  water: WaterFeature[],
  options: Partial<ConstructorParameters<typeof Water>[0]> = {}
) => {
  const load = vi.fn((_tile: TileRequest) => Promise.resolve(water))
  const map = new Map({
    source: { api: 'eox' },
    location,
    options: { zoom: ZOOM, tileSegments: 8, zScale: 0.25 }
  })
  const layer = map.addLayer(
    new Water({ source: { load, minZoom: ZOOM, maxZoom: ZOOM }, ...options })
  )
  await map.init()
  await layer.whenReady()
  return { map, layer }
}

const part = (layer: Water, name: string) =>
  layer.group.children.filter((object) =>
    object.name.startsWith(`water ${name} `)
  ) as Mesh<BufferGeometry, MeshLambertMaterial>[]

const rayDown = (map: Map, fx: number, fy: number) => {
  const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]
  const { tileSize } = map.options
  map.terrain.updateMatrixWorld(true)
  return new Raycaster(
    map.terrain.localToWorld(
      new Vector3(
        tile.mesh.position.x + (fx - 0.5) * tileSize,
        tile.mesh.position.y + (0.5 - fy) * tileSize,
        1e6
      )
    ),
    new Vector3(0, 0, -1)
  )
}

describe('Water', () => {
  const lake: WaterFeature = {
    id: 'lake',
    kind: 'lake',
    // an island in the middle
    geometry: {
      type: 'Polygon',
      coordinates: [square(0.2, 0.2, 0.8, 0.8), square(0.45, 0.45, 0.55, 0.55)]
    },
    properties: {}
  }

  it('lays a lake on the terrain in blue, its islands land', async () => {
    const { map, layer } = await setup([lake])
    const [water] = part(layer, 'water')

    // on the surface
    const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]
    const { tileSize } = map.options
    const position = water.geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)]
      expect(z).toBeCloseTo(
        tile.heightAt(x / tileSize + 0.5, 0.5 - y / tileSize),
        4
      )
    }
    // blue: the material's
    expect(water.material.color.getHexString()).toBe(
      new Color(WATER_COLOR).getHexString()
    )
    expect(water.geometry.getAttribute('color').getX(0)).toBe(1)
    expect(water.material.polygonOffset).toBe(true)
    expect(layer.pick(rayDown(map, 0.3, 0.3))?.feature).toBe(lake)
    // the island
    expect(layer.pick(rayDown(map, 0.5, 0.5))).toBeUndefined()
  })

  it('draws waterways as ribbons as wide as their kind', async () => {
    const river: WaterFeature = {
      kind: 'river',
      geometry: {
        type: 'LineString',
        coordinates: [lonLat(0.2, 0.3), lonLat(0.8, 0.3)]
      },
      properties: {}
    }
    const { map, layer } = await setup([river], { widths: { river: 30 } })
    const box = new Box3().setFromObject(part(layer, 'water')[0])
    const unitsPerMeter =
      map.options.tileSize / Utils.tileWidth(location.lat, ZOOM)

    expect((box.max.y - box.min.y) / unitsPerMeter).toBeCloseTo(30, 3)
    expect(layer.width({ ...river, kind: 'stream' })).toBe(2.5)
  })

  it('reads water from vector tiles, not in tunnels', async () => {
    const data = encodeVectorTile([
      {
        name: 'water',
        features: [
          {
            id: 1,
            type: 3,
            properties: { class: 'lake' },
            geometry: [
              [0, 0, 4096, 0, 4096, 4096, 0, 4096],
              [1000, 1000, 1000, 2000, 2000, 2000, 2000, 1000]
            ]
          }
        ]
      },
      {
        name: 'waterway',
        features: [
          {
            type: 2,
            properties: { class: 'river' },
            geometry: [[0, 0, 10, 10]]
          },
          {
            type: 2,
            properties: { class: 'stream', brunnel: 'tunnel' },
            geometry: [[0, 0, 10, 10]]
          }
        ]
      }
    ])
    const water = await waterFromVectorTile(data, {
      z: ZOOM,
      x: center.x,
      y: center.y
    })

    expect(water.map(({ kind, geometry }) => [kind, geometry.type])).toEqual([
      ['lake', 'Polygon'],
      ['river', 'LineString']
    ])
    // the island is a hole
    const [first] = water
    expect(
      first.geometry.type === 'Polygon' && first.geometry.coordinates
    ).toHaveLength(2)
  })

  it('reads water from Overpass', () => {
    const water = waterFromOverpass({
      elements: [
        {
          type: 'way',
          id: 1,
          tags: { natural: 'water', water: 'pond' },
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
            { lat: 1, lon: 1 },
            { lat: 0, lon: 0 }
          ]
        },
        {
          type: 'way',
          id: 2,
          tags: { waterway: 'stream', width: '4' },
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 1, lon: 1 }
          ]
        },
        {
          type: 'way',
          id: 3,
          tags: { waterway: 'river', tunnel: 'culvert' },
          geometry: []
        }
      ]
    })

    expect(water).toMatchObject([
      { id: 'way/1', kind: 'pond', geometry: { type: 'Polygon' } },
      {
        id: 'way/2',
        kind: 'stream',
        width: 4,
        geometry: { type: 'LineString' }
      }
    ])
  })
})
