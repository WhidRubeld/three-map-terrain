import {
  Box3,
  type BufferGeometry,
  Color,
  LineBasicMaterial,
  LineSegments,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  type Mesh,
  type Object3D,
  Raycaster,
  Texture,
  Vector3
} from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type BuildingFeature,
  Buildings,
  type BuildingsOptions,
  type BuildingSourceProps,
  Map,
  type MaterialOptions,
  type Tile,
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

/** A gentle slope (meters), continuous across tiles. */
const ground = (gx: number, gy: number) => 600 + 2 * gx + 3 * gy

const tileFromUrl = (url: string) => {
  const match = /(\d+)\/(\d+)\/(\d+)\.png$/.exec(url)
  if (!match) throw new Error(`Unexpected elevation url: ${url}`)
  return { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }
}

beforeEach(() => {
  loadImageData.mockImplementation((url: string) => {
    const { x, y } = tileFromUrl(url)
    return Promise.resolve(
      terrariumPixels(SIZE, (px, py) => ground(x * SIZE + px, y * SIZE + py))
    )
  })
})

/** A square footprint, `fx`/`fy` in tile units at ZOOM from the center tile. */
const box = (
  fx: number,
  fy: number,
  size: number,
  feature: Partial<BuildingFeature> = {}
): BuildingFeature => {
  const lon = (x: number) => Utils.tile2lon(center.x + x, ZOOM)
  const lat = (y: number) => Utils.tile2lat(center.y + y, ZOOM)
  const ring = (x0: number, y0: number, s: number) => [
    [lon(x0), lat(y0)],
    [lon(x0 + s), lat(y0)],
    [lon(x0 + s), lat(y0 + s)],
    [lon(x0), lat(y0 + s)],
    [lon(x0), lat(y0)]
  ]
  return {
    geometry: { type: 'Polygon', coordinates: [ring(fx, fy, size)] },
    properties: {},
    ...feature
  }
}

const withHole = (fx: number, fy: number, size: number): BuildingFeature => {
  const outer = box(fx, fy, size)
  const hole = box(fx + size / 3, fy + size / 3, size / 3)
  if (outer.geometry.type !== 'Polygon' || hole.geometry.type !== 'Polygon') {
    throw new Error('expected polygons')
  }
  return {
    ...outer,
    geometry: {
      type: 'Polygon',
      coordinates: [outer.geometry.coordinates[0], hole.geometry.coordinates[0]]
    }
  }
}

const setup = async (
  buildings:
    BuildingFeature[] | ((tile: TileRequest) => Promise<BuildingFeature[]>),
  {
    source = {},
    ...options
  }: Partial<Omit<BuildingsOptions, 'source'>> & {
    source?: Partial<BuildingSourceProps>
  } = {},
  zoom = ZOOM,
  /** the map's material options */
  mapMaterial: Partial<MaterialOptions> = {}
) => {
  const load = vi.fn(
    typeof buildings === 'function'
      ? buildings
      : () => Promise.resolve(buildings)
  )
  const map = new Map({
    source: { api: 'eox' },
    location,
    options: { zoom, tileSegments: 8, zScale },
    material: mapMaterial
  })
  const layer = map.addLayer(
    new Buildings({
      source: {
        load,
        minZoom: ZOOM,
        maxZoom: ZOOM,
        ...source
      } as BuildingSourceProps,
      ...options
    })
  )
  await map.init()
  await layer.whenReady()
  return { map, layer, load }
}

/** Terrain height under a point given in tile units from the center tile. */
const groundZ = (map: Map, fx: number, fy: number) => {
  const gx = center.x + fx
  const gy = center.y + fy
  const tile = map.tileCache[
    Utils.getTileKey(ZOOM, Math.floor(gx), Math.floor(gy))
  ] as Tile | undefined
  if (!tile) throw new Error('no tile there')
  return tile.heightAt(gx - Math.floor(gx), gy - Math.floor(gy))
}

/** The point of the center tile's terrain group at tile units `fx`, `fy`. */
const scenePoint = (map: Map, fx: number, fy: number) => {
  const { tileSize } = map.options
  const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]
  return new Vector3(
    tile.mesh.position.x + (fx - 0.5) * tileSize,
    tile.mesh.position.y + (0.5 - fy) * tileSize,
    0
  )
}

const rayDown = (map: Map, fx: number, fy: number) => {
  const point = scenePoint(map, fx, fy)
  map.terrain.updateMatrixWorld(true)
  return new Raycaster(
    map.terrain.localToWorld(point.setZ(1e6)),
    new Vector3(0, 0, -1)
  )
}

/** The objects of a part of the buildings — `walls`, `roofs`, `floors`, `edges` — one per tile. */
const part = <T extends Object3D = Mesh<BufferGeometry, MeshLambertMaterial>>(
  layer: Buildings,
  name: string
) =>
  layer.group.children.filter((object) =>
    object.name.startsWith(`buildings ${name} `)
  ) as T[]

/** The faces of the buildings: walls first. */
const meshes = (layer: Buildings) => [
  ...part(layer, 'walls'),
  ...part(layer, 'roofs'),
  ...part(layer, 'floors')
]

/** Bounds of the faces, in the tiles' local coordinates. */
const bounds = (layer: Buildings) => {
  const box = new Box3()
  for (const mesh of meshes(layer)) {
    if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox)
  }
  return box
}

/** The highlight overlays: their color and bounds. */
const highlights = (layer: Buildings) =>
  layer.group.children.flatMap((object) =>
    object.children.map((overlay) => {
      const { geometry, material } = overlay as Mesh<
        BufferGeometry,
        MeshLambertMaterial | LineBasicMaterial
      >
      geometry.computeBoundingBox()
      return {
        color: material.color.getHex(),
        lines: overlay instanceof LineSegments,
        box: geometry.boundingBox ?? new Box3()
      }
    })
  )

describe('Buildings', () => {
  it('adds one group under map.terrain, outside map.pick', async () => {
    const { map, layer } = await setup([box(0.3, 0.3, 0.05, { height: 20 })])

    expect(layer.group.parent).toBe(map.terrain)
    // one tile: its walls and roofs
    expect(part(layer, 'walls')).toHaveLength(1)
    expect(part(layer, 'roofs')).toHaveLength(1)
    // map.pick sees the terrain, not the roofs
    const hit = map.pick(rayDown(map, 0.325, 0.325))
    expect(hit?.alt).toBeCloseTo(groundZ(map, 0.325, 0.325) / zScale, 3)
  })

  it('stands a building on the rendered surface, height scaled by zScale', async () => {
    const { map, layer } = await setup([box(0.3, 0.3, 0.05, { height: 20 })])
    const [mesh] = meshes(layer)
    const { boundingBox } = mesh.geometry

    const corners = [
      [0.3, 0.3],
      [0.35, 0.3],
      [0.35, 0.35],
      [0.3, 0.35]
    ].map(([fx, fy]) => groundZ(map, fx, fy))
    const low = Math.min(...corners)

    // walls start just below the lowest ground, the roof is 20 m above it
    expect(boundingBox?.min.z).toBeCloseTo(low - 0.5 * zScale, 6)
    expect(boundingBox?.max.z).toBeCloseTo(low + 20 * zScale, 6)
    for (const z of corners) expect(boundingBox?.min.z).toBeLessThan(z)

    const hit = layer.pick(rayDown(map, 0.325, 0.325))
    expect(hit?.point.z).toBeCloseTo(low + 20 * zScale, 6)
    expect(hit?.alt).toBeCloseTo((low + 20 * zScale) / zScale, 6)
  })

  it('keeps part of a low building above the ground on a slope', async () => {
    // 1 m high, much less than the slope across a 0.2-tile footprint
    const { map, layer } = await setup([box(0.2, 0.2, 0.2, { height: 1 })])
    const high = groundZ(map, 0.4, 0.4)

    expect(bounds(layer).max.z).toBeCloseTo(high + 1 * zScale, 3)
  })

  it('lifts parts with a min height and gives them a floor', async () => {
    const { map, layer } = await setup([
      box(0.3, 0.3, 0.05, { height: 30, minHeight: 10 })
    ])
    const low = Math.min(groundZ(map, 0.3, 0.3), groundZ(map, 0.35, 0.35))

    expect(bounds(layer).min.z).toBeCloseTo(low + 10 * zScale, 3)
    expect(bounds(layer).max.z).toBeCloseTo(low + 30 * zScale, 3)
    const [floor] = part(layer, 'floors')
    const normal = floor.geometry.getAttribute('normal')
    const facingDown = Array.from({ length: normal.count }, (_, i) =>
      normal.getZ(i)
    ).filter((z) => z === -1)
    expect(facingDown.length).toBeGreaterThan(0)
  })

  it('uses defaultHeight and skips buildings no higher than their min height', async () => {
    const { map, layer } = await setup(
      [box(0.3, 0.3, 0.05), box(0.6, 0.6, 0.05, { height: 5, minHeight: 5 })],
      { defaultHeight: 12 }
    )

    expect(layer.count).toBe(1)
    const low = Math.min(groundZ(map, 0.3, 0.3), groundZ(map, 0.35, 0.35))
    expect(bounds(layer).max.z).toBeCloseTo(low + 12 * zScale, 3)
  })

  it('takes heights no building reaches for none: data errors', async () => {
    // OpenFreeMap's tiles read building:levels=9,10 as 910 levels: 3331 m
    const { map, layer } = await setup(
      [box(0.3, 0.3, 0.05, { height: 3331, minHeight: 2000 })],
      { defaultHeight: 12 }
    )

    expect(layer.count).toBe(1)
    const low = Math.min(groundZ(map, 0.3, 0.3), groundZ(map, 0.35, 0.35))
    // on the ground, defaultHeight high, no floor
    expect(bounds(layer).min.z).toBeLessThan(low)
    expect(bounds(layer).max.z).toBeCloseTo(low + 12 * zScale, 3)
    expect(part(layer, 'floors')).toHaveLength(0)
  })

  it('keeps the heights of the tallest buildings', async () => {
    const { map, layer } = await setup([box(0.3, 0.3, 0.05, { height: 828 })])

    const low = Math.min(groundZ(map, 0.3, 0.3), groundZ(map, 0.35, 0.35))
    expect(bounds(layer).max.z).toBeCloseTo(low + 828 * zScale, 3)
  })

  it('draws each building once, in the tile its center lies in', async () => {
    // the source returns the same buildings for every tile, like Overpass;
    // one straddles the border of the center tile and its eastern neighbour
    const straddling = box(0.95, 0.4, 0.2, { id: 'straddling' })
    const { map, layer } = await setup([
      straddling,
      box(0.4, 0.4, 0.05, { id: 'inside' })
    ])

    expect(layer.count).toBe(2)
    expect(part(layer, 'roofs')).toHaveLength(2)
    const east = Utils.getTileKey(ZOOM, center.x + 1, center.y)
    const owner = part(layer, 'roofs').find(
      (mesh) => mesh.name === `buildings roofs ${east}`
    )
    expect(owner).toBeDefined()
    expect(map.tileCache[east].mesh.position.toArray()).toEqual(
      owner?.position.toArray()
    )
  })

  it('shares a source tile between the terrain tiles it covers', async () => {
    const { load } = await setup([], { source: { minZoom: 12, maxZoom: 13 } })

    const requested = load.mock.calls.map(([{ z, x, y }]) => `${z}/${x}/${y}`)
    const parents = new Set<string>()
    for (const i of [-1, 0, 1]) {
      for (const j of [-1, 0, 1]) {
        const x = Math.floor((center.x + i) / 2)
        const y = Math.floor((center.y + j) / 2)
        parents.add(`13/${x}/${y}`)
      }
    }
    expect(new Set(requested)).toEqual(parents)
    expect(requested).toHaveLength(parents.size)
  })

  it('loads the children of shallower terrain tiles', async () => {
    const { load } = await setup([], { source: { minZoom: 15, maxZoom: 16 } })

    expect(load).toHaveBeenCalledTimes(9 * 4)
    expect(new Set(load.mock.calls.map(([{ z }]) => z))).toEqual(new Set([15]))
  })

  it('dedupes buildings across child source tiles too', async () => {
    const { layer } = await setup(
      () => Promise.resolve([box(0.45, 0.45, 0.1, { id: 'one' })]),
      { source: { minZoom: 15, maxZoom: 15 } }
    )

    expect(layer.count).toBe(1)
  })

  it('warns once and skips sources far deeper than the terrain', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { load } = await setup([], { source: { minZoom: 17, maxZoom: 17 } })

    expect(load).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('gives terrain below minZoom no buildings', async () => {
    const { load, layer } = await setup([box(0.3, 0.3, 0.05)], {}, 12)

    expect(load).not.toHaveBeenCalled()
    expect(layer.count).toBe(0)
  })

  it('leaves courtyards open', async () => {
    const { map, layer } = await setup([withHole(0.3, 0.3, 0.15)])

    expect(layer.pick(rayDown(map, 0.375, 0.375))).toBeUndefined()
    expect(layer.pick(rayDown(map, 0.32, 0.32))).toBeDefined()
  })

  it('picks the building under a ray', async () => {
    const tall = box(0.3, 0.3, 0.05, { id: 'tall', height: 50 })
    const low = box(0.5, 0.5, 0.05, {
      id: 'low',
      height: 5,
      properties: { name: 'Shed' }
    })
    const { map, layer } = await setup([tall, low])

    const hit = layer.pick(rayDown(map, 0.525, 0.525))
    expect(hit?.feature).toBe(low)
    expect(hit?.feature.properties).toEqual({ name: 'Shed' })
    const where = map.getLocation(scenePoint(map, 0.525, 0.525))
    expect(hit?.lat).toBeCloseTo(where.lat, 6)
    expect(hit?.lon).toBeCloseTo(where.lon, 6)
    expect(layer.pick(rayDown(map, 0.325, 0.325))?.feature).toBe(tall)
    expect(layer.pick(rayDown(map, 0.9, 0.1))).toBeUndefined()
  })

  it('resolves intersections, e.g. React Three Fiber events', async () => {
    const building = box(0.3, 0.3, 0.05, { height: 20 })
    const { map, layer } = await setup([building])
    const raycaster = rayDown(map, 0.325, 0.325)
    const [onRoof] = raycaster.intersectObjects(layer.group.children)
    // the tile meshes only: the buildings group is a child of map.terrain too
    const [onTerrain] = raycaster.intersectObjects(map.terrain.children, false)

    expect(layer.pickIntersection(onRoof)?.feature).toBe(building)
    expect(layer.pickIntersection(onTerrain)).toBeUndefined()
  })

  it('highlights a building by feature or id over it, and clears it', async () => {
    const first = box(0.3, 0.3, 0.05, { id: 1 })
    const second = box(0.5, 0.5, 0.05, { id: 2 })
    const { map, layer } = await setup([first, second], {
      material: { color: 0x808080 }
    })
    const over = (fx: number, fy: number) => {
      const point = scenePoint(map, fx, fy)
      const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]
      point.sub(tile.mesh.position)
      return highlights(layer).filter(
        ({ box }) =>
          point.x >= box.min.x &&
          point.x <= box.max.x &&
          point.y >= box.min.y &&
          point.y <= box.max.y
      )
    }

    layer.highlight(first, 0xff0000)
    expect(over(0.325, 0.325).map(({ color }) => color)).toEqual([
      0xff0000, 0xff0000
    ]) // over its walls and roof
    expect(over(0.525, 0.525)).toEqual([])

    layer.highlight(2)
    expect(over(0.325, 0.325)).toEqual([])
    expect(over(0.525, 0.525)[0].color).toBe(
      new Color(layer.options.highlightColor).getHex()
    )

    layer.highlight()
    expect(highlights(layer)).toEqual([])
    // the buildings keep their own colors throughout
    expect(part(layer, 'roofs')[0].material.color.getHex()).toBe(0x808080)
  })

  it('never picks the overlay, always the building', async () => {
    const building = box(0.3, 0.3, 0.05, { id: 'b', height: 20 })
    const { map, layer } = await setup([building])
    layer.highlight('b')

    const raycaster = rayDown(map, 0.325, 0.325)
    const hits = raycaster.intersectObjects(layer.group.children, true)
    expect(hits.every(({ object }) => object.parent === layer.group)).toBe(true)
    expect(layer.pick(raycaster)?.feature).toBe(building)
  })

  it('highlights buildings of tiles loaded later', async () => {
    const { map, layer } = await setup(() =>
      Promise.resolve([box(2.5, 0.5, 0.05, { id: 'far' })])
    )
    layer.highlight('far', 0x00ff00)

    await map.addTileSegment(center.x + 2, center.y)
    await layer.whenReady()

    expect(highlights(layer).map(({ color }) => color)).toEqual([
      0x00ff00, 0x00ff00
    ])
  })

  it('draws feature colors when asked to', async () => {
    const red = box(0.3, 0.3, 0.05, { color: '#ff0000' })
    const plain = box(0.5, 0.5, 0.05)
    const { map, layer } = await setup([red, plain], { featureColors: true })
    const vertexColors = () => {
      const colors = part(layer, 'walls')[0].geometry.getAttribute('color')
      return Array.from({ length: colors.count }, (_, i) =>
        new Color(colors.getX(i), colors.getY(i), colors.getZ(i)).getHex()
      )
    }

    expect(new Set(vertexColors())).toEqual(new Set([0xff0000, 0xffffff]))
    expect(part(layer, 'walls')[0].material.color.getHex()).toBe(0xffffff)

    // the others are in the look's color: drawn again in the new one
    map.setMaterial({ color: '#00ff00' })
    await layer.whenReady()
    expect(new Set(vertexColors())).toEqual(new Set([0xff0000, 0x00ff00]))
  })

  describe('clip', () => {
    // the grid of 3 × 3 tiles spans -1…2 in tile units from the center tile
    it('cuts buildings at the edge of the grid', async () => {
      // 1.75…2.05: the center lies inside, the east wall outside
      const { layer } = await setup([box(1.75, 0.4, 0.3, { height: 20 })])
      const [mesh] = meshes(layer)
      mesh.geometry.computeBoundingBox()
      const { tileSize } = layer.map?.options ?? { tileSize: 0 }

      // the eastern tile's local x of the grid edge: (2 - 1 - 0.5) × tileSize
      expect(mesh.geometry.boundingBox?.max.x).toBeCloseTo(0.5 * tileSize, 6)
    })

    it('draws the part of a building outside that reaches in', async () => {
      // the center 2.05 lies outside the grid
      const { layer } = await setup([box(1.95, 0.4, 0.2, { id: 'outside' })])

      expect(layer.count).toBe(1)
      const [mesh] = meshes(layer)
      mesh.geometry.computeBoundingBox()
      expect(mesh.geometry.boundingBox?.max.x).toBeCloseTo(
        0.5 * (layer.map?.options.tileSize ?? 0),
        6
      )
    })

    it('leaves out buildings entirely outside', async () => {
      const { layer } = await setup([box(2.3, 0.4, 0.2)])
      expect(layer.count).toBe(0)
    })

    it('keeps buildings whole without clip', async () => {
      const { layer } = await setup([box(1.75, 0.4, 0.3)], { clip: false })
      const [mesh] = meshes(layer)
      mesh.geometry.computeBoundingBox()

      expect(mesh.geometry.boundingBox?.max.x).toBeCloseTo(
        0.55 * (layer.map?.options.tileSize ?? 0),
        6
      )
    })
  })

  it('follows map.setMaterial(): color, wireframe', async () => {
    const building = box(0.3, 0.3, 0.05, { id: 'b' })
    const { map, layer } = await setup([building])
    const [walls] = part(layer, 'walls')
    const geometry = walls.geometry
    layer.highlight('b', 0xff0000)

    // a color: the materials change, the geometry stays
    map.setMaterial({ color: '#336699' })
    expect(part(layer, 'walls')).toEqual([walls])
    expect(walls.geometry).toBe(geometry)
    expect(walls.material.color.getHexString()).toBe('336699')

    // the edges were left out: drawn now
    map.setMaterial({ wireframe: true })
    // the faces are hidden by their material: still there to pick
    expect(walls.material.visible).toBe(false)
    await layer.whenReady()
    const [edges] = part<LineSegments>(layer, 'edges')
    expect(edges.material).toBeInstanceOf(LineBasicMaterial)
    expect((edges.material as LineBasicMaterial).visible).toBe(true)
    expect((edges.material as LineBasicMaterial).color.getHexString()).toBe(
      '336699'
    )
    // still highlighted, on the lines
    expect(highlights(layer)).toMatchObject([{ color: 0xff0000, lines: true }])
    expect(layer.count).toBe(1)

    // out of wireframe: hidden, not drawn again
    const [solid] = part(layer, 'walls')
    map.setMaterial({ wireframe: false })
    expect(part(layer, 'walls')).toEqual([solid])
    expect(solid.material.visible).toBe(true)
    expect((edges.material as LineBasicMaterial).visible).toBe(false)
  })

  it('leaves the layers alone when only the imagery changes', async () => {
    const { map, layer } = await setup([box(0.3, 0.3, 0.05)])
    const [walls] = part(layer, 'walls')
    const material = walls.material

    map.setMaterial({ process: () => undefined })

    expect(part(layer, 'walls')).toEqual([walls])
    expect(walls.material).toBe(material)
  })

  it('changes its own look with setMaterial(), the geometry kept', async () => {
    const { map, layer } = await setup([box(0.3, 0.3, 0.05)], {}, ZOOM, {
      color: '#d0c8b8'
    })
    const [walls] = part(layer, 'walls')
    const geometry = walls.geometry

    layer.setMaterial({ color: '#203040' })
    expect(walls.material.color.getHexString()).toBe('203040')
    layer.setMaterial({ lights: false })
    expect(walls.material).toBeInstanceOf(MeshBasicMaterial)
    // merged: still in its color
    expect(walls.material.color.getHexString()).toBe('203040')
    // the map's look again
    layer.setMaterial({ color: undefined })
    expect(walls.material.color.getHexString()).toBe('d0c8b8')

    const custom = new MeshStandardMaterial()
    layer.setMaterial((name) => (name === 'walls' ? custom : undefined))
    expect(walls.material).toBe(custom)
    expect(part(layer, 'roofs')[0].material).toBeInstanceOf(MeshLambertMaterial)
    layer.setMaterial(undefined)
    expect(walls.material).toBeInstanceOf(MeshLambertMaterial)
    expect(walls.geometry).toBe(geometry)
    expect(layer.count).toBe(1)
    expect(map.layers).toContain(layer)
  })

  it('takes the style of the terrain by default', async () => {
    const { layer } = await setup([box(0.3, 0.3, 0.05)], {}, ZOOM, {
      color: '#d0c8b8',
      lights: false
    })
    const [walls] = part(layer, 'walls')

    expect(walls.material).toBeInstanceOf(MeshBasicMaterial)
    expect(
      (walls.material as unknown as MeshBasicMaterial).color.getHexString()
    ).toBe('d0c8b8')
    // no lines unless wireframe or edges
    expect(part(layer, 'edges')).toEqual([])
  })

  it('draws the edges in wireframe, the faces still pickable', async () => {
    const building = box(0.3, 0.3, 0.05, { height: 20 })
    const { map, layer } = await setup([building], {}, ZOOM, {
      wireframe: true
    })
    const [roofs] = part(layer, 'roofs')
    const [edges] = part<LineSegments>(layer, 'edges')

    expect(roofs.material.visible).toBe(false)
    expect((edges.material as LineBasicMaterial).visible).toBe(true)
    // a box: 4 walls × (top, bottom, corner) segments
    expect(edges.geometry.getAttribute('position').count).toBe(4 * 3 * 2)
    expect(layer.pick(rayDown(map, 0.325, 0.325))?.feature).toBe(building)
  })

  it('outlines solid buildings with darker edges', async () => {
    const { layer } = await setup([box(0.3, 0.3, 0.05)], {
      edges: true,
      material: { color: 0xffffff }
    })
    const [walls] = part(layer, 'walls')
    const [edges] = part<LineSegments>(layer, 'edges')

    expect(walls.material.visible).toBe(true)
    expect(walls.material.polygonOffset).toBe(true)
    expect((edges.material as LineBasicMaterial).color.r).toBeCloseTo(0.62, 6)
  })

  it('leaves out the corner lines of curved walls', async () => {
    // a 16-gon: walls turn by 22.5°, a corner each; a 64-gon: 5.6°, none
    const polygon = (sides: number): BuildingFeature => {
      const ring = Array.from({ length: sides + 1 }, (_, i) => {
        const angle = (2 * Math.PI * i) / sides
        return [
          Utils.tile2lon(center.x + 0.4 + 0.05 * Math.cos(angle), ZOOM),
          Utils.tile2lat(center.y + 0.4 + 0.05 * Math.sin(angle), ZOOM)
        ]
      })
      return {
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {}
      }
    }
    const segments = async (sides: number) => {
      const { layer } = await setup([polygon(sides)], { edges: true })
      const [edges] = part<LineSegments>(layer, 'edges')
      return edges.geometry.getAttribute('position').count / 2
    }

    expect(await segments(16)).toBe(16 * 3)
    expect(await segments(64)).toBe(64 * 2)
  })

  it('resolves intersections with the edges too', async () => {
    const building = box(0.3, 0.3, 0.05, { height: 20 })
    const { layer } = await setup([building], { edges: true })
    const [edges] = part<LineSegments>(layer, 'edges')

    expect(
      layer.pickIntersection({
        object: edges,
        index: 0,
        point: new Vector3(),
        face: null
      })?.feature
    ).toBe(building)
  })

  it('highlights the edges too', async () => {
    const building = box(0.3, 0.3, 0.05, { id: 'b' })
    const { layer } = await setup([building], {}, ZOOM, { wireframe: true })

    layer.highlight('b', 0x00ff00)

    // the hidden faces get none
    expect(highlights(layer)).toMatchObject([{ color: 0x00ff00, lines: true }])
  })

  it('follows the map material options, or takes a material', async () => {
    const unlit = await setup([box(0.3, 0.3, 0.05)], {
      material: { lights: false }
    })
    expect(meshes(unlit.layer)[0].material).toBeInstanceOf(MeshBasicMaterial)
    expect(meshes(unlit.layer)[0].material.vertexColors).toBe(true)

    const material = new MeshStandardMaterial()
    const custom = await setup([box(0.3, 0.3, 0.05)], { material })
    for (const mesh of meshes(custom.layer))
      expect(mesh.material).toBe(material)
    expect(material.vertexColors).toBe(true)

    // a material per part; the look's for the others
    const roofs = new MeshStandardMaterial({ color: 0x884422 })
    const perPart = await setup([box(0.3, 0.3, 0.05)], {
      material: (name) => (name === 'roofs' ? roofs : undefined)
    })
    expect(part(perPart.layer, 'roofs')[0].material).toBe(roofs)
    expect(part(perPart.layer, 'walls')[0].material).toBeInstanceOf(
      MeshLambertMaterial
    )
  })

  it('removes the buildings of cleaned tiles', async () => {
    const { map, layer } = await setup([box(0.3, 0.3, 0.05)])
    const [mesh] = meshes(layer)
    const dispose = vi.spyOn(mesh.geometry, 'dispose')

    map.clean()

    expect(layer.group.children).toHaveLength(0)
    expect(dispose).toHaveBeenCalled()
    expect(layer.count).toBe(0)
  })

  it('aborts pending source tiles on clean()', async () => {
    const signals: AbortSignal[] = []
    const load = vi.fn((tile: TileRequest) => {
      signals.push(tile.signal)
      return new Promise<BuildingFeature[]>(() => undefined)
    })
    const map = new Map({
      source: { api: 'eox' },
      location,
      options: { zoom: ZOOM, tileSegments: 8, zScale }
    })
    const layer = map.addLayer(
      new Buildings({ source: { load, minZoom: ZOOM, maxZoom: ZOOM } })
    )
    await map.init()

    map.clean()

    expect(signals).toHaveLength(9)
    for (const signal of signals) expect(signal.aborted).toBe(true)
    expect(layer.group.children).toHaveLength(0)
  })

  it('survives clean() → init() and rebuilds', async () => {
    const { map, layer } = await setup([box(0.3, 0.3, 0.05)])

    map.clean()
    await map.init()
    await layer.whenReady()

    expect(layer.count).toBe(1)
  })

  it('logs failing sources, not aborted ones', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await setup(() => Promise.reject(new Error('source down')))
    expect(error).toHaveBeenCalledWith(new Error('source down'))
    error.mockClear()

    await setup(() => Promise.reject(new DOMException('aborted', 'AbortError')))
    expect(error).not.toHaveBeenCalled()
  })

  it('detaches with dispose(): the group, the material', async () => {
    const { map, layer } = await setup([box(0.3, 0.3, 0.05)])
    const { material } = meshes(layer)[0]
    const dispose = vi.spyOn(material, 'dispose')

    layer.dispose()

    expect(map.layers).toEqual([])
    expect(layer.group.parent).toBeNull()
    expect(layer.group.children).toHaveLength(0)
    expect(dispose).toHaveBeenCalled()
    expect(layer.map).toBeUndefined()
    expect(layer.pick(new Raycaster())).toBeUndefined()
  })

  it('credits its source', () => {
    const layer = new Buildings({ source: { api: 'openfreemap' } })
    expect(layer.attribution).toContain('OpenStreetMap')
  })
})
