import {
  BufferAttribute,
  type BufferGeometry,
  Color,
  type ColorRepresentation,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  Vector3
} from 'three'

import type { TreeFeature } from './features'
import { TreeSource, type TreeSourceProps } from './TreeSource.class'
import type { Position, Ring } from '../features'
import {
  type DrawFeatures,
  type FeatureHit,
  FeatureLayer,
  type GroundCover,
  type LayerMaterial
} from '../FeatureLayer.class'
import type { Rect, TileContext } from '../TileContext.class'
import { Utils } from '../../geo/Utils.class'
import type { Map } from '../../terrain/Map.class'
import type { Tile } from '../../terrain/Tile.class'

export interface TreesOptions {
  /** Where the trees come from: a `TreeSource`, or the props to create one. */
  source: TreeSource | TreeSourceProps
  /**
   * How the trees are drawn: the look (crowns in green unless it gives a
   * `color`, trunks in brown), one material for both, or a material per
   * part: `'crowns'`, `'trunks'` — copies of one geometry
   * (`InstancedMesh`), each in the color of its tree (`instanceColor`).
   */
  material?: LayerMaterial
  /** Replaces or extends the geometry. See `FeatureLayer`. */
  build?: (
    ctx: TileContext<TreeFeature>,
    draw: DrawFeatures<TreeFeature>
  ) => void
  /**
   * Layers whose ground stays clear of trees — water, roads, buildings,
   * yours: woods in the data often take in the rivers, roads and houses
   * crossing them. A tree stands only where none of them drew.
   */
  avoid: readonly GroundCover[]
  /** Meters a tree keeps from what `avoid` drew. */
  clearance: number
  /** Meters between the trees of a wood. */
  spacing: number
  /** Meters high, from the lowest to the highest, for trees without a height. */
  heights: readonly [low: number, high: number]
  /** At most this many trees on a terrain tile. */
  maxPerTile: number
  /** Color `highlight()` uses by default. */
  highlightColor: ColorRepresentation
  /** Terrain tiles below this zoom get no trees. */
  minZoom: number
}

export const defaultTreesOptions: Readonly<
  Omit<TreesOptions, 'source' | 'material' | 'build'>
> = Object.freeze({
  avoid: [],
  clearance: 2,
  spacing: 9,
  heights: [8, 16] as const,
  maxPerTile: 12000,
  highlightColor: 0xffb020,
  minZoom: 14
})

/** The tree (or wood) under a ray: the feature and where it was hit. */
export type TreeHit = FeatureHit<TreeFeature>

/** Colors of the crowns (unless the look gives one) and of the trunks. */
export const CROWN_COLOR = '#6f9a4f'
export const TRUNK_COLOR = '#7d5c3e'

/** A tree's shape, as shares of its height: the crown and the trunk. */
const CROWN_HEIGHT = 0.62
const CROWN_RADIUS = 0.24
const TRUNK_RADIUS = 0.035
/** Meters trunks reach below the ground. */
const FOUNDATION = 0.5

/** The shared shapes: a trunk (z from 0 to 1) and a crown (radius 1). */
let shapes: { trunk: BufferGeometry; crown: BufferGeometry } | undefined

function treeShapes() {
  if (!shapes) {
    const white = (geometry: BufferGeometry) => {
      const count = geometry.getAttribute('position').count
      geometry.setAttribute(
        'color',
        new BufferAttribute(new Float32Array(count * 3).fill(1), 3)
      )
      return geometry
    }
    shapes = {
      trunk: white(
        new CylinderGeometry(1, 1, 1, 6, 1, true)
          .rotateX(Math.PI / 2)
          .translate(0, 0, 0.5)
      ),
      crown: white(new IcosahedronGeometry(1, 1))
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

/** Even–odd point in rings `[x0, y0, …]`. */
function inside(x: number, y: number, rings: readonly Float64Array[]) {
  let within = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const [xi, yi, xj, yj] = [ring[i], ring[i + 1], ring[j], ring[j + 1]]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        within = !within
      }
    }
  }
  return within
}

/** A feature in map units (tiles at the map's zoom): its points and polygons. */
interface Prepared {
  zoom: number
  points: [number, number][]
  polygons: { rings: Float64Array[]; bbox: Rect }[]
}

/**
 * Trees on the terrain: `map.addLayer(new Trees({ source: { api:
 * 'openfreemap' } }))`. Woods are filled with trees on a grid of `spacing`
 * meters, jittered — anchored to the map, so that they never move when a
 * tile is drawn again and never double at tile edges; single trees (points)
 * stand where they are. A tree is a trunk and a crown, copies of one
 * geometry each, standing on the rendered surface.
 */
export class Trees extends FeatureLayer<TreeFeature> {
  declare readonly source: TreeSource
  readonly options: Omit<TreesOptions, 'source'>

  private readonly prepared = new WeakMap<TreeFeature, Prepared>()
  private unsubscribe: (() => void)[] = []

  constructor({
    source,
    ...props
  }: Pick<TreesOptions, 'source'> & Partial<TreesOptions>) {
    const options = { ...defaultTreesOptions, ...props }
    super({
      source: source instanceof TreeSource ? source : new TreeSource(source),
      build: options.build,
      material: options.material,
      highlightColor: options.highlightColor,
      minZoom: options.minZoom,
      name: 'trees'
    })
    this.options = options
  }

  /** Trees near a tile drawn again by a layer in `avoid` are planted again. */
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

  /** Also waits for the layers in `avoid`, which plant trees again. */
  override async whenReady(): Promise<void> {
    await Promise.all(this.options.avoid.map((layer) => layer.whenReady()))
    await super.whenReady()
  }

  /** A feature in map units, cached. */
  private mapUnits(feature: TreeFeature): Prepared {
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
    ctx: TileContext<TreeFeature>,
    features: readonly TreeFeature[]
  ) {
    const { tile, map } = ctx
    const { tileSize } = map.options
    const { spacing, heights, maxPerTile, avoid, clearance } = this.options
    const own =
      typeof this.materialOption === 'object' &&
      !('isMaterial' in this.materialOption)
        ? this.materialOption.color
        : undefined
    const crownColor = new Color(own ?? CROWN_COLOR)
    const trunkColor = new Color(TRUNK_COLOR)
    const { trunk, crown } = treeShapes()
    const trunks = ctx.instances('trunks', trunk)
    const crowns = ctx.instances('crowns', crown)
    const wanted = new Set(features)
    const meters = Utils.tileWidth(map.geoLocation.lat, tile.z)
    const cell = spacing / meters // map units
    const margin = clearance / meters
    const matrix = new Matrix4()
    const position = new Vector3()
    const scale = new Vector3()
    const rotation = new Quaternion()
    let count = 0

    const plant = (
      x: number,
      y: number,
      feature: TreeFeature,
      random: number
    ) => {
      if (count >= maxPerTile) return
      if (avoid.some((layer) => layer.covers(x, y, margin))) return
      count++
      const lx = (x - tile.x - 0.5) * tileSize
      const ly = (0.5 - (y - tile.y)) * tileSize
      const ground = ctx.groundAt(lx, ly)
      const height =
        feature.height ?? heights[0] + (heights[1] - heights[0]) * random
      const crownHeight = height * CROWN_HEIGHT
      // the trunk up into the crown
      const trunkHeight = height - crownHeight * 0.6
      matrix.compose(
        position.set(lx, ly, ground - FOUNDATION * ctx.zScale),
        rotation,
        scale.set(
          height * TRUNK_RADIUS * ctx.unitsPerMeter,
          height * TRUNK_RADIUS * ctx.unitsPerMeter,
          (trunkHeight + FOUNDATION) * ctx.zScale
        )
      )
      trunks.add(matrix, trunkColor)
      matrix.compose(
        position.set(lx, ly, ground + (height - crownHeight / 2) * ctx.zScale),
        rotation,
        scale.set(
          height * CROWN_RADIUS * ctx.unitsPerMeter,
          height * CROWN_RADIUS * ctx.unitsPerMeter,
          (crownHeight / 2) * ctx.zScale
        )
      )
      crowns.add(matrix, crownColor)
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
        ctx.feature(feature, () => {
          for (const [i, [x, y]] of points.entries()) {
            if (within(x, y))
              plant(
                x,
                y,
                feature,
                hash(Math.floor(x / cell), Math.floor(y / cell), i)
              )
          }
          for (const { rings, bbox } of polygons) {
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
                if (within(x, y) && inside(x, y, rings)) {
                  plant(x, y, feature, hash(i, j, 3))
                }
              }
            }
          }
        })
      }
    }
  }
}
