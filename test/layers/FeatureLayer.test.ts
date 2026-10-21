import {
  type BufferGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
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
  type TileContext,
  type TileRequest,
  Utils
} from '../../src'
import { terrariumPixels } from '../support/helpers'

const { loadImageData } = vi.hoisted(() => ({ loadImageData: vi.fn() }))

vi.mock('../../src/io/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/io/image')>()),
  loadImageData
}))

vi.mock('../../src/terrain/material', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/terrain/material')>()),
  loadQuadTexture: vi.fn(() => Promise.resolve(new Texture()))
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
    expect(objects(layer, 'outline')[0].material.visible).toBe(true)
    expect(layer.pick(rayDown(map, 0.5, 0.5))?.feature).toBe(thing)

    // out of wireframe: hidden lines are not even built
    map.setMaterial({ wireframe: false })
    expect(objects(layer, 'outline')).toEqual([])
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
