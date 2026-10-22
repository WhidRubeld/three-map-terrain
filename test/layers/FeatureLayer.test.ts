import {
  type BufferGeometry,
  Color,
  LOD,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Texture,
  Vector3
} from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FEATURE_ATTRIBUTE,
  FeatureLayer,
  type FeatureLayerOptions,
  Map,
  type Tile,
  type TileContext,
  type TileRequest,
  Utils
} from '../../src'
import { Footprint } from '../../src/layers/footprint'
import { FakeFileReader } from '../support/browser-fakes'
import { terrariumPixels } from '../support/helpers'

const { loadImageData } = vi.hoisted(() => ({ loadImageData: vi.fn() }))

vi.mock('../../src/io/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/io/image')>()),
  loadImageData
}))

vi.mock('../../src/terrain/texture', () => ({
  // no canvas in Node: a texture stands in for the stitched imagery
  loadTextureGrid: vi.fn(() => Promise.resolve(new Texture()))
}))

const ZOOM = 14
const SIZE = 16
const location = { lat: 46.948, lon: 7.4474 }
const center = Utils.position2tile(location.lat, location.lon, ZOOM)
const zScale = 0.25

/** Rough hills (meters): the edges of a tile differ from its neighbours'. */
const ground = (gx: number, gy: number) =>
  600 + 40 * Math.sin(gx / 3) + 30 * Math.cos(gy / 2.5)

const tileFromUrl = (url: string) => {
  const match = /(\d+)\/(\d+)\/(\d+)\.png$/.exec(url)
  if (!match) throw new Error(`Unexpected elevation url: ${url}`)
  return { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }
}

/** Tiles east and south of the center load last: their seams change. */
let late: (x: number, y: number) => boolean = () => false

beforeEach(() => {
  late = () => false
  loadImageData.mockImplementation(async (url: string) => {
    const { x, y } = tileFromUrl(url)
    if (late(x, y)) await new Promise((resolve) => setTimeout(resolve, 5))
    return terrariumPixels(SIZE, (px, py) =>
      ground(x * SIZE + px, y * SIZE + py)
    )
  })
})

/** A thing at a position in tile units from the center tile. */
interface Thing {
  id: string
  fx: number
  fy: number
}

const lonLat = (fx: number, fy: number) => [
  Utils.tile2lon(center.x + fx, ZOOM),
  Utils.tile2lat(center.y + fy, ZOOM)
]

const setup = async (
  things: Thing[],
  options: Partial<FeatureLayerOptions<Thing>> = {},
  mapOptions: { nTiles?: number; wireframe?: boolean } = {}
) => {
  const load = vi.fn((_tile: TileRequest) => Promise.resolve(things))
  const map = new Map({
    source: { api: 'eox' },
    location,
    options: {
      zoom: ZOOM,
      tileSegments: 8,
      zScale,
      nTiles: mapOptions.nTiles ?? 3
    },
    material: { wireframe: mapOptions.wireframe ?? false }
  })
  const layer = map.addLayer(
    new FeatureLayer<Thing>({
      source: { minZoom: ZOOM, maxZoom: ZOOM, load },
      name: 'things',
      ...options
    })
  )
  await map.init()
  await layer.whenReady()
  return { map, layer, load }
}

/** A square of `size` tile units around each thing, draped on the terrain. */
const drapeSquares = (size: number) => (ctx: TileContext<Thing>) => {
  const seen = new Set<string>()
  for (const thing of ctx.allFeatures) {
    if (seen.has(thing.id)) continue
    seen.add(thing.id)
    const [x0, y0] = ctx.toLocal(
      lonLat(thing.fx - size / 2, thing.fy + size / 2)
    )
    const [x1, y1] = ctx.toLocal(
      lonLat(thing.fx + size / 2, thing.fy - size / 2)
    )
    ctx.feature(thing, () => {
      ctx.drapePolygon('surface', [[x0, y0, x1, y0, x1, y1, x0, y1]], {
        color: new Color(0x808080)
      })
    })
  }
}

const objects = (layer: FeatureLayer<Thing>, part: string) =>
  layer.group.children.filter((object) =>
    object.name.startsWith(`things ${part} `)
  ) as Mesh<BufferGeometry, MeshLambertMaterial>[]

const rayDown = (map: Map, fx: number, fy: number) => {
  const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]
  const { tileSize } = map.options
  map.terrain.updateMatrixWorld(true)
  const point = new Vector3(
    tile.mesh.position.x + (fx - 0.5) * tileSize,
    tile.mesh.position.y + (0.5 - fy) * tileSize,
    1e6
  )
  return new Raycaster(map.terrain.localToWorld(point), new Vector3(0, 0, -1))
}

/** Largest distance of the draped vertices from the terrain under them. */
const offSurface = (map: Map, layer: FeatureLayer<Thing>) => {
  let worst = 0
  for (const mesh of objects(layer, 'surface')) {
    const key = mesh.name.split(' ')[2]
    const tile = map.tileCache[key]
    const { tileSize } = map.options
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

describe('FeatureLayer', () => {
  it('draws what build draws, tile by tile, and picks it', async () => {
    const thing = { id: 'a', fx: 0.5, fy: 0.5 }
    const { map, layer } = await setup([thing], { build: drapeSquares(0.2) })

    expect(objects(layer, 'surface')).toHaveLength(1)
    expect(layer.count).toBe(1)
    expect(layer.pick(rayDown(map, 0.5, 0.5))?.feature).toBe(thing)
    expect(layer.pick(rayDown(map, 0.9, 0.9))).toBeUndefined()
  })

  it('keeps draped shapes on the surface while tiles stitch their seams', async () => {
    // a square across the corner the center tile shares with its east,
    // south and south-east neighbours, which load last
    late = (x, y) => x > center.x || y > center.y
    const { map, layer } = await setup([{ id: 'corner', fx: 1, fy: 1 }], {
      build: drapeSquares(0.6)
    })

    expect(objects(layer, 'surface').length).toBeGreaterThanOrEqual(4)
    expect(offSurface(map, layer)).toBeLessThan(1e-4)
  })

  it('shades draped shapes like the terrain', async () => {
    const { map, layer } = await setup([{ id: 'a', fx: 0.5, fy: 0.5 }], {
      build: drapeSquares(0.3)
    })
    const [mesh] = objects(layer, 'surface')
    const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]
    const raycaster = rayDown(map, 0.5, 0.5)
    const [onShape] = raycaster.intersectObject(mesh)
    const [onTerrain] = raycaster.intersectObject(tile.mesh)

    expect(onShape.point.z).toBeCloseTo(onTerrain.point.z, 4)
    // the vertex normals are the terrain's, interpolated
    const normal = mesh.geometry.getAttribute('normal')
    const vertex = onShape.face?.a ?? 0
    expect(
      Math.hypot(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex))
    ).toBeCloseTo(1, 5)
    expect(normal.getZ(vertex)).toBeGreaterThan(0.5)
  })

  it('never picks what the terrain hides', async () => {
    const buried = { id: 'buried', fx: 0.5, fy: 0.5 }
    const { map, layer } = await setup([buried], {
      build(ctx) {
        if (ctx.tile.x !== center.x || ctx.tile.y !== center.y) return
        ctx.feature(buried, () => {
          const [x, y] = ctx.toLocal(lonLat(0.5, 0.5))
          const z = ctx.groundAt(x, y) - 100
          ctx.face(
            'under',
            [
              x - 50,
              y - 50,
              z,
              x + 50,
              y - 50,
              z,
              x + 50,
              y + 50,
              z,
              x - 50,
              y + 50,
              z
            ],
            {
              color: new Color(0xffffff),
              normal: [0, 0, 1]
            }
          )
        })
      }
    })

    expect(objects(layer, 'under')).toHaveLength(1)
    expect(layer.pick(rayDown(map, 0.5, 0.5))).toBeUndefined()
  })

  it('takes a material per part, the look for the others', async () => {
    const custom = new MeshStandardMaterial()
    const { layer } = await setup([{ id: 'a', fx: 0.5, fy: 0.5 }], {
      material: (part) => (part === 'surface' ? custom : undefined),
      build(ctx, draw) {
        drapeSquares(0.2)(ctx)
        draw()
        const [x, y] = ctx.toLocal(lonLat(0.5, 0.5))
        const z = ctx.groundAt(x, y)
        ctx.face(
          'plate',
          [x, y, z + 10, x + 10, y, z + 10, x + 10, y + 10, z + 10],
          {
            color: new Color(0xffffff)
          }
        )
      }
    })

    expect(objects(layer, 'surface')[0].material).toBe(custom)
    expect(objects(layer, 'plate')[0].material).toBeInstanceOf(
      MeshLambertMaterial
    )
  })

  it('highlights over any material, without touching it', async () => {
    const custom = new MeshStandardMaterial({ color: 0x123456 })
    const thing = { id: 'a', fx: 0.5, fy: 0.5 }
    const { layer } = await setup([thing], {
      material: custom,
      build: drapeSquares(0.2)
    })
    const [mesh] = objects(layer, 'surface')

    layer.highlight('a', 0xff0000)
    const [overlay] = mesh.children as Mesh<BufferGeometry, MeshBasicMaterial>[]
    expect(overlay.material.color.getHex()).toBe(0xff0000)
    expect(overlay.material.polygonOffset).toBe(true)
    expect(custom.color.getHex()).toBe(0x123456)

    layer.highlight()
    expect(mesh.children).toEqual([])
  })

  it('picks objects added with ctx.add() as their feature', async () => {
    const thing = { id: 'model', fx: 0.5, fy: 0.5 }
    const geometry = new (await import('three')).BoxGeometry(50, 50, 50)
    const { map, layer } = await setup([thing], {
      build(ctx) {
        ctx.feature(thing, () => {
          const [x, y] = ctx.toLocal(lonLat(0.5, 0.5))
          const model = new Mesh(geometry, new MeshBasicMaterial())
          model.position.set(x, y, ctx.groundAt(x, y) + 25)
          ctx.add(model)
        })
      }
    })

    expect(layer.pick(rayDown(map, 0.5, 0.5))?.feature).toBe(thing)
    // the layer leaves models' resources to their owner
    const dispose = vi.spyOn(geometry, 'dispose')
    layer.invalidate()
    await layer.whenReady()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('forgets a feature that draws nothing', async () => {
    const things = [
      { id: 'drawn', fx: 0.5, fy: 0.5 },
      { id: 'empty', fx: 0.6, fy: 0.6 }
    ]
    const results: boolean[] = []
    const { layer } = await setup(things, {
      build(ctx) {
        if (ctx.tile.x !== center.x || ctx.tile.y !== center.y) return
        const [x, y] = ctx.toLocal(lonLat(0.5, 0.5))
        const z = ctx.groundAt(x, y)
        results.push(
          ctx.feature(things[0], () => {
            ctx.face('plate', [x, y, z, x + 9, y, z, x + 9, y + 9, z], {
              color: new Color(0xffffff)
            })
          }),
          ctx.feature(things[1], () => undefined)
        )
      }
    })

    expect(results).toEqual([true, false])
    expect(layer.count).toBe(1)
  })

  it('draws again on invalidate(), e.g. after the data changed', async () => {
    const build = vi.fn(drapeSquares(0.2))
    const { map, layer } = await setup([{ id: 'a', fx: 0.5, fy: 0.5 }], {
      build
    })
    build.mockClear()

    layer.invalidate([
      map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]
    ])
    await layer.whenReady()

    expect(build).toHaveBeenCalledOnce()
  })

  it('hides faces and shows lines in wireframe, faces still picked', async () => {
    const thing = { id: 'a', fx: 0.5, fy: 0.5 }
    const { map, layer } = await setup(
      [thing],
      {
        build(ctx) {
          drapeSquares(0.2)(ctx)
          const [x0, y0] = ctx.toLocal(lonLat(0.4, 0.5))
          const [x1, y1] = ctx.toLocal(lonLat(0.6, 0.5))
          ctx.feature(thing, () => {
            ctx.drapePath('outline', [x0, y0, x1, y1], {
              color: new Color(0xffffff)
            })
          })
        }
      },
      { wireframe: true }
    )

    expect(objects(layer, 'surface')[0].material.visible).toBe(false)
    const [outline] = objects(layer, 'outline')
    expect(outline.material.visible).toBe(true)
    expect(layer.pick(rayDown(map, 0.5, 0.5))?.feature).toBe(thing)

    // out of wireframe: hidden, not drawn again
    map.setMaterial({ wireframe: false })
    expect(objects(layer, 'outline')).toEqual([outline])
    expect(outline.material.visible).toBe(false)
    // drawn again, hidden lines are not even built
    layer.invalidate()
    await layer.whenReady()
    expect(objects(layer, 'outline')).toEqual([])
  })

  it('fills the faces under the lines in wireframe with fillOpacity', async () => {
    const { map, layer } = await setup(
      [{ id: 'a', fx: 0.5, fy: 0.5 }],
      { build: drapeSquares(0.2) },
      { wireframe: true }
    )
    const [surface] = objects(layer, 'surface')

    map.setMaterial({ fillOpacity: 0.12 })
    expect(surface.material.visible).toBe(true)
    expect(surface.material.transparent).toBe(true)
    expect(surface.material.opacity).toBeCloseTo(0.12, 6)
    expect(surface.material.depthWrite).toBe(false)
    // solid: opaque again
    map.setMaterial({ wireframe: false })
    expect(objects(layer, 'surface')).toEqual([surface])
    expect(surface.material.transparent).toBe(false)
    expect(surface.material.opacity).toBe(1)
  })

  it('asks a material function again on setMaterial(), the geometry kept', async () => {
    let materials: Record<string, MeshStandardMaterial> = {}
    const build = vi.fn(drapeSquares(0.2))
    const { map, layer } = await setup([{ id: 'a', fx: 0.5, fy: 0.5 }], {
      material: (part) => materials[part],
      build
    })
    const [surface] = objects(layer, 'surface')
    const own = surface.material
    expect(own).toBeInstanceOf(MeshLambertMaterial)
    const dispose = vi.spyOn(own, 'dispose')
    build.mockClear()

    // the same look, other materials
    materials = { surface: new MeshStandardMaterial() }
    map.setMaterial({})
    expect(surface.material).toBe(materials.surface)
    expect(dispose).toHaveBeenCalled()

    materials = {}
    map.setMaterial({})
    expect(surface.material).toBeInstanceOf(MeshLambertMaterial)
    await layer.whenReady()
    expect(build).not.toHaveBeenCalled()
  })

  it('draws tiles a few at a time, the nearest to the focus first', async () => {
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (open = resolve))
    const order: string[] = []
    let ticks = 0
    const ticksAtDraw: number[] = []
    const map = new Map({
      source: { api: 'eox' },
      location,
      options: { zoom: ZOOM, tileSegments: 8, zScale }
    })
    const layer = map.addLayer(
      new FeatureLayer<Thing>({
        source: {
          minZoom: ZOOM,
          maxZoom: ZOOM,
          load: async () => {
            await gate
            return []
          }
        },
        build(ctx) {
          order.push(ctx.tile.key())
          ticksAtDraw.push(ticks)
          // a tile longer than a slice
          const until = performance.now() + 8
          while (performance.now() < until) {
            // busy
          }
        }
      })
    )
    await map.init()
    // the north-west tile: in world coordinates, as the camera is
    const corner =
      map.tileCache[Utils.getTileKey(ZOOM, center.x - 1, center.y - 1)]
    map.terrain.position.set(100, 200, 0)
    map.terrain.updateMatrixWorld(true)
    map.focus = map.terrain.localToWorld(corner.mesh.position.clone())

    let done = false
    const tick = () => {
      ticks++
      if (!done) setTimeout(tick, 0)
    }
    tick()
    open()
    await layer.whenReady()
    done = true

    expect(order).toHaveLength(9)
    expect(order[0]).toBe(corner.key())
    // the far corner last
    expect(order[8]).toBe(Utils.getTileKey(ZOOM, center.x + 1, center.y + 1))
    // other tasks ran between the tiles
    expect(new Set(ticksAtDraw).size).toBe(9)
  })

  it('draws first the tiles near the location without a focus', async () => {
    const order: string[] = []
    await setup([{ id: 'a', fx: 0.5, fy: 0.5 }], {
      build(ctx) {
        order.push(ctx.tile.key())
      }
    })

    expect(order[0]).toBe(Utils.getTileKey(ZOOM, center.x, center.y))
  })

  it('tells which tiles are still to be drawn', async () => {
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (open = resolve))
    const map = new Map({
      source: { api: 'eox' },
      location,
      options: { zoom: ZOOM, tileSegments: 8, zScale }
    })
    const layer = map.addLayer(
      new FeatureLayer<Thing>({
        source: {
          minZoom: ZOOM,
          maxZoom: ZOOM,
          load: async () => {
            await gate
            return []
          }
        }
      })
    )
    await map.init()
    const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]

    expect(layer.pending(tile)).toBe(true)
    open()
    await layer.whenReady()
    expect(layer.pending(tile)).toBe(false)
    layer.invalidate([tile])
    expect(layer.pending(tile)).toBe(true)
    await layer.whenReady()
    expect(layer.pending(tile)).toBe(false)
  })

  it('has nothing pending for a tile whose source failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { map, layer } = await setup([], {
      source: {
        minZoom: ZOOM,
        maxZoom: ZOOM,
        load: () => Promise.reject(new Error('offline'))
      }
    })
    const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]

    expect(layer.pending(tile)).toBe(false)
    // whoever waits for it goes on
    layer.invalidate([tile])
    expect(layer.pending(tile)).toBe(false)
  })

  it('never waits forever for layers waiting for it', async () => {
    class Waiting extends FeatureLayer<Thing> {
      other: FeatureLayer<Thing> | undefined
      protected override canDraw(tile: Tile) {
        return !this.other?.pending(tile)
      }
    }
    const map = new Map({
      source: { api: 'eox' },
      location,
      options: { zoom: ZOOM, tileSegments: 8, zScale }
    })
    const source = {
      minZoom: ZOOM,
      maxZoom: ZOOM,
      load: () => Promise.resolve([])
    }
    const build = vi.fn()
    const a = map.addLayer(new Waiting({ source, build }))
    const b = map.addLayer(new Waiting({ source, build }))
    ;[a.other, b.other] = [b, a]
    await map.init()
    await map.whenReady()

    expect(build).toHaveBeenCalledTimes(18)
  })

  it('tells which ground its faces cover, and when it draws a tile', async () => {
    const { map, layer } = await setup([{ id: 'a', fx: 0.5, fy: 0.5 }], {
      build: drapeSquares(0.2)
    })
    const at = (fx: number, fy: number) =>
      [center.x + fx, center.y + fy] as const
    const meter = 1 / Utils.tileWidth(location.lat, ZOOM)

    expect(layer.covers(...at(0.5, 0.5))).toBe(true)
    expect(layer.covers(...at(0.65, 0.5))).toBe(false)
    // within 0.06 tiles of its edge at 0.6
    expect(layer.covers(...at(0.65, 0.5), 0.06)).toBe(true)
    expect(meter).toBeGreaterThan(0)

    const drawn = vi.fn()
    const stop = layer.onTileDrawn(drawn)
    const tile = map.tileCache[Utils.getTileKey(ZOOM, center.x, center.y)]
    layer.invalidate([tile])
    await layer.whenReady()
    expect(drawn).toHaveBeenCalledWith(tile)
    stop()
    layer.invalidate([tile])
    await layer.whenReady()
    expect(drawn).toHaveBeenCalledOnce()
  })

  it('frees its own materials on removal, never yours', async () => {
    const custom = new MeshStandardMaterial()
    const { map, layer } = await setup([{ id: 'a', fx: 0.5, fy: 0.5 }], {
      material: (part) => (part === 'surface' ? custom : undefined),
      build(ctx) {
        drapeSquares(0.2)(ctx)
        const [x, y] = ctx.toLocal(lonLat(0.5, 0.5))
        const z = ctx.groundAt(x, y)
        ctx.face(
          'plate',
          [x, y, z + 10, x + 10, y, z + 10, x + 10, y + 10, z + 10],
          {
            color: new Color(0xffffff)
          }
        )
      }
    })
    const own = objects(layer, 'plate')[0].material
    const [disposeOwn, disposeCustom] = [
      vi.spyOn(own, 'dispose'),
      vi.spyOn(custom, 'dispose')
    ]

    layer.dispose()

    expect(map.layers).toEqual([])
    expect(layer.group.children).toEqual([])
    expect(disposeOwn).toHaveBeenCalled()
    expect(disposeCustom).not.toHaveBeenCalled()
  })
})

describe('maxDistance', () => {
  // a square in the west, center and east tiles
  const things = [
    { id: 'w', fx: -0.5, fy: 0.5 },
    { id: 'c', fx: 0.5, fy: 0.5 },
    { id: 'e', fx: 1.5, fy: 0.5 }
  ]
  const tileAt = (map: Map, dx: number) =>
    map.tileCache[Utils.getTileKey(ZOOM, center.x + dx, center.y)]
  /** Where the layer's objects show, by tile: west, center, east. */
  const shown = (map: Map, layer: FeatureLayer<Thing>, part = 'surface') =>
    [-1, 0, 1].map((dx) =>
      objects(layer, part)
        .filter((mesh) => mesh.name.endsWith(` ${tileAt(map, dx).key()}`))
        .every((mesh) => mesh.visible)
    )
  /** A camera above a tile, among its hills; renders the layer once. */
  const look = (map: Map, layer: FeatureLayer<Thing>, dx: number) => {
    const { position } = tileAt(map, dx).mesh
    const camera = new PerspectiveCamera()
    camera.position.set(position.x, position.y, 600 * zScale)
    camera.updateMatrixWorld()
    map.terrain.updateMatrixWorld(true)
    // as the renderer does it
    const hook = layer.group.children.find(
      (object): object is LOD => (object as Partial<LOD>).isLOD === true
    )
    hook?.update(camera)
  }

  it('hides the tiles farther from the camera than it, in meters', async () => {
    // a tile is ~1670 m wide here: the neighbours ~835 m away
    const { map, layer } = await setup(things, {
      build: drapeSquares(0.2),
      maxDistance: 500
    })

    expect(layer.group.children[0]).toBeInstanceOf(LOD)
    look(map, layer, 0)
    expect(shown(map, layer)).toEqual([false, true, false])
    look(map, layer, 1)
    expect(shown(map, layer)).toEqual([false, false, true])

    layer.maxDistance = 1000
    look(map, layer, 1)
    expect(shown(map, layer)).toEqual([false, true, true])
  })

  it('gives each part its own distance', async () => {
    const { map, layer } = await setup(things, {
      build(ctx) {
        drapeSquares(0.2)(ctx)
        const [x, y] = ctx.toLocal(lonLat(0.5, 0.5))
        const z = ctx.groundAt(x, y) + 10
        ctx.face('lid', [x, y, z, x + 10, y, z, x + 10, y + 10, z], {
          color: new Color(0xffffff)
        })
      },
      maxDistance: (part) => (part === 'lid' ? 100 : undefined)
    })

    look(map, layer, 1)
    expect(shown(map, layer, 'surface')).toEqual([true, true, true])
    expect(shown(map, layer, 'lid')).toEqual([false, false, true])
  })

  it('keeps a hidden tile hidden when it is drawn again', async () => {
    const { map, layer } = await setup(things, {
      build: drapeSquares(0.2),
      maxDistance: 500
    })
    look(map, layer, 0)

    layer.invalidate([tileAt(map, 1)])
    await layer.whenReady()

    expect(shown(map, layer)).toEqual([false, true, false])
  })

  it('shows everything again without it, and picks only what shows', async () => {
    const { map, layer } = await setup(things, {
      build: drapeSquares(0.2),
      maxDistance: 500
    })
    look(map, layer, 0)

    expect(layer.pick(rayDown(map, 1.5, 0.5))).toBeUndefined()
    expect(layer.pick(rayDown(map, 0.5, 0.5))?.feature.id).toBe('c')

    layer.maxDistance = undefined
    expect(shown(map, layer)).toEqual([true, true, true])
    expect(layer.group.children.some((object) => object instanceof LOD)).toBe(
      false
    )
    expect(layer.pick(rayDown(map, 1.5, 0.5))?.feature.id).toBe('e')
  })

  it('exports the hidden tiles too, not itself', async () => {
    vi.stubGlobal('FileReader', FakeFileReader)
    const { map, layer } = await setup(things, {
      build: drapeSquares(0.2),
      maxDistance: 500
    })
    look(map, layer, 0)

    const blob = await map.export('glb', { textures: false })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    const { nodes } = JSON.parse(
      new TextDecoder().decode(
        bytes.subarray(20, 20 + view.getUint32(12, true))
      )
    ) as { nodes: { name?: string }[] }
    const names = nodes.map((node) => node.name ?? '')

    expect(
      names.filter((name) => name.startsWith('things surface'))
    ).toHaveLength(objects(layer, 'surface').length)
    expect(names).not.toContain('distance')
  })
})

describe('TileContext', () => {
  const capture = async (draw: (ctx: TileContext<Thing>) => void) => {
    let result: TileContext<Thing> | undefined
    await setup([{ id: 'a', fx: 0.5, fy: 0.5 }], {
      build(ctx) {
        if (ctx.tile.x === center.x && ctx.tile.y === center.y) {
          draw(ctx)
          result = ctx
        }
      }
    })
    if (!result) throw new Error('the center tile was not drawn')
    return result
  }

  it('maps ribbons across (0 to 1) and along in meters', async () => {
    const ctx = await capture((ctx) => {
      const [x0, y0] = ctx.toLocal(lonLat(0.3, 0.5))
      const [x1, y1] = ctx.toLocal(lonLat(0.7, 0.5))
      ctx.feature(ctx.allFeatures[0], () => {
        ctx.drapeLine('road', [x0, y0, x1, y1], 10 * ctx.unitsPerMeter, {
          color: new Color(0xffffff),
          caps: false
        })
      })
    })
    const geometry = ctx.parts.surfaces.get('road')?.build()
    const uv = geometry?.getAttribute('uv')
    if (!uv) throw new Error('no ribbon')
    const us = Array.from({ length: uv.count }, (_, i) => uv.getX(i))
    const vs = Array.from({ length: uv.count }, (_, i) => uv.getY(i))
    const length = (0.4 * ctx.map.options.tileSize) / ctx.unitsPerMeter

    expect(Math.min(...us)).toBeCloseTo(0, 6)
    expect(Math.max(...us)).toBeCloseTo(1, 6)
    expect(Math.min(...vs)).toBeCloseTo(0, 4)
    expect(Math.max(...vs)).toBeCloseTo(length, 4)
    expect(geometry?.getAttribute(FEATURE_ATTRIBUTE).getX(0)).toBe(0)
  })

  it('closes ribbons at the outer side of bends and round at the ends, once', async () => {
    let half = 0
    const ctx = await capture((ctx) => {
      const { tileSize } = ctx.map.options
      half = 0.025 * tileSize
      // east, then a left turn north
      const line = [-0.2 * tileSize, 0, 0, 0, 0, 0.2 * tileSize]
      ctx.feature(ctx.allFeatures[0], () => {
        ctx.drapeLine('road', line, 2 * half, { color: new Color(0xffffff) })
      })
    })
    const geometry = ctx.parts.surfaces.get('road')?.build()
    if (!geometry) throw new Error('no ribbon')
    const footprint = new Footprint([geometry])
    const { tileSize } = ctx.map.options
    const [startX, endY] = [-0.2 * tileSize, 0.2 * tileSize]

    // the bevel, outside both segments
    expect(footprint.covers(0.3 * half, -0.3 * half)).toBe(true)
    // the round ends: within the half disc beyond them, not further
    expect(footprint.covers(startX - 0.9 * half, 0)).toBe(true)
    expect(footprint.covers(startX - 1.05 * half, 0)).toBe(false)
    expect(footprint.covers(0, endY + 0.9 * half)).toBe(true)
    expect(footprint.covers(0, endY + 1.05 * half)).toBe(false)

    // seen from above: the two segments, one bevel, two halves of an octagon
    // — no bevel inside the bend, no half disc under the ribbon
    const position = geometry.getAttribute('position')
    const index = geometry.getIndex()
    let area = 0
    for (let i = 0; index && i < index.count; i += 3) {
      const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
      area +=
        Math.abs(
          (position.getX(b) - position.getX(a)) *
            (position.getY(c) - position.getY(a)) -
            (position.getX(c) - position.getX(a)) *
              (position.getY(b) - position.getY(a))
        ) / 2
    }
    const expected =
      2 * (0.2 * tileSize * 2 * half) +
      half ** 2 / 2 +
      2 * Math.SQRT2 * half ** 2
    expect(area / expected).toBeCloseTo(1, 6)
  })

  it('extrudes walls with UVs in meters along and up', async () => {
    const ctx = await capture((ctx) => {
      const [x, y] = ctx.toLocal(lonLat(0.5, 0.5))
      const side = 20 * ctx.unitsPerMeter
      ctx.feature(ctx.allFeatures[0], () => {
        ctx.extrude(
          [[[x, y, x + side, y, x + side, y + side, x, y + side]]],
          0,
          12 * ctx.zScale,
          {
            color: new Color(0xffffff)
          }
        )
      })
    })
    const uv = ctx.parts.surfaces.get('walls')?.build()?.getAttribute('uv')
    if (!uv) throw new Error('no walls')
    const us = Array.from({ length: uv.count }, (_, i) => uv.getX(i))
    const vs = Array.from({ length: uv.count }, (_, i) => uv.getY(i))

    expect(Math.max(...us)).toBeCloseTo(80, 4) // around the 20 m square
    expect(Math.max(...vs)).toBeCloseTo(12, 6)
  })

  it('turns faces to the normal asked for', async () => {
    const ctx = await capture((ctx) => {
      // clockwise seen from above, asked to face up
      ctx.face('lid', [0, 0, 5, 0, 10, 5, 10, 10, 5, 10, 0, 5], {
        color: new Color(0xffffff),
        normal: [0, 0, 1]
      })
    })
    const normal = ctx.parts.surfaces
      .get('lid')
      ?.build()
      ?.getAttribute('normal')

    expect(normal?.getZ(0)).toBe(1)
  })

  it('tracks the tiles whose heights it read', async () => {
    const ctx = await capture((ctx) => {
      const { tileSize } = ctx.map.options
      ctx.groundAt(tileSize, 0) // in the eastern neighbour
    })

    expect(ctx.depends).toContain(
      Utils.getTileKey(ZOOM, center.x + 1, center.y)
    )
  })
})
