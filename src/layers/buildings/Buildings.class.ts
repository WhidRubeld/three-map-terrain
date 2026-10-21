import { Color, type ColorRepresentation, Material } from 'three'

import type { BuildingFeature } from './features'
import { isColor, ringAnchor } from './features'
import {
  BuildingSource,
  type BuildingSourceProps
} from './BuildingSource.class'
import type { FlatRing } from '../extrude'
import { clipRect, isRing, type Ring } from '../features'
import {
  type DrawFeatures,
  type FeatureHit,
  FeatureLayer,
  type LayerMaterial,
  type Look
} from '../FeatureLayer.class'
import type { Rect, TileContext } from '../TileContext.class'
import { Utils } from '../../geo/Utils.class'
import type { SourceTileKey } from '../../sources/source-tiles'
import type { Tile } from '../../terrain/Tile.class'

export interface BuildingsOptions {
  /** Where the footprints come from: a `BuildingSource`, or the props to create one. */
  source: BuildingSource | BuildingSourceProps
  /**
   * How the buildings are drawn: the look — the map's by default: in its
   * `color`, lit like it, in `wireframe` (their edges) with it — one
   * material for their faces (it gets `vertexColors`), or a material per
   * part: `'walls'`, `'roofs'`, `'floors'` (under parts that float),
   * `'edges'` (lines). Walls have UVs in meters along and up, roofs in
   * meters east and north.
   */
  material?: LayerMaterial
  /**
   * Replaces or extends the buildings' geometry: draw some buildings
   * yourself (roofs, models, LOD) and leave the rest to `draw`. See
   * `FeatureLayer`.
   */
  build?: (
    ctx: TileContext<BuildingFeature>,
    draw: DrawFeatures<BuildingFeature>
  ) => void
  /** Outline the solid buildings with their edges, in a darker shade. */
  edges: boolean
  /**
   * Cut the buildings at the edge of the map's `nTiles × nTiles` grid — and
   * draw the parts of those outside that reach in — so that the city ends
   * with the terrain. Inside the grid buildings are never cut.
   */
  clip: boolean
  /** Draw buildings in the color the source gives them, if any. */
  featureColors: boolean
  /** Color `highlight()` uses by default. */
  highlightColor: ColorRepresentation
  /** Height in meters of buildings the source has none for. */
  defaultHeight: number
  /** Terrain tiles below this zoom get no buildings. */
  minZoom: number
}

export const defaultBuildingsOptions: Readonly<
  Omit<BuildingsOptions, 'source' | 'material' | 'build'>
> = Object.freeze({
  edges: false,
  clip: true,
  featureColors: false,
  highlightColor: 0xffb020,
  defaultHeight: 6,
  minZoom: 13
})

/** The building under a ray: the feature and where it was hit. */
export type BuildingHit = FeatureHit<BuildingFeature>

/** Meters the walls reach below the lowest ground under them. */
const FOUNDATION = 0.5
/** On a slope, at least this much of a grounded building stays above ground (m). */
const MIN_EXPOSED = 3
/** Edges over solid buildings: their color times this. */
const EDGE_SHADE = 0.62

const isPolygon = (
  geometry: BuildingFeature['geometry']
): geometry is Extract<BuildingFeature['geometry'], { type: 'Polygon' }> =>
  geometry.type === 'Polygon'

const polygonsOf = (feature: BuildingFeature): readonly (readonly Ring[])[] =>
  isPolygon(feature.geometry)
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates

/**
 * 3D buildings on the terrain: `map.addLayer(new Buildings({ source: {
 * api: 'openfreemap' } }))`. Every building is drawn once, whole, by the
 * terrain tile its center lies in, standing on the rendered surface;
 * heights are scaled by the map's `zScale`.
 */
export class Buildings extends FeatureLayer<BuildingFeature> {
  declare readonly source: BuildingSource
  readonly options: Omit<BuildingsOptions, 'source'>

  constructor({
    source,
    ...props
  }: Pick<BuildingsOptions, 'source'> & Partial<BuildingsOptions>) {
    const options = { ...defaultBuildingsOptions, ...props }
    super({
      source:
        source instanceof BuildingSource ? source : new BuildingSource(source),
      build: options.build,
      material: options.material,
      highlightColor: options.highlightColor,
      minZoom: options.minZoom,
      name: 'buildings'
    })
    this.options = options
    if (options.material instanceof Material) {
      options.material.vertexColors = true
    }
  }

  /** Edges show in wireframe or with `edges`, over faces pushed back. */
  protected override createMaterial(
    part: string,
    kind: 'faces' | 'lines',
    look: Look
  ): Material {
    const material = super.createMaterial(part, kind, look)
    if (kind === 'lines') {
      material.visible = look.wireframe || this.options.edges
    } else if (this.options.edges) {
      material.polygonOffset = true
      material.polygonOffsetFactor = 1
      material.polygonOffsetUnits = 1
    }
    return material
  }

  /**
   * A building belongs to the tile its center (of the first outer ring's
   * bounding box) lies in — once, although sources return it for every tile
   * it touches. With `clip`, one whose center is outside the grid belongs
   * to the nearest tile of the grid, which draws the part reaching in.
   */
  protected override select(
    tile: Tile,
    source: SourceTileKey,
    features: BuildingFeature[]
  ): BuildingFeature[] {
    return features.filter((feature) => this.owns(tile, source, feature))
  }

  private owns(tile: Tile, source: SourceTileKey, feature: BuildingFeature) {
    const outer = polygonsOf(feature).at(0)?.at(0)
    if (!outer || outer.length < 3) return false
    const [lon, lat] = ringAnchor(outer)
    const anchorAt = (z: number) => {
      const f = Utils.position2tileFraction(lat, lon, z)
      return [Math.floor(f.x), Math.floor(f.y)]
    }
    const clamp = (value: number, min: number, max: number) =>
      Math.max(min, Math.min(max, value))

    let [x, y] = anchorAt(tile.z)
    const grid = this.clipGrid(tile)
    const outside =
      grid !== undefined &&
      (x < grid.minX || x > grid.maxX || y < grid.minY || y > grid.maxY)
    if (grid && outside) {
      x = clamp(x, grid.minX, grid.maxX)
      y = clamp(y, grid.minY, grid.maxY)
    }
    if (x !== tile.x || y !== tile.y) return false
    if (source.z <= tile.z) return true

    // several source tiles cover the terrain tile: one of them draws it
    let [sx, sy] = anchorAt(source.z)
    if (outside) {
      const scale = 2 ** (source.z - tile.z)
      sx = clamp(sx, tile.x * scale, tile.x * scale + scale - 1)
      sy = clamp(sy, tile.y * scale, tile.y * scale + scale - 1)
    }
    return sx === source.x && sy === source.y
  }

  /** The grid buildings of `tile` are cut at, if they are. */
  private clipGrid(tile: Tile) {
    if (!this.options.clip || !this.map) return undefined
    const grid = this.map.grid
    const inGrid =
      tile.z === grid.zoom &&
      tile.x >= grid.minX &&
      tile.x <= grid.maxX &&
      tile.y >= grid.minY &&
      tile.y <= grid.maxY
    return inGrid ? grid : undefined
  }

  /** The grid in a tile's local coordinates, if buildings are cut at it. */
  private gridRect(tile: Tile): Rect | undefined {
    const grid = this.clipGrid(tile)
    if (!grid) return undefined
    const { tileSize } = tile.map.options
    return [
      (grid.minX - tile.x - 0.5) * tileSize,
      (0.5 - (grid.maxY + 1 - tile.y)) * tileSize,
      (grid.maxX + 1 - tile.x - 0.5) * tileSize,
      (0.5 - (grid.minY - tile.y)) * tileSize
    ]
  }

  /** Polygons cut at the grid; those inside are never cut. */
  private clipToGrid(
    polygons: FlatRing[][],
    rect: Rect | undefined
  ): FlatRing[][] {
    if (!rect) return polygons
    const [minX, minY, maxX, maxY] = rect
    const inside = (ring: FlatRing) => {
      for (let i = 0; i < ring.length; i += 2) {
        const [x, y] = [ring[i], ring[i + 1]]
        if (x < minX || x > maxX || y < minY || y > maxY) return false
      }
      return true
    }
    return polygons.flatMap(([outer, ...holes]) => {
      if (inside(outer)) return [[outer, ...holes]]
      const cut = clipRect(outer, minX, minY, maxX, maxY)
      if (!isRing(cut)) return []
      const cutHoles = holes
        .map((hole) => clipRect(hole, minX, minY, maxX, maxY))
        .filter(isRing)
      return [[cut, ...cutHoles]]
    })
  }

  /**
   * Extrudes the buildings, standing on the ground: from 0.5 m below its
   * lowest point under the walls up to their `height` above it, and at
   * least 3 m above its highest; parts with a `minHeight` float.
   */
  protected override draw(
    ctx: TileContext<BuildingFeature>,
    features: readonly BuildingFeature[]
  ) {
    const look = this.requireLook()
    const { tileSegments, tileSize } = ctx.map.options
    const { defaultHeight } = this.options
    const zScale = ctx.zScale
    // the terrain is piecewise linear: sampling the walls this densely finds
    // its lowest point under them
    const step = tileSize / tileSegments / 2
    const grid = this.gridRect(ctx.tile)

    for (const feature of features) {
      const height = feature.height ?? defaultHeight
      const minHeight = Math.max(0, feature.minHeight ?? 0)
      if (!(height > minHeight)) continue

      const polygons = this.clipToGrid(
        polygonsOf(feature).map((polygon) =>
          polygon.map((ring) => flatRing(ring, (p) => ctx.toLocal(p)))
        ),
        grid
      )
      if (!polygons.some((polygon) => polygon[0] && polygon[0].length >= 6))
        continue

      let low = Infinity
      let high = -Infinity
      for (const [outer] of polygons) {
        const n = outer.length / 2
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n
          const [ax, ay, bx, by] = [
            outer[2 * i],
            outer[2 * i + 1],
            outer[2 * j],
            outer[2 * j + 1]
          ]
          const samples = Math.max(
            1,
            Math.ceil(Math.hypot(bx - ax, by - ay) / step)
          )
          for (let k = 0; k < samples; k++) {
            const t = k / samples
            const z = ctx.groundAt(ax + (bx - ax) * t, ay + (by - ay) * t)
            low = Math.min(low, z)
            high = Math.max(high, z)
          }
        }
      }
      if (!Number.isFinite(low)) continue

      // heights count from the lowest ground (OSM `height`); on a slope at
      // least MIN_EXPOSED meters stay above the highest ground
      const floating = minHeight > 0
      const bottom = floating
        ? low + minHeight * zScale
        : low - FOUNDATION * zScale
      const top = floating
        ? low + height * zScale
        : Math.max(
            low + height * zScale,
            high + Math.min(height, MIN_EXPOSED) * zScale
          )

      const color = this.baseColor(feature, look)
      const lineColor = look.wireframe
        ? color
        : color.clone().multiplyScalar(EDGE_SHADE)
      ctx.feature(feature, () => {
        ctx.extrude(polygons, bottom, top, {
          color,
          lineColor,
          floor: floating
        })
      })
    }
  }

  private baseColor(feature: BuildingFeature, look: Look) {
    return this.options.featureColors && feature.color && isColor(feature.color)
      ? new Color(feature.color)
      : new Color(look.color ?? 0xffffff)
  }
}

/** A ring in local coordinates, without a closing duplicate. */
function flatRing(
  ring: Ring,
  toLocal: (position: Ring[number]) => [number, number]
) {
  const flat: FlatRing = []
  for (const position of ring) {
    const [x, y] = toLocal(position)
    const n = flat.length
    if (n >= 2 && flat[n - 2] === x && flat[n - 1] === y) continue
    flat.push(x, y)
  }
  const n = flat.length
  if (n >= 4 && flat[0] === flat[n - 2] && flat[1] === flat[n - 1]) {
    flat.length = n - 2
  }
  return flat
}
