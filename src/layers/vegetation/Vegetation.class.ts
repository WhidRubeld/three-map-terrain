import {
  BufferAttribute,
  type BufferGeometry,
  type ColorRepresentation,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  Vector3
} from 'three'

import { isBush, type VegetationFeature } from './features'
import {
  VegetationSource,
  type VegetationSourceProps
} from './VegetationSource.class'
import type { Position, Ring } from '../features'
import {
  type DrawFeatures,
  type FeatureHit,
  FeatureLayer,
  type GroundCover,
  type LayerDistance,
  type LayerMaterial
} from '../FeatureLayer.class'
import type { Rect, TileContext } from '../TileContext.class'
import { Utils } from '../../geo/Utils.class'
import type { Map } from '../../terrain/Map.class'
import type { Tile } from '../../terrain/Tile.class'

export interface VegetationOptions {
  /** Where the plants come from: a `VegetationSource`, or the props to create one. */
  source: VegetationSource | VegetationSourceProps
  /**
   * How the plants are drawn: the look (crowns in green and bushes in olive
   * unless it gives a `color`, trunks in brown; outlined in wireframe), one
   * material for every part, or a material per part: `'crowns'`,
   * `'trunks'`, `'bushes'` — copies of one geometry (`InstancedMesh`) in
   * the material's color.
   */
  material?: LayerMaterial
  /** Replaces or extends the geometry. See `FeatureLayer`. */
  build?: (
    ctx: TileContext<VegetationFeature>,
    draw: DrawFeatures<VegetationFeature>
  ) => void
  /**
   * What grows at each spot the layer plants — in a wood or scrub, or a
   * single plant: by default a bush where the feature is one of
   * `BUSH_KINDS` (`isBush`), else a tree. Yours decides by the feature (its
   * `kind`, its `properties`): `plants.tree(height?)`,
   * `plants.bush(height?)`, copies of your own
   * (`ctx.instances(part, geometry).add(matrix)`, in parts you name: their
   * materials are the layer's), or nothing — low trees in orchards, palms,
   * dwarf shrubs on heaths. A spot is planted once: by the first area
   * covering it.
   */
  plant?: (
    ctx: TileContext<VegetationFeature>,
    spot: PlantSpot,
    feature: VegetationFeature,
    plants: Plants
  ) => void
  /**
   * Layers whose ground stays clear of plants — water, roads, buildings,
   * yours: woods in the data often take in the rivers, roads and houses
   * crossing them. A plant stands only where none of them drew; plants are
   * planted once these have drawn the tiles around.
   */
  avoid: readonly GroundCover[]
  /** Meters a plant keeps from what `avoid` drew. */
  clearance: number
  /**
   * Meters between the plants of an area — by default 9 in woods, 5 in
   * scrub — or a function of the terrain's zoom and the area, e.g. fewer
   * on a wide map: `(zoom, feature) => (zoom < 15 ? 2 : 1) * (isBush(feature) ? 5 : 9)`.
   */
  spacing: number | ((zoom: number, feature: VegetationFeature) => number)
  /** Meters high, from the lowest to the highest, for trees without a height. */
  treeHeights: readonly [low: number, high: number]
  /** Meters high, from the lowest to the highest, for bushes without a height. */
  bushHeights: readonly [low: number, high: number]
  /**
   * At most this many plants on a terrain tile. A tile with more spots is
   * thinned evenly — every area keeps the same share of its spots, spread
   * over all of it, the same each time it is drawn: sparser woods, never
   * cut ones. The share is the tile's, so a thinned tile is sparser than an
   * unthinned neighbour; a wider `spacing` keeps tiles under it.
   */
  maxPerTile: number
  /** Color `highlight()` uses by default. */
  highlightColor: ColorRepresentation
  /**
   * Hides the plants of tiles farther than this from the camera, in meters —
   * or per part: `(part) => (part === 'trunks' ? 800 : 2500)`, trunks
   * first (crowns hide them from afar). See `FeatureLayer.maxDistance`.
   */
  maxDistance?: LayerDistance
  /** Terrain tiles below this zoom get no plants. */
  minZoom: number
}

export const defaultVegetationOptions: Readonly<
  Omit<VegetationOptions, 'source' | 'material' | 'build' | 'plant'>
> = Object.freeze({
  avoid: [],
  clearance: 2,
  spacing: (_zoom: number, feature: VegetationFeature) =>
    isBush(feature) ? 5 : 9,
  treeHeights: [8, 16] as const,
  bushHeights: [2, 4] as const,
  maxPerTile: 12000,
  highlightColor: 0xffb020,
  minZoom: 14
})

/** The plant (or its area) under a ray: the feature and where it was hit. */
export type VegetationHit = FeatureHit<VegetationFeature>

/** A spot the layer plants, in the tile's local coordinates. */
export interface PlantSpot {
  readonly x: number
  readonly y: number
  /** The rendered ground there. */
  readonly z: number
  /** A number in [0, 1), the same every time the spot is planted. */
  readonly random: number
}

/**
 * What `plant` can grow at its spot, `height` meters high — by default the
 * feature's, or between the layer's heights by the spot's `random`.
 */
export interface Plants {
  /** A trunk and a crown (`'trunks'`, `'crowns'`). */
  readonly tree: (height?: number) => void
  /** A crown on the ground, wider than high (`'bushes'`). */
  readonly bush: (height?: number) => void
}

/** Colors of the crowns and the bushes (unless the look gives one), and of the trunks. */
export const CROWN_COLOR = '#6f9a4f'
export const BUSH_COLOR = '#8f9a55'
export const TRUNK_COLOR = '#7d5c3e'

/** A tree's shape, as shares of its height: the crown and the trunk. */
const CROWN_HEIGHT = 0.62
const CROWN_RADIUS = 0.24
const TRUNK_RADIUS = 0.035
/** Meters trunks reach below the ground. */
const FOUNDATION = 0.5
/** A bush's shape, as shares of its height: its radius, the part in the ground. */
const BUSH_RADIUS = 0.7
const BUSH_SUNK = 0.1

let shapes: { trunk: BufferGeometry; crown: BufferGeometry } | undefined

/**
 * The plants' shapes, few triangles for many copies, shared by every layer:
 * a trunk (z from 0 to 1, 8 triangles) and a crown (radius 1, 20
 * triangles, shaded round; a bush is one too), white for the parts'
 * colors. Copies of yours may use them (`plant`); never dispose them.
 */
export function plantShapes() {
  if (!shapes) {
    const white = (geometry: BufferGeometry) => {
      const count = geometry.getAttribute('position').count
      geometry.setAttribute(
        'color',
        new BufferAttribute(new Float32Array(count * 3).fill(1), 3)
      )
      return geometry
    }
    const crown = new IcosahedronGeometry(1, 0)
    // normals of the sphere it stands for: lit round, not as facets
    crown.setAttribute(
      'normal',
      new BufferAttribute(
        Float32Array.from(crown.getAttribute('position').array),
        3
      )
    )
    shapes = {
      trunk: white(
        new CylinderGeometry(1, 1, 1, 4, 1, true)
          .rotateX(Math.PI / 2)
          .translate(0, 0, 0.5)
      ),
      crown: white(crown)
    }
  }
  return shapes
}

/** A number in [0, 1) from integers, the same every time. */
function hash(i: number, j: number, k: number) {
  let h =
    Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * The edges of a polygon by row of the planting grid (`cell` map units
 * high): a point of a row can only cross those of its row.
 */
interface Rows {
  cell: number
  /** The first row. */
  j0: number
  /** `[x0, y0, x1, y1, …]` of the edges reaching into each row. */
  edges: Float64Array[]
}

function rowsOf(
  rings: readonly Float64Array[],
  bbox: Rect,
  cell: number
): Rows {
  const j0 = Math.floor(bbox[1] / cell)
  const lists: number[][] = Array.from(
    { length: Math.floor(bbox[3] / cell) - j0 + 1 },
    () => []
  )
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const [xi, yi, xj, yj] = [ring[i], ring[i + 1], ring[j], ring[j + 1]]
      // a horizontal edge is never crossed
      if (yi === yj) continue
      const last = Math.floor(Math.max(yi, yj) / cell) - j0
      for (let r = Math.floor(Math.min(yi, yj) / cell) - j0; r <= last; r++) {
        lists[r].push(xi, yi, xj, yj)
      }
    }
  }
  return { cell, j0, edges: lists.map((list) => new Float64Array(list)) }
}

/** Even–odd point in a polygon, by the edges of its row. */
function inside(x: number, y: number, rows: Rows) {
  const row = Math.floor(y / rows.cell) - rows.j0
  if (row < 0 || row >= rows.edges.length) return false
  const edges = rows.edges[row]
  let within = false
  for (let k = 0; k < edges.length; k += 4) {
    const [xi, yi, xj, yj] = [
      edges[k],
      edges[k + 1],
      edges[k + 2],
      edges[k + 3]
    ]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      within = !within
    }
  }
  return within
}

/** Bushes in scrub (`isBush`), trees elsewhere. */
const defaultPlant: NonNullable<VegetationOptions['plant']> = (
  _ctx,
  _spot,
  feature,
  plants
) => {
  if (isBush(feature)) plants.bush()
  else plants.tree()
}

/** Copies of a shape in a part, as `ctx.instances()` adds them. */
type Copies = ReturnType<TileContext<VegetationFeature>['instances']>

/** Ranks of the spots, for the cap: the buckets of a counting sort. */
const RANKS = 4096

/**
 * The spots of the tile being drawn, 4 numbers each: `x`, `y` (map units),
 * `random` and rank. Reused by every draw, grown as needed.
 */
let spots = new Float64Array(4 * 4096)

/** A feature in map units (tiles at the map's zoom): its points and polygons. */
interface Prepared {
  zoom: number
  points: [number, number][]
  polygons: { rings: Float64Array[]; bbox: Rect; rows?: Rows }[]
}

/**
 * Trees and bushes on the terrain: `map.addLayer(new Vegetation({ source:
 * { api: 'openfreemap' } }))`. Woods are filled with trees and scrub with
 * bushes on a grid of `spacing` meters, jittered — anchored to the map, so
 * that they never move when a tile is drawn again and never double at tile
 * edges; single trees and bushes (points) stand where they are. A tree is a
 * trunk and a crown, a bush a crown on the ground, copies of one geometry
 * each, standing on the rendered surface; trunks are brown, crowns green
 * and bushes olive, or both in the look's `color`. What grows at a spot is
 * yours to decide: `plant`.
 */
export class Vegetation extends FeatureLayer<VegetationFeature> {
  declare readonly source: VegetationSource
  readonly options: Omit<VegetationOptions, 'source'>

  private readonly prepared = new WeakMap<VegetationFeature, Prepared>()
  private unsubscribe: (() => void)[] = []

  constructor({
    source,
    ...props
  }: Pick<VegetationOptions, 'source'> & Partial<VegetationOptions>) {
    const options = { ...defaultVegetationOptions, ...props }
    super({
      source:
        source instanceof VegetationSource
          ? source
          : new VegetationSource(source),
      build: options.build,
      material: options.material,
      highlightColor: options.highlightColor,
      minZoom: options.minZoom,
      maxDistance: options.maxDistance,
      name: 'vegetation'
    })
    this.options = options
  }

  /** Plants near a tile drawn again by a layer in `avoid` are planted again. */
  override attach(map: Map) {
    super.attach(map)
    this.unsubscribe = this.options.avoid.map((layer) =>
      layer.onTileDrawn((tile) => {
        const near: Tile[] = []
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const neighbour = map.tileCache[
              Utils.getTileKey(tile.z, tile.x + dx, tile.y + dy)
            ] as Tile | undefined
            if (neighbour) near.push(neighbour)
          }
        }
        this.invalidate(near)
      })
    )
  }

  override detach() {
    for (const stop of this.unsubscribe.splice(0)) stop()
    super.detach()
  }

  /** Also waits for the layers in `avoid`, which plant the plants again. */
  override async whenReady(): Promise<void> {
    await Promise.all(this.options.avoid.map((layer) => layer.whenReady()))
    await super.whenReady()
  }

  /**
   * Crowns green and bushes olive unless the layer's look has a color;
   * trunks brown. Parts of yours take the crowns' color.
   */
  protected override partColor(part: string): ColorRepresentation {
    if (part === 'trunks') return TRUNK_COLOR
    return this.ownLook.color ?? (part === 'bushes' ? BUSH_COLOR : CROWN_COLOR)
  }

  /**
   * Once the layers in `avoid` have drawn the tile and its neighbours (which
   * reach into it): planted once, not again for each of them.
   */
  protected override canDraw(tile: Tile): boolean {
    const map = this.map
    if (!map) return true
    for (const layer of this.options.avoid) {
      if ((layer as unknown) === this || !layer.pending) continue
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const near = map.tileCache[
            Utils.getTileKey(tile.z, tile.x + dx, tile.y + dy)
          ] as Tile | undefined
          if (near && layer.pending(near)) return false
        }
      }
    }
    return true
  }

  /** A feature in map units, cached. */
  private mapUnits(feature: VegetationFeature): Prepared {
    const zoom = this.map?.options.zoom ?? 0
    const cached = this.prepared.get(feature)
    if (cached?.zoom === zoom) return cached
    const toMap = ([lon, lat]: Position): [number, number] => {
      const f = Utils.position2tileFraction(lat, lon, zoom)
      return [f.x, f.y]
    }
    const { geometry } = feature
    const prepared: Prepared = { zoom, points: [], polygons: [] }
    if (geometry.type === 'Point')
      prepared.points.push(toMap(geometry.coordinates))
    else if (geometry.type === 'MultiPoint') {
      prepared.points.push(...geometry.coordinates.map(toMap))
    } else {
      const polygons: readonly (readonly Ring[])[] =
        geometry.type === 'Polygon'
          ? [geometry.coordinates]
          : geometry.coordinates
      for (const polygon of polygons) {
        const bbox: [number, number, number, number] = [
          Infinity,
          Infinity,
          -Infinity,
          -Infinity
        ]
        const rings = polygon.map((ring) => {
          const flat = new Float64Array(ring.length * 2)
          for (const [i, position] of ring.entries()) {
            const [x, y] = toMap(position)
            flat[2 * i] = x
            flat[2 * i + 1] = y
            bbox[0] = Math.min(bbox[0], x)
            bbox[1] = Math.min(bbox[1], y)
            bbox[2] = Math.max(bbox[2], x)
            bbox[3] = Math.max(bbox[3], y)
          }
          return flat
        })
        prepared.polygons.push({ rings, bbox })
      }
    }
    this.prepared.set(feature, prepared)
    return prepared
  }

  protected override draw(
    ctx: TileContext<VegetationFeature>,
    features: readonly VegetationFeature[]
  ) {
    const { plant: own, maxPerTile, avoid, clearance } = this.options
    // nothing shows: the plants are planted when they do
    if (
      !own &&
      !ctx.visible('crowns') &&
      !ctx.visible('trunks') &&
      !ctx.visible('bushes')
    ) {
      return
    }
    const { tile, map } = ctx
    const { tileSize } = map.options
    const { trunk, crown } = plantShapes()
    const { treeHeights, bushHeights } = this.options
    const wanted = new Set(features)
    const meters = Utils.tileWidth(map.geoLocation.lat, tile.z)
    const margin = clearance / meters
    const matrix = new Matrix4()
    const position = new Vector3()
    const scale = new Vector3()
    const rotation = new Quaternion()
    let copies: Record<'trunks' | 'crowns', Copies> | undefined
    let bushes: Copies | undefined

    /** A trunk and a crown, `height` meters high. */
    const tree = ({ x, y, z }: PlantSpot, height: number) => {
      copies ??= {
        trunks: ctx.instances('trunks', trunk),
        crowns: ctx.instances('crowns', crown)
      }
      const crownHeight = height * CROWN_HEIGHT
      // the trunk up into the crown
      const trunkHeight = height - crownHeight * 0.6
      matrix.compose(
        position.set(x, y, z - FOUNDATION * ctx.zScale),
        rotation,
        scale.set(
          height * TRUNK_RADIUS * ctx.unitsPerMeter,
          height * TRUNK_RADIUS * ctx.unitsPerMeter,
          (trunkHeight + FOUNDATION) * ctx.zScale
        )
      )
      copies.trunks.add(matrix)
      matrix.compose(
        position.set(x, y, z + (height - crownHeight / 2) * ctx.zScale),
        rotation,
        scale.set(
          height * CROWN_RADIUS * ctx.unitsPerMeter,
          height * CROWN_RADIUS * ctx.unitsPerMeter,
          (crownHeight / 2) * ctx.zScale
        )
      )
      copies.crowns.add(matrix)
    }

    /** A crown on the ground, wider than high, `height` meters high. */
    const bush = ({ x, y, z }: PlantSpot, height: number) => {
      bushes ??= ctx.instances('bushes', crown)
      // from a little in the ground (on slopes) up to its height
      const half = (height * (1 + BUSH_SUNK)) / 2
      matrix.compose(
        position.set(x, y, z + (height - half) * ctx.zScale),
        rotation,
        scale.set(
          height * BUSH_RADIUS * ctx.unitsPerMeter,
          height * BUSH_RADIUS * ctx.unitsPerMeter,
          half * ctx.zScale
        )
      )
      bushes.add(matrix)
    }

    // what `plant` grows, at the spot and of the feature being planted
    let here: PlantSpot = { x: 0, y: 0, z: 0, random: 0 }
    let current: VegetationFeature | undefined
    const between = ([low, high]: readonly [number, number]) =>
      current?.height ?? low + (high - low) * here.random
    const plants: Plants = {
      tree: (height = between(treeHeights)) => {
        tree(here, height)
      },
      bush: (height = between(bushHeights)) => {
        bush(here, height)
      }
    }
    const grow = own ?? defaultPlant

    /** What stands at spot `k`, of `feature`. */
    const plant = (k: number, feature: VegetationFeature) => {
      const lx = (spots[4 * k] - tile.x - 0.5) * tileSize
      const ly = (0.5 - (spots[4 * k + 1] - tile.y)) * tileSize
      const random = spots[4 * k + 2]
      here = { x: lx, y: ly, z: ctx.groundAt(lx, ly), random }
      current = feature
      grow(ctx, here, feature, plants)
    }

    // the tile's spots, area after area; `ends`: where each area's spots end
    let count = 0
    const ends: [VegetationFeature, number][] = []
    const offer = (x: number, y: number, random: number, rank: number) => {
      if (4 * count === spots.length) {
        const grown = new Float64Array(2 * spots.length)
        grown.set(spots)
        spots = grown
      }
      const k = 4 * count++
      spots[k] = x
      spots[k + 1] = y
      spots[k + 2] = random
      spots[k + 3] = Math.floor(rank * RANKS)
    }

    // a spot of a grid is planted once: by the first area covering it
    const claimed = new globalThis.Map<number, Uint8Array>()
    const claim = (cell: number, i: number, j: number) => {
      // the tile's spots, by their indices from just outside it
      const stride = Math.ceil(1 / cell) + 4
      let taken = claimed.get(cell)
      if (!taken) claimed.set(cell, (taken = new Uint8Array(stride * stride)))
      const key =
        (i - Math.floor(tile.x / cell) + 1) * stride +
        (j - Math.floor(tile.y / cell) + 1)
      if (taken[key]) return false
      taken[key] = 1
      return true
    }

    for (const source of ctx.sources) {
      // the source tile ∩ the terrain tile, in map units
      const [minX, minY, maxX, maxY] = [
        Math.max(tile.x + 0.5 + source.rect[0] / tileSize, tile.x),
        Math.max(tile.y + 0.5 - source.rect[3] / tileSize, tile.y),
        Math.min(tile.x + 0.5 + source.rect[2] / tileSize, tile.x + 1),
        Math.min(tile.y + 0.5 - source.rect[1] / tileSize, tile.y + 1)
      ]
      const within = (x: number, y: number) =>
        x >= minX && x < maxX && y >= minY && y < maxY
      for (const feature of source.features) {
        if (!wanted.has(feature)) continue
        const { points, polygons } = this.mapUnits(feature)
        const spacing =
          typeof this.options.spacing === 'function'
            ? this.options.spacing(tile.z, feature)
            : this.options.spacing
        const cell = spacing / meters // map units
        for (const [i, [x, y]] of points.entries()) {
          if (within(x, y)) {
            const [ci, cj] = [Math.floor(x / cell), Math.floor(y / cell)]
            offer(x, y, hash(ci, cj, i), hash(ci, cj, -1 - i))
          }
        }
        for (const polygon of polygons) {
          const { rings, bbox } = polygon
          if (polygon.rows?.cell !== cell) {
            polygon.rows = rowsOf(rings, bbox, cell)
          }
          const { rows } = polygon
          const [i0, j0] = [
            Math.floor(Math.max(bbox[0], minX) / cell),
            Math.floor(Math.max(bbox[1], minY) / cell)
          ]
          const [i1, j1] = [
            Math.ceil(Math.min(bbox[2], maxX) / cell),
            Math.ceil(Math.min(bbox[3], maxY) / cell)
          ]
          for (let j = j0; j < j1; j++) {
            for (let i = i0; i < i1; i++) {
              // a point jittered in its cell, the same for every tile
              const x = (i + hash(i, j, 1)) * cell
              const y = (j + hash(i, j, 2)) * cell
              if (within(x, y) && inside(x, y, rows) && claim(cell, i, j)) {
                offer(x, y, hash(i, j, 3), hash(i, j, 4))
              }
            }
          }
        }
        ends.push([feature, count])
      }
    }

    const clear = (k: number) =>
      !avoid.some((layer) =>
        layer.covers(spots[4 * k], spots[4 * k + 1], margin)
      )

    // over the cap, the spots of the lowest ranks: every area keeps the same
    // share of its spots, spread over all of it — never the first rows or areas
    let chosen: Uint8Array | undefined
    if (count > maxPerTile) {
      chosen = new Uint8Array(count)
      // the spots by rank (a counting sort), in their order within one
      const starts = new Uint32Array(RANKS + 1)
      for (let k = 0; k < count; k++) starts[spots[4 * k + 3] + 1]++
      for (let r = 1; r <= RANKS; r++) starts[r] += starts[r - 1]
      const order = new Uint32Array(count)
      for (let k = 0; k < count; k++) order[starts[spots[4 * k + 3]]++] = k
      for (let r = 0, planted = 0; r < count && planted < maxPerTile; r++) {
        if (clear(order[r])) {
          chosen[order[r]] = 1
          planted++
        }
      }
    }

    let start = 0
    for (const [feature, end] of ends) {
      ctx.feature(feature, () => {
        for (let k = start; k < end; k++) {
          if (chosen ? chosen[k] : clear(k)) plant(k, feature)
        }
      })
      start = end
    }
  }
}
