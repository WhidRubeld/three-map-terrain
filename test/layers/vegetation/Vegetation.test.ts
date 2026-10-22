import {
  Color,
  type InstancedMesh,
  Matrix4,
  type MeshBasicMaterial,
  type MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  Raycaster,
  Texture,
  Vector3
} from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BUSH_COLOR,
  CROWN_COLOR,
  isBush,
  type MaterialOptions,
  Map,
  type PlantSpot,
  plantShapes,
  TRUNK_COLOR,
  type TileRequest,
  Utils,
  Vegetation,
  type VegetationFeature,
  vegetationFromOverpass,
  vegetationFromVectorTile,
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

vi.mock('../../../src/terrain/texture', () => ({
  // no canvas in Node: a texture stands in for the stitched imagery
  loadTextureGrid: vi.fn(() => Promise.resolve(new Texture()))
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

const wood = (
  x0: number,
  y0: number,
  x1: number,
  y1: number
): VegetationFeature => ({
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
  features: VegetationFeature[],
  options: Partial<ConstructorParameters<typeof Vegetation>[0]> = {},
  material: Partial<MaterialOptions> = {}
) => {
  const load = vi.fn((_tile: TileRequest) => Promise.resolve(features))
  const map = new Map({
    source: { api: 'eox' },
    location,
    options: { zoom: ZOOM, tileSegments: 8, exaggeration: 1 },
    material
  })
  const layer = map.addLayer(
    new Vegetation({
      source: { load, minZoom: ZOOM, maxZoom: ZOOM },
      ...options
    })
  )
  await map.init()
  await layer.whenReady()
  return { map, layer }
}

const copies = (layer: Vegetation, part: string) =>
  layer.group.children.filter(
    (object) =>
      object.name.startsWith(`vegetation ${part} `) &&
      !object.name.endsWith('outline')
  ) as InstancedMesh<
    InstancedMesh['geometry'],
    MeshLambertMaterial | MeshBasicMaterial
  >[]

const outlines = (layer: Vegetation) =>
  layer.group.children.filter((object) =>
    object.name.endsWith(' outline')
  ) as InstancedMesh<InstancedMesh['geometry'], MeshBasicMaterial>[]

/** Where every copy stands, in map.terrain coordinates. */
const positions = (layer: Vegetation, part: string) => {
  const matrix = new Matrix4()
  return copies(layer, part).flatMap((mesh) =>
    Array.from({ length: mesh.count }, (_, i) => {
      mesh.getMatrixAt(i, matrix)
      return new Vector3().setFromMatrixPosition(matrix).add(mesh.position)
    })
  )
}

/** Where a point of `map.terrain` is, in tiles from the center tile's corner. */
const inTiles = (map: Map, point: Vector3) => {
  const { lat, lon } = map.getLocation(point)
  const f = Utils.position2tileFraction(lat, lon, ZOOM)
  return { x: f.x - center.x, y: f.y - center.y }
}

/** A palm of yours: the crown, 1.5 m around, at the spot. */
const palm = (ctx: { unitsPerMeter: number }, spot: PlantSpot) => {
  const r = 1.5 * ctx.unitsPerMeter
  return new Matrix4().compose(
    new Vector3(spot.x, spot.y, spot.z),
    new Quaternion(),
    new Vector3(r, r, r)
  )
}

describe('Vegetation', () => {
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
    const tree: VegetationFeature = {
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

  it('plants fewer trees with a wider spacing at a zoom', async () => {
    const count = async (spacing: number | ((zoom: number) => number)) => {
      const { layer } = await setup([wood(0.2, 0.2, 0.8, 0.8)], { spacing })
      return positions(layer, 'trunks').length
    }
    const dense = await count(10)
    const sparse = await count((zoom) => (zoom >= 16 ? 10 : 20))

    expect(sparse / dense).toBeGreaterThan(0.2)
    expect(sparse / dense).toBeLessThan(0.3)
  })

  it('has few triangles a tree, the crown shaded round', async () => {
    const { layer } = await setup([wood(0.2, 0.2, 0.5, 0.5)])
    const triangles = (mesh: InstancedMesh) =>
      (mesh.geometry.index?.count ??
        mesh.geometry.getAttribute('position').count) / 3
    const [crowns] = copies(layer, 'crowns')
    const [trunks] = copies(layer, 'trunks')

    expect(triangles(crowns) + triangles(trunks)).toBeLessThanOrEqual(28)
    // the normals of a sphere
    const normal = crowns.geometry.getAttribute('normal')
    const position = crowns.geometry.getAttribute('position')
    expect(normal.getX(0)).toBeCloseTo(position.getX(0), 6)
    expect(normal.getZ(1)).toBeCloseTo(position.getZ(1), 6)
  })

  it('takes a new look without planting again', async () => {
    const build = vi.fn((_ctx: unknown, draw: () => void) => {
      draw()
    })
    const { layer } = await setup([wood(0.2, 0.2, 0.5, 0.5)], { build })
    const [crowns] = copies(layer, 'crowns')
    const [trunks] = copies(layer, 'trunks')
    expect(crowns.material.color.getHexString()).toBe(
      new Color(CROWN_COLOR).getHexString()
    )
    expect(trunks.material.color.getHexString()).toBe(
      new Color(TRUNK_COLOR).getHexString()
    )
    // their colors are the materials': no colors of their own
    expect(crowns.instanceColor).toBeNull()
    build.mockClear()

    layer.setMaterial({ color: '#888888' })
    expect(copies(layer, 'crowns')).toEqual([crowns])
    expect(crowns.material.color.getHexString()).toBe('888888')

    // gray trees: your materials, in their colors
    const gray = new MeshStandardMaterial({ color: 0x777777 })
    layer.setMaterial(() => gray)
    expect(crowns.material).toBe(gray)
    expect(trunks.material).toBe(gray)
    await layer.whenReady()
    expect(build).not.toHaveBeenCalled()
  })

  it('plants no trees while hidden, and plants them once shown', async () => {
    const hidden = new MeshStandardMaterial({ visible: false })
    const { layer } = await setup([wood(0.2, 0.2, 0.5, 0.5)], {
      material: () => hidden
    })
    expect(copies(layer, 'crowns')).toEqual([])

    layer.setMaterial(undefined)
    await layer.whenReady()
    expect(copies(layer, 'crowns').length).toBeGreaterThan(0)
  })

  it('outlines the trees in wireframe, over a fill', async () => {
    const { map, layer } = await setup(
      [wood(0.2, 0.2, 0.5, 0.5)],
      {},
      {
        wireframe: true,
        fillOpacity: 0.12
      }
    )
    const [crowns] = copies(layer, 'crowns')
    const crownOutlines = outlines(layer).filter((outline) =>
      outline.name.startsWith('vegetation crowns ')
    )

    expect(crowns.material.transparent).toBe(true)
    expect(crowns.material.opacity).toBeCloseTo(0.12, 6)
    expect(crowns.material.depthWrite).toBe(false)
    expect(crownOutlines).toHaveLength(1)
    const [outline] = crownOutlines
    expect(outline.material.wireframe).toBe(true)
    expect(outline.instanceMatrix).toBe(crowns.instanceMatrix)
    expect(outline.count).toBe(crowns.count)
    expect(outline.userData.export).toBe(false)

    // out of wireframe: no outlines, the same copies
    map.setMaterial({ wireframe: false })
    expect(outlines(layer)).toEqual([])
    expect(copies(layer, 'crowns')).toEqual([crowns])
    expect(crowns.material.transparent).toBe(false)
  })

  it('caps the trees of a tile', async () => {
    const { layer } = await setup([wood(0.1, 0.1, 0.9, 0.9)], {
      maxPerTile: 50
    })
    expect(copies(layer, 'trunks')[0].count).toBe(50)
  })

  it('thins a capped tile evenly, never cuts it at a row', async () => {
    const { map, layer } = await setup([wood(0.1, 0.1, 0.9, 0.9)], {
      maxPerTile: 400
    })
    const trees = positions(layer, 'trunks').map((p) => inTiles(map, p))
    const share = (inside: (p: { x: number; y: number }) => boolean) =>
      trees.filter(inside).length / trees.length

    expect(trees).toHaveLength(400)
    // as many in each half of the wood as in the other
    expect(share(({ y }) => y > 0.5)).toBeGreaterThan(0.4)
    expect(share(({ y }) => y > 0.5)).toBeLessThan(0.6)
    expect(share(({ x }) => x > 0.5)).toBeGreaterThan(0.4)
    expect(share(({ x }) => x > 0.5)).toBeLessThan(0.6)
  })

  it('keeps trees in every wood of a capped tile', async () => {
    const { map, layer } = await setup(
      [wood(0.1, 0.1, 0.9, 0.45), wood(0.1, 0.55, 0.9, 0.9)],
      { maxPerTile: 400 }
    )
    const trees = positions(layer, 'trunks').map((p) => inTiles(map, p))
    const south = trees.filter(({ y }) => y > 0.5).length

    expect(trees).toHaveLength(400)
    expect(south / trees.length).toBeGreaterThan(0.4)
    expect(south / trees.length).toBeLessThan(0.6)
  })

  it('plants the same trees every time a capped tile is drawn', async () => {
    const { layer } = await setup([wood(0.1, 0.1, 0.9, 0.9)], {
      maxPerTile: 400
    })
    const before = positions(layer, 'crowns').map((p) => p.toArray().join())

    layer.invalidate()
    await layer.whenReady()

    expect(positions(layer, 'crowns').map((p) => p.toArray().join())).toEqual(
      before
    )
  })

  it('plants every spot of a tile up to the cap, as without one', async () => {
    const trees = [wood(0.2, 0.2, 0.5, 0.5)]
    const all = positions((await setup(trees)).layer, 'trunks')
    const at = (await setup(trees, { maxPerTile: all.length })).layer
    const below = (await setup(trees, { maxPerTile: all.length - 1 })).layer

    expect(positions(at, 'trunks')).toEqual(all)
    expect(positions(below, 'trunks')).toHaveLength(all.length - 1)
  })

  it('picks the wood of a tree, and highlights its trees', async () => {
    const forest = wood(0.2, 0.2, 0.5, 0.5)
    const tree: VegetationFeature = {
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

    // the highlighted copies again, over them
    layer.highlight('single', 0xff0000)
    const [overlay] = crowns.children as InstancedMesh<
      InstancedMesh['geometry'],
      MeshBasicMaterial
    >[]
    expect(overlay.count).toBe(1)
    expect(overlay.material.color.getHex()).toBe(0xff0000)
    expect(overlay.material.polygonOffset).toBe(true)
    const [a, b] = [new Matrix4(), new Matrix4()]
    overlay.getMatrixAt(0, a)
    crowns.getMatrixAt(crowns.count - 1, b)
    expect(a.equals(b)).toBe(true)
    expect(crowns.material.color.getHexString()).toBe(
      new Color(CROWN_COLOR).getHexString()
    )
    const dispose = vi.spyOn(overlay, 'dispose')
    const disposeShape = vi.spyOn(crowns.geometry, 'dispose')
    layer.highlight()
    expect(crowns.children).toEqual([])
    expect(dispose).toHaveBeenCalled()
    expect(disposeShape).not.toHaveBeenCalled()
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

  it('grows bushes in scrub and trees in woods, denser', async () => {
    const forest: VegetationFeature = {
      ...wood(0.1, 0.1, 0.4, 0.4),
      kind: 'forest'
    }
    const scrub: VegetationFeature = {
      ...wood(0.6, 0.6, 0.9, 0.9),
      id: 'scrub',
      kind: 'scrub'
    }
    const { map, layer } = await setup([forest, scrub])
    const [bushes] = copies(layer, 'bushes')
    const inside = (
      { x, y }: { x: number; y: number },
      [x0, y0, x1, y1]: number[]
    ) => x > x0 && x < x1 && y > y0 && y < y1

    // 9 m between trees, 5 between bushes: (9 / 5)² as many
    const trees = positions(layer, 'trunks').length
    expect(bushes.count / trees).toBeGreaterThan(2.8)
    expect(bushes.count / trees).toBeLessThan(3.7)
    expect(bushes.material.color.getHexString()).toBe(
      new Color(BUSH_COLOR).getHexString()
    )
    for (const p of positions(layer, 'crowns')) {
      expect(inside(inTiles(map, p), [0.1, 0.1, 0.4, 0.4])).toBe(true)
    }
    // in the scrub, from just below the ground up to 2–4 m
    const matrix = new Matrix4()
    for (let i = 0; i < bushes.count; i++) {
      bushes.getMatrixAt(i, matrix)
      const p = new Vector3().setFromMatrixPosition(matrix).add(bushes.position)
      const half = new Vector3().setFromMatrixScale(matrix).z
      expect(inside(inTiles(map, p), [0.6, 0.6, 0.9, 0.9])).toBe(true)
      const ground =
        map.getTerrainPositionSync(map.getLocation(p), { loadTile: false })
          ?.z ?? NaN
      const [bottom, top] = [p.z - half, p.z + half].map(
        (z) => (z - ground) / map.options.zScale
      )
      expect(bottom).toBeLessThan(0)
      expect(bottom).toBeCloseTo(-0.1 * top, 2)
      expect(top).toBeGreaterThan(1.99)
      expect(top).toBeLessThan(4.01)
    }

    // a bush is picked as its scrub
    const [position] = positions(layer, 'bushes')
    map.terrain.updateMatrixWorld(true)
    const raycaster = new Raycaster(
      map.terrain.localToWorld(position.clone().setZ(1e6)),
      new Vector3(0, 0, -1)
    )
    expect(layer.pick(raycaster)?.feature).toBe(scrub)
  })

  it('stands single bushes and trees where they are', async () => {
    const at = (fx: number, kind: string): VegetationFeature => ({
      kind,
      geometry: { type: 'Point', coordinates: lonLat(fx, 0.5) },
      properties: {}
    })
    const { layer } = await setup([at(0.3, 'shrub'), at(0.7, 'tree')])

    expect(copies(layer, 'bushes')[0].count).toBe(1)
    expect(copies(layer, 'crowns')[0].count).toBe(1)
    expect(isBush(at(0, 'shrubbery'))).toBe(true)
    expect(isBush(at(0, 'heath'))).toBe(false)
  })

  it('plants what you decide at each spot: copies of yours, trees', async () => {
    const forest: VegetationFeature = {
      ...wood(0.1, 0.1, 0.4, 0.4),
      kind: 'forest'
    }
    const beach: VegetationFeature = {
      ...wood(0.6, 0.6, 0.9, 0.9),
      kind: 'beach'
    }
    const spots: PlantSpot[] = []
    const { map, layer } = await setup([forest, beach], {
      plant(ctx, spot, feature, { tree }) {
        if (feature.kind !== 'beach') {
          tree()
          return
        }
        spots.push(spot)
        ctx.instances('palms', plantShapes().crown).add(palm(ctx, spot))
      }
    })
    const [palms] = copies(layer, 'palms')

    expect(spots.length).toBeGreaterThan(100)
    expect(palms.count).toBe(spots.length)
    // in the crowns' green, unless a material of yours
    expect(palms.material.color.getHexString()).toBe(
      new Color(CROWN_COLOR).getHexString()
    )
    // the palms on the beach, on the ground; the trees in the wood
    for (const p of positions(layer, 'palms')) {
      const { x, y } = inTiles(map, p)
      expect(x > 0.6 && x < 0.9 && y > 0.6 && y < 0.9).toBe(true)
      const surface = map.getTerrainPositionSync(map.getLocation(p), {
        loadTile: false
      })
      expect(surface?.z).toBeCloseTo(p.z, 3)
    }
    for (const p of positions(layer, 'crowns')) {
      const { x, y } = inTiles(map, p)
      expect(x > 0.1 && x < 0.4 && y > 0.1 && y < 0.4).toBe(true)
    }

    // a palm is picked as its beach
    const [position] = positions(layer, 'palms')
    map.terrain.updateMatrixWorld(true)
    const raycaster = new Raycaster(
      map.terrain.localToWorld(position.clone().setZ(1e6)),
      new Vector3(0, 0, -1)
    )
    expect(layer.pick(raycaster)?.feature).toBe(beach)
  })

  it('stands plants as high as you ask, or nothing', async () => {
    const at = (fx: number, kind: string): VegetationFeature => ({
      kind,
      geometry: { type: 'Point', coordinates: lonLat(fx, 0.5) },
      height: 20,
      properties: {}
    })
    const { map, layer } = await setup(
      [at(0.2, 'tree'), at(0.5, 'heath'), at(0.8, 'stump')],
      {
        plant(_ctx, _spot, feature, { tree, bush }) {
          if (feature.kind === 'tree') tree(4)
          if (feature.kind === 'heath') bush(1)
        }
      }
    )
    const half = (part: string) => {
      const [mesh] = copies(layer, part)
      expect(mesh.count).toBe(1)
      const matrix = new Matrix4()
      mesh.getMatrixAt(0, matrix)
      return new Vector3().setFromMatrixScale(matrix).z / map.options.zScale
    }

    expect(half('crowns')).toBeCloseTo(4 * 0.62 * 0.5, 6)
    expect(half('bushes')).toBeCloseTo(1.1 * 0.5, 6)
  })

  it('plants your parts while the trees are hidden', async () => {
    const hidden = new MeshStandardMaterial({ visible: false })
    const { layer } = await setup([wood(0.2, 0.2, 0.5, 0.5)], {
      material: (part) => (part === 'palms' ? undefined : hidden),
      plant(ctx, spot, _feature, { tree }) {
        tree()
        ctx.instances('palms', plantShapes().crown).add(palm(ctx, spot))
      }
    })

    expect(copies(layer, 'crowns')).toEqual([])
    expect(copies(layer, 'palms')[0].count).toBeGreaterThan(100)
  })

  it('spaces every area by its own spacing', async () => {
    const orchard: VegetationFeature = {
      ...wood(0.1, 0.1, 0.4, 0.4),
      kind: 'orchard'
    }
    const forest: VegetationFeature = {
      ...wood(0.6, 0.6, 0.9, 0.9),
      kind: 'forest'
    }
    const { map, layer } = await setup([orchard, forest], {
      spacing: (_zoom, feature) => (feature.kind === 'orchard' ? 5 : 10)
    })
    const xs = positions(layer, 'trunks').map((p) => inTiles(map, p).x)
    const dense = xs.filter((x) => x < 0.5).length
    const sparse = xs.filter((x) => x > 0.5).length

    expect(dense / sparse).toBeGreaterThan(3.4)
    expect(dense / sparse).toBeLessThan(4.6)
  })

  it('plants a spot once where woods overlap', async () => {
    const one = await setup([wood(0.2, 0.2, 0.6, 0.6)])
    const both = await setup([
      wood(0.2, 0.2, 0.6, 0.6),
      { ...wood(0.2, 0.2, 0.6, 0.6), id: 'forest', kind: 'forest' }
    ])
    const keys = (layer: Vegetation) =>
      positions(layer, 'trunks').map((p) => p.toArray().join())

    expect(keys(both.layer)).toEqual(keys(one.layer))
  })

  it('reads woods and scrub from vector tiles, single plants from Overpass', async () => {
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
            properties: { class: 'grass', subclass: 'scrub' },
            geometry: [[0, 0, 100, 0, 100, 100, 0, 100]]
          },
          {
            type: 3,
            properties: { class: 'grass', subclass: 'meadow' },
            geometry: [[0, 0, 100, 0, 100, 100, 0, 100]]
          }
        ]
      }
    ])
    expect(
      await vegetationFromVectorTile(data, {
        z: ZOOM,
        x: center.x,
        y: center.y
      })
    ).toMatchObject([
      { kind: 'forest', geometry: { type: 'Polygon' } },
      { kind: 'scrub', geometry: { type: 'Polygon' } }
    ])

    expect(
      vegetationFromOverpass({
        elements: [
          {
            type: 'node',
            id: 1,
            lat: 46.5,
            lon: 6.6,
            tags: { natural: 'tree', height: '12 m' }
          },
          {
            type: 'node',
            id: 2,
            lat: 46.5,
            lon: 6.7,
            tags: { natural: 'shrub' }
          }
        ]
      })
    ).toMatchObject([
      {
        id: 'node/1',
        kind: 'tree',
        height: 12,
        geometry: { type: 'Point', coordinates: [6.6, 46.5] }
      },
      { id: 'node/2', kind: 'shrub' }
    ])
  })
})

describe('Vegetation clear of other layers', () => {
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

  const plant = (waterLate: boolean, maxPerTile = Infinity) => {
    // every tile's water waits
    const waiting: (() => void)[] = []
    const drawn: string[] = []
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
      new Vegetation({
        source: {
          minZoom: ZOOM,
          maxZoom: ZOOM,
          load: ({ x, y }) =>
            Promise.resolve(x === center.x && y === center.y ? [forest] : [])
        },
        avoid: [water],
        clearance: 5,
        maxPerTile,
        build(ctx, draw) {
          drawn.push(ctx.tile.key())
          draw()
        }
      })
    )
    return {
      map,
      water,
      trees,
      drawn,
      release: () => {
        for (const resolve of waiting) resolve()
      }
    }
  }

  const across = (map: Map, trees: Vegetation) => {
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

  it('fills the cap of a tile clear of the water, over the whole wood', async () => {
    const { map, trees } = plant(false, 300)
    await map.init()
    await map.whenReady()
    const spots = positions(trees, 'trunks').map((p) => inTiles(map, p))
    const south = spots.filter(({ y }) => y > 0.5).length

    expect(spots).toHaveLength(300)
    expect(Math.min(...across(map, trees))).toBeGreaterThanOrEqual(25 - 1e-6)
    expect(south / spots.length).toBeGreaterThan(0.4)
    expect(south / spots.length).toBeLessThan(0.6)
  })

  it('plants once the water has arrived, and once only', async () => {
    const { map, water, trees, drawn, release } = plant(true)
    await map.init()
    const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]
    // the trees wait while the water loads
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(water.pending(tile)).toBe(true)
    expect(trees.pending(tile)).toBe(true)
    expect(positions(trees, 'trunks')).toEqual([])

    release()
    await map.whenReady()
    expect(water.pending(tile)).toBe(false)
    expect(positions(trees, 'trunks').length).toBeGreaterThan(100)
    expect(Math.min(...across(map, trees))).toBeGreaterThanOrEqual(25 - 1e-6)
    expect(drawn.filter((key) => key === tile.key())).toHaveLength(1)
  })
})
