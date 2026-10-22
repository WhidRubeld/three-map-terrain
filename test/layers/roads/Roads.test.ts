import {
  Box3,
  type BufferGeometry,
  type LineBasicMaterial,
  type Mesh,
  type MeshLambertMaterial,
  Raycaster,
  Texture,
  Vector3
} from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  Map,
  type RoadFeature,
  Roads,
  type RoadsOptions,
  type TileRequest,
  Utils
} from '../../../src'
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

const ZOOM = 14
const SIZE = 16
const location = { lat: 46.948, lon: 7.4474 }
const center = Utils.position2tile(location.lat, location.lon, ZOOM)
const zScale = 0.25

/** A valley 60 m deep running north–south through the middle of the center tile. */
const valley = (gx: number) =>
  600 - 60 * Math.exp(-(((gx - (center.x + 0.5) * SIZE) / 2.5) ** 2))

/** The terrain (meters) at global pixel `gx`, `gy`; a test may change it. */
let ground: (gx: number, gy: number) => number = valley

const tileFromUrl = (url: string) => {
  const match = /(\d+)\/(\d+)\/(\d+)\.png$/.exec(url)
  if (!match) throw new Error(`Unexpected elevation url: ${url}`)
  return { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }
}

let late: (x: number, y: number) => boolean = () => false

beforeEach(() => {
  late = () => false
  ground = valley
  loadImageData.mockImplementation(async (url: string) => {
    const { x, y } = tileFromUrl(url)
    if (late(x, y)) await new Promise((resolve) => setTimeout(resolve, 5))
    return terrariumPixels(SIZE, (px, py) =>
      ground(x * SIZE + px, y * SIZE + py)
    )
  })
})

/** A road through points in tile units from the center tile. */
const road = (
  points: [number, number][],
  feature: Partial<RoadFeature> = {}
): RoadFeature => ({
  kind: 'primary',
  geometry: {
    type: 'LineString',
    coordinates: points.map(([fx, fy]) => [
      Utils.tile2lon(center.x + fx, ZOOM),
      Utils.tile2lat(center.y + fy, ZOOM)
    ])
  },
  properties: {},
  ...feature
})

const setup = async (
  roads: RoadFeature[] | ((tile: TileRequest) => Promise<RoadFeature[]>),
  options: Partial<Omit<RoadsOptions, 'source'>> = {},
  material: { wireframe?: boolean } = {},
  sourceZoom = ZOOM
) => {
  const load = vi.fn(
    typeof roads === 'function' ? roads : () => Promise.resolve(roads)
  )
  const map = new Map({
    source: { api: 'eox' },
    location,
    options: { zoom: ZOOM, tileSegments: 8, zScale },
    material
  })
  const layer = map.addLayer(
    new Roads({
      source: { load, minZoom: sourceZoom, maxZoom: sourceZoom },
      ...options
    })
  )
  await map.init()
  await layer.whenReady()
  return { map, layer, load }
}

const part = <T = Mesh<BufferGeometry, MeshLambertMaterial>>(
  layer: Roads,
  name: string
) =>
  layer.group.children.filter((object) =>
    object.name.startsWith(`roads ${name} `)
  ) as T[]

/** Bounds of a part in map scene coordinates (tiles placed). */
const bounds = (layer: Roads, name: string) => {
  const box = new Box3()
  for (const object of part(layer, name)) {
    object.updateMatrixWorld(true)
    box.expandByObject(object)
  }
  return box
}

const groundZ = (map: Map, fx: number, fy: number) => {
  const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]
  return tile.heightAt(fx, fy)
}

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

/** Largest distance of the draped vertices from the terrain under them. */
const offSurface = (map: Map, layer: Roads) => {
  let worst = 0
  const { tileSize } = map.options
  for (const mesh of part(layer, 'surface')) {
    const tile = map.tileCache[mesh.name.split(' ')[2]]
    const position = mesh.geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)]
      worst = Math.max(
        worst,
        Math.abs(tile.heightAt(x / tileSize + 0.5, 0.5 - y / tileSize) - z)
      )
    }
  }
  return worst
}

describe('Roads', () => {
  it('drapes roads on the terrain, cut tile by tile', async () => {
    const { map, layer } = await setup([
      road([
        [-0.5, 0.3],
        [1.5, 0.3]
      ])
    ])

    // the center tile and its western and eastern neighbours
    expect(part(layer, 'surface')).toHaveLength(3)
    expect(offSurface(map, layer)).toBeLessThan(1e-4)
  })

  it('makes roads as wide as their kind, the options or the source say', async () => {
    const across = async (feature: Partial<RoadFeature>, options = {}) => {
      const { layer, map } = await setup(
        [
          road(
            [
              [0.2, 0.3],
              [0.8, 0.3]
            ],
            feature
          )
        ],
        options
      )
      const { min, max } = bounds(layer, 'surface')
      const unitsPerMeter =
        map.options.tileSize / Utils.tileWidth(location.lat, ZOOM)
      return (max.y - min.y) / unitsPerMeter
    }

    expect(await across({})).toBeCloseTo(9, 3) // a primary road
    expect(await across({}, { widths: { primary: 20 } })).toBeCloseTo(20, 3)
    expect(await across({ width: 4 })).toBeCloseTo(4, 3)
    expect(await across({ link: true })).toBeCloseTo(9 * 0.6, 3)
  })

  it('draws no tunnels, and only the kinds asked for', async () => {
    const { layer } = await setup(
      [
        road(
          [
            [0.2, 0.2],
            [0.8, 0.2]
          ],
          { id: 'tunnel', tunnel: true }
        ),
        road(
          [
            [0.2, 0.4],
            [0.8, 0.4]
          ],
          { id: 'path', kind: 'path' }
        ),
        road(
          [
            [0.2, 0.6],
            [0.8, 0.6]
          ],
          { id: 'rail', kind: 'rail' }
        )
      ],
      { kinds: ['rail'] }
    )

    expect(layer.count).toBe(1)
    // railways have a part of their own, in front of the terrain too
    const [rails] = part(layer, 'rails')
    expect(part(layer, 'surface')).toEqual([])
    expect(rails.material.polygonOffset).toBe(true)
  })

  it('spans a valley with a deck on piers, its ends on the ground', async () => {
    const bridge = road(
      [
        [0.15, 0.5],
        [0.85, 0.5]
      ],
      { id: 'bridge', bridge: true }
    )
    const { map, layer } = await setup([bridge])

    expect(part(layer, 'surface')).toEqual([])
    expect(part(layer, 'deck').length).toBeGreaterThan(0)
    // level over the valley: the ground at both ends is the same
    const rim = groundZ(map, 0.15, 0.5)
    const hit = layer.pick(rayDown(map, 0.5, 0.5))
    expect(hit?.feature).toBe(bridge)
    expect(hit?.alt).toBeCloseTo(rim / zScale, 0)
    expect(groundZ(map, 0.5, 0.5)).toBeLessThan(rim - 50 * zScale)
    // piers: faces standing in the valley
    const structure = bounds(layer, 'structure')
    expect(structure.min.z).toBeLessThan(groundZ(map, 0.5, 0.5))
  })

  it('joins the pieces of a bridge from several tiles into one deck', async () => {
    // the east rim 40 m higher than the west one
    ground = (gx, gy) =>
      valley(gx) + 40 / (1 + Math.exp(-(gx - (center.x + 0.5) * SIZE))) + 0 * gy
    // a bridge across the valley, split between two source tiles at z15
    // (at x = 0.5 of the center tile), each giving its piece with the same
    // id and, as vector tiles do, reaching into the other one (a buffer)
    const west = road(
      [
        [0.15, 0.5],
        [0.55, 0.5]
      ],
      { id: 7, bridge: true }
    )
    const east = road(
      [
        [0.45, 0.5],
        [0.85, 0.5]
      ],
      { id: 7, bridge: true }
    )
    const { map, layer } = await setup(
      ({ x, y }) =>
        Promise.resolve(
          y !== center.y * 2 + 1
            ? []
            : x === center.x * 2
              ? [west]
              : x === center.x * 2 + 1
                ? [east]
                : []
        ),
      {},
      {},
      15
    )

    // one deck, sloping from rim to rim — not two level ones with a step
    const [low, high] = [groundZ(map, 0.15, 0.5), groundZ(map, 0.85, 0.5)]
    const at = (fx: number) => layer.pick(rayDown(map, fx, 0.5))?.alt ?? NaN
    const linear = (fx: number) =>
      (low + ((high - low) * (fx - 0.15)) / 0.7) / zScale
    // within a couple of meters of the line: two pieces would differ by 40
    for (const fx of [0.3, 0.45, 0.55, 0.7]) {
      expect(Math.abs(at(fx) - linear(fx))).toBeLessThan(2)
    }
  })

  it('lays bridges on the terrain with bridges: false', async () => {
    const { map, layer } = await setup(
      [
        road(
          [
            [0.15, 0.5],
            [0.85, 0.5]
          ],
          { bridge: true }
        )
      ],
      { bridges: false }
    )

    expect(part(layer, 'deck')).toEqual([])
    expect(offSurface(map, layer)).toBeLessThan(1e-4)
  })

  it('draws a deck again once the ground under its end loads', async () => {
    late = (x) => x > center.x
    const { layer, map } = await setup([
      road(
        [
          [0.6, 0.5],
          [1.5, 0.5]
        ],
        { id: 'b', bridge: true }
      )
    ])

    // the part drawn before the eastern tile loaded was drawn again: the
    // deck meets itself at the tile edge
    const { tileSize } = map.options
    const edge = (name: string, x: number) => {
      const [deck] = part(layer, 'deck').filter((mesh) =>
        mesh.name.endsWith(name)
      )
      const position = deck.geometry.getAttribute('position')
      const heights: number[] = []
      for (let i = 0; i < position.count; i++) {
        if (Math.abs(position.getX(i) - x) < 1e-3)
          heights.push(position.getZ(i))
      }
      return Math.max(...heights)
    }
    const centerKey = Utils.getTileKey(ZOOM, center.x, center.y)
    const eastKey = Utils.getTileKey(ZOOM, center.x + 1, center.y)
    expect(edge(centerKey, tileSize / 2)).toBeCloseTo(
      edge(eastKey, -tileSize / 2),
      4
    )
  })

  it('picks roads, never behind the terrain, and highlights them across tiles', async () => {
    const street = road(
      [
        [0.5, 0.1],
        [0.5, 1.6]
      ],
      { id: 'street' }
    )
    const { map, layer } = await setup([street])

    expect(layer.pick(rayDown(map, 0.5, 0.3))?.feature).toBe(street)
    expect(layer.pick(rayDown(map, 0.2, 0.3))).toBeUndefined()

    layer.highlight(street, 0xff0000)
    const overlays = part(layer, 'surface').flatMap(
      (mesh) => mesh.children as Mesh<BufferGeometry, MeshLambertMaterial>[]
    )
    expect(overlays).toHaveLength(2) // the center tile and the southern one
    expect(overlays[0].material.color.getHex()).toBe(0xff0000)
  })

  it('pulls draped roads in front of the terrain, in a shade of its color', async () => {
    const { layer } = await setup([
      road([
        [0.2, 0.3],
        [0.8, 0.3]
      ])
    ])
    const [surface] = part(layer, 'surface')
    const colors = surface.geometry.getAttribute('color')

    expect(surface.material.polygonOffset).toBe(true)
    expect(surface.material.polygonOffsetFactor).toBeLessThan(0)
    // the shade is the material's: a new look only changes it
    expect(surface.material.color.r).toBeCloseTo(0.8, 6)
    expect(colors.getX(0)).toBe(1)
  })

  it('draws center lines in wireframe', async () => {
    const { map, layer } = await setup(
      [
        road([
          [0.2, 0.3],
          [0.8, 0.3]
        ])
      ],
      {},
      { wireframe: true }
    )
    const [lines] = part<Mesh<BufferGeometry, LineBasicMaterial>>(
      layer,
      'lines'
    )

    expect(lines.material.visible).toBe(true)
    expect(part(layer, 'surface')[0].material.visible).toBe(false)
    // draped too
    const position = lines.geometry.getAttribute('position')
    const { tileSize } = map.options
    const tile = map.tileCache[lines.name.split(' ')[2]]
    for (let i = 0; i < position.count; i++) {
      const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)]
      expect(z).toBeCloseTo(
        tile.heightAt(x / tileSize + 0.5, 0.5 - y / tileSize),
        4
      )
    }
  })

  it('credits its source', () => {
    expect(new Roads({ source: { api: 'openfreemap' } }).attribution).toContain(
      'OpenStreetMap'
    )
  })
})
